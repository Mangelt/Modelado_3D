'use strict';

const LIMITES_ELEMENTOS = {
  cubo: { cara: 6, vertice: 24 },
  esfera: { cara: 720, vertice: 425 },
  cilindro: { cara: 96, vertice: 102 }
};

function validarIndiceElemento(tipoObjeto, tipoElemento, indiceElemento) {
  if (!['cara', 'vertice'].includes(tipoElemento) || !Number.isInteger(indiceElemento) || indiceElemento < 0) return false;
  const limite = LIMITES_ELEMENTOS[tipoObjeto || 'cubo']?.[tipoElemento];
  return Number.isInteger(limite) && indiceElemento < limite;
}

function claveObjeto(idComponente) {
  return `obj:${idComponente}`;
}

function claveSala() {
  return 'sala:estado';
}

function claveElemento(idComponente, tipoElemento, indiceElemento) {
  return `el:${idComponente}:${tipoElemento}:${indiceElemento}`;
}

function esClaveElemento(clave) {
  return typeof clave === 'string' && clave.startsWith('el:');
}

function analizarClave(clave) {
  if (typeof clave !== 'string') return null;
  if (clave === 'sala:estado') return { tipoRecurso: 'sala' };
  if (clave.startsWith('obj:')) {
    return { tipoRecurso: 'objeto', idComponente: clave.slice(4) };
  }
  if (clave.startsWith('el:')) {
    const partes = clave.split(':');
    if (partes.length !== 4) return null;
    return {
      tipoRecurso: 'elemento',
      idComponente: partes[1],
      tipoElemento: partes[2],
      indiceElemento: Number(partes[3])
    };
  }
  return null;
}

function buscarConflicto(bloqueos, recurso, clienteId) {
  const candidatos = [];
  const llaveObjeto = claveObjeto(recurso.idComponente);
  const bloqueoSala = bloqueos.get(claveSala());
  if (bloqueoSala && bloqueoSala.clienteId !== clienteId) {
    return { llave: claveSala(), lock: bloqueoSala };
  }

  if (recurso.tipoRecurso === 'sala') {
    for (const [llave, lock] of bloqueos.entries()) {
      if (lock.clienteId !== clienteId) return { llave, lock };
    }
    return null;
  }

  if (recurso.tipoRecurso === 'objeto') {
    candidatos.push(llaveObjeto);
    const prefijo = `el:${recurso.idComponente}:`;
    for (const llave of bloqueos.keys()) {
      if (llave.startsWith(prefijo)) candidatos.push(llave);
    }
  } else {
    candidatos.push(llaveObjeto);
    candidatos.push(claveElemento(
      recurso.idComponente,
      recurso.tipoElemento,
      recurso.indiceElemento
    ));

    // Una cara comparte vértices con caras vecinas. Los bloqueos de dos
    // subelementos distintos también entran en conflicto si editan algún
    // mismo vértice lógico de la geometría.
    const verticesSolicitados = new Set(Array.isArray(recurso.verticesLogicos) ? recurso.verticesLogicos : []);
    if (verticesSolicitados.size) {
      const prefijo = `el:${recurso.idComponente}:`;
      for (const [otraLlave, otroLock] of bloqueos.entries()) {
        if (!otraLlave.startsWith(prefijo) || otroLock.clienteId === clienteId) continue;
        const verticesOcupados = Array.isArray(otroLock.verticesLogicos) ? otroLock.verticesLogicos : [];
        if (verticesOcupados.some(indice => verticesSolicitados.has(indice))) {
          candidatos.push(otraLlave);
        }
      }
    }
  }

  for (const llave of candidatos) {
    const lock = bloqueos.get(llave);
    if (lock && lock.clienteId !== clienteId) return { llave, lock };
  }
  return null;
}

function adquirirBloqueo(bloqueos, recurso, propietario, ahora, ttlMs) {
  const llave = recurso.tipoRecurso === 'sala'
    ? claveSala()
    : (recurso.tipoRecurso === 'objeto'
      ? claveObjeto(recurso.idComponente)
      : claveElemento(recurso.idComponente, recurso.tipoElemento, recurso.indiceElemento));
  const conflicto = buscarConflicto(bloqueos, recurso, propietario.clienteId);
  if (conflicto) return { ok: false, conflicto };

  const lock = {
    ...recurso,
    clienteId: propietario.clienteId,
    usuario: propietario.usuario,
    vence: ahora + ttlMs
  };
  bloqueos.set(llave, lock);
  return { ok: true, llave, lock };
}

function renovarBloqueo(bloqueos, llave, clienteId, ahora, ttlMs) {
  const lock = bloqueos.get(llave);
  if (!lock || lock.clienteId !== clienteId) return false;
  lock.vence = ahora + ttlMs;
  return true;
}

function liberarBloqueo(bloqueos, llave, clienteId) {
  const lock = bloqueos.get(llave);
  if (!lock || (clienteId && lock.clienteId !== clienteId)) return null;
  bloqueos.delete(llave);
  return { llave, lock };
}

function liberarBloqueosCliente(bloqueos, clienteId) {
  const liberados = [];
  for (const [llave, lock] of bloqueos.entries()) {
    if (lock.clienteId === clienteId) {
      bloqueos.delete(llave);
      liberados.push({ llave, lock });
    }
  }
  return liberados;
}

function liberarBloqueosObjeto(bloqueos, idComponente) {
  const liberados = [];
  const prefijoElemento = `el:${idComponente}:`;
  for (const [llave, lock] of bloqueos.entries()) {
    if (llave === claveObjeto(idComponente) || llave.startsWith(prefijoElemento)) {
      bloqueos.delete(llave);
      liberados.push({ llave, lock });
    }
  }
  return liberados;
}

function expirarBloqueos(bloqueos, ahora) {
  const expirados = [];
  for (const [llave, lock] of bloqueos.entries()) {
    if (lock.vence <= ahora) {
      bloqueos.delete(llave);
      expirados.push({ llave, lock });
    }
  }
  return expirados;
}

module.exports = {
  LIMITES_ELEMENTOS,
  validarIndiceElemento,
  claveObjeto,
  claveSala,
  claveElemento,
  esClaveElemento,
  analizarClave,
  buscarConflicto,
  adquirirBloqueo,
  renovarBloqueo,
  liberarBloqueo,
  liberarBloqueosCliente,
  liberarBloqueosObjeto,
  expirarBloqueos
};
