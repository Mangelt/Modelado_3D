'use strict';

const {
  adquirirBloqueo,
  renovarBloqueo,
  liberarBloqueo,
  liberarBloqueosCliente,
  liberarBloqueosObjeto,
  expirarBloqueos,
  buscarConflicto
} = require('./lock-manager');

/**
 * Almacén de bloqueos compartido entre procesos mediante compare-and-swap en
 * un único documento MongoDB por sala. No requiere transacciones ni replica
 * set; cada escritura del documento es atómica en MongoDB.
 */
function crearAlmacenBloqueosDistribuidos(Modelo, opciones = {}) {
  const maxIntentos = Number.isInteger(opciones.maxIntentos) ? opciones.maxIntentos : 80;
  const reloj = typeof opciones.reloj === 'function' ? opciones.reloj : () => Date.now();

  async function asegurarSala(nombreSala) {
    try {
      await Modelo.updateOne(
        { nombreSala },
        { $setOnInsert: { revision: 0, bloqueos: [] } },
        { upsert: true }
      );
    } catch (err) {
      // Dos procesos pueden intentar crear el documento simultáneamente.
      if (err.code !== 11000) throw err;
    }
  }

  async function leerDocumento(nombreSala) {
    await asegurarSala(nombreSala);
    const doc = await Modelo.findOne({ nombreSala }).lean();
    if (!doc) throw new Error(`No se pudo inicializar el registro de bloqueos de ${nombreSala}.`);
    return doc;
  }

  function mapaDesdeDocumento(doc) {
    const mapa = new Map();
    for (const item of Array.isArray(doc.bloqueos) ? doc.bloqueos : []) {
      if (item && typeof item.llave === 'string' && item.clienteId) {
        const { llave, ...lock } = item;
        mapa.set(llave, lock);
      }
    }
    return mapa;
  }

  function serializarMapa(mapa) {
    return [...mapa.entries()].map(([llave, lock]) => ({ llave, ...lock }));
  }

  async function mutar(nombreSala, callback) {
    await asegurarSala(nombreSala);
    for (let intento = 0; intento < maxIntentos; intento += 1) {
      const doc = await Modelo.findOne({ nombreSala }).lean();
      if (!doc) continue;
      const mapa = mapaDesdeDocumento(doc);
      const salida = callback(mapa, reloj());
      if (!salida.cambio) {
        return { ...salida, bloqueos: mapa, revision: doc.revision || 0 };
      }
      const revision = Number.isSafeInteger(doc.revision) ? doc.revision : 0;
      const resultado = await Modelo.updateOne(
        { nombreSala, revision },
        { $set: { bloqueos: serializarMapa(mapa) }, $inc: { revision: 1 } }
      );
      if (resultado.matchedCount === 1) {
        return { ...salida, bloqueos: mapa, revision: revision + 1 };
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(20, 1 + intento)));
    }
    throw new Error(`No se pudo actualizar el estado distribuido de bloqueos en ${nombreSala} por contención concurrente.`);
  }

  return {
    async obtener(nombreSala) {
      return mapaDesdeDocumento(await leerDocumento(nombreSala));
    },

    async adquirir(nombreSala, recurso, propietario, ttlMs) {
      return mutar(nombreSala, (mapa, ahora) => {
        const expirados = expirarBloqueos(mapa, ahora);
        const resultado = adquirirBloqueo(mapa, recurso, propietario, ahora, ttlMs);
        return {
          cambio: expirados.length > 0 || resultado.ok,
          valor: resultado,
          expirados
        };
      });
    },

    async renovar(nombreSala, llave, clienteId, ttlMs) {
      return mutar(nombreSala, (mapa, ahora) => {
        const lock = mapa.get(llave);
        if (!lock || lock.vence <= ahora || lock.clienteId !== clienteId) {
          const expirados = expirarBloqueos(mapa, ahora);
          return { cambio: expirados.length > 0, valor: false, expirados };
        }
        const renovado = renovarBloqueo(mapa, llave, clienteId, ahora, ttlMs);
        return { cambio: renovado, valor: renovado, expirados: [] };
      });
    },

    async liberar(nombreSala, llave, clienteId) {
      return mutar(nombreSala, mapa => {
        const resultado = liberarBloqueo(mapa, llave, clienteId);
        return { cambio: Boolean(resultado), valor: resultado, expirados: [] };
      });
    },

    async liberarCliente(nombreSala, clienteId) {
      return mutar(nombreSala, mapa => {
        const liberados = liberarBloqueosCliente(mapa, clienteId);
        return { cambio: liberados.length > 0, valor: liberados, expirados: [] };
      });
    },

    async liberarClienteExcepto(nombreSala, clienteId, clavesConservadas = []) {
      const conservar = new Set(clavesConservadas);
      return mutar(nombreSala, mapa => {
        const liberados = [];
        for (const [llave, lock] of mapa.entries()) {
          if (lock.clienteId === clienteId && !conservar.has(llave)) {
            mapa.delete(llave);
            liberados.push({ llave, lock });
          }
        }
        return { cambio: liberados.length > 0, valor: liberados, expirados: [] };
      });
    },

    async liberarObjeto(nombreSala, idComponente) {
      return mutar(nombreSala, mapa => {
        const liberados = liberarBloqueosObjeto(mapa, idComponente);
        return { cambio: liberados.length > 0, valor: liberados, expirados: [] };
      });
    },

    async eliminarObjetoSiLibre(nombreSala, idComponente, propietario, ttlMs) {
      return mutar(nombreSala, (mapa, ahora) => {
        const expirados = expirarBloqueos(mapa, ahora);
        const conflicto = buscarConflicto(mapa, { tipoRecurso: 'objeto', idComponente }, propietario.clienteId);
        if (conflicto) return { cambio: expirados.length > 0, valor: { ok: false, conflicto }, expirados };
        const liberados = liberarBloqueosObjeto(mapa, idComponente);
        const reserva = adquirirBloqueo(mapa, { tipoRecurso: 'objeto', idComponente }, propietario, ahora, ttlMs);
        return { cambio: true, valor: { ok: reserva.ok, liberados, llave: reserva.llave }, expirados };
      });
    },

    async hayBloqueosDeOtros(nombreSala, clienteId) {
      const mapa = await this.obtener(nombreSala);
      return [...mapa.values()].find(lock => lock.clienteId !== clienteId) || null;
    },

    async expirar(nombreSala) {
      return mutar(nombreSala, (mapa, ahora) => {
        const expirados = expirarBloqueos(mapa, ahora);
        return { cambio: expirados.length > 0, valor: expirados, expirados };
      });
    }
  };
}

module.exports = { crearAlmacenBloqueosDistribuidos };
