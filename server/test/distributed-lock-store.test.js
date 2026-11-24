'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { crearAlmacenBloqueosDistribuidos } = require('../distributed-lock-store');

function crearModeloFake() {
  const documentos = new Map();
  return {
    documentos,
    updateOne(filtro, update, opciones = {}) {
      return (async () => {
        await Promise.resolve();
        let doc = documentos.get(filtro.nombreSala);
        if (!doc && opciones.upsert) {
          doc = { nombreSala: filtro.nombreSala, revision: 0, bloqueos: [] };
          documentos.set(filtro.nombreSala, doc);
        }
        if (!doc) return { matchedCount: 0, modifiedCount: 0 };
        if (filtro.revision !== undefined && doc.revision !== filtro.revision) {
          return { matchedCount: 0, modifiedCount: 0 };
        }
        if (update.$setOnInsert && doc.revision === 0 && doc.bloqueos.length === 0) {
          doc.revision = update.$setOnInsert.revision ?? 0;
          doc.bloqueos = update.$setOnInsert.bloqueos ?? [];
        }
        if (update.$set) Object.assign(doc, structuredClone(update.$set));
        if (update.$inc) {
          for (const [key, value] of Object.entries(update.$inc)) doc[key] = (doc[key] || 0) + value;
        }
        return { matchedCount: 1, modifiedCount: 1 };
      })();
    },
    findOne(filtro) {
      return {
        lean: async () => {
          await Promise.resolve();
          const doc = documentos.get(filtro.nombreSala);
          return doc ? structuredClone(doc) : null;
        }
      };
    }
  };
}

const propietario = (clienteId, usuario = clienteId) => ({ clienteId, usuario });
const recurso = (idComponente, tipoRecurso = 'objeto', extra = {}) => ({ tipoRecurso, idComponente, ...extra });

test('dos instancias comparten exclusión mutua mediante CAS en MongoDB', async () => {
  const modelo = crearModeloFake();
  const nodoA = crearAlmacenBloqueosDistribuidos(modelo);
  const nodoB = crearAlmacenBloqueosDistribuidos(modelo);
  const resultados = await Promise.all([
    nodoA.adquirir('equipo-1', recurso('cuboA'), propietario('cliente-a'), 15000),
    nodoB.adquirir('equipo-1', recurso('cuboA'), propietario('cliente-b'), 15000)
  ]);
  assert.equal(resultados.filter(r => r.valor.ok).length, 1);
  assert.equal(resultados.filter(r => !r.valor.ok).length, 1);
  const locks = await nodoA.obtener('equipo-1');
  assert.equal(locks.size, 1);
});

test('dos instancias pueden bloquear objetos diferentes', async () => {
  const modelo = crearModeloFake();
  const nodoA = crearAlmacenBloqueosDistribuidos(modelo);
  const nodoB = crearAlmacenBloqueosDistribuidos(modelo);
  const [a, b] = await Promise.all([
    nodoA.adquirir('equipo-1', recurso('cuboA'), propietario('cliente-a'), 15000),
    nodoB.adquirir('equipo-1', recurso('cuboB'), propietario('cliente-b'), 15000)
  ]);
  assert.equal(a.valor.ok, true);
  assert.equal(b.valor.ok, true);
  assert.equal((await nodoA.obtener('equipo-1')).size, 2);
});

test('el bloqueo del objeto y el bloqueo de sus caras entran en conflicto entre nodos', async () => {
  const modelo = crearModeloFake();
  const nodoA = crearAlmacenBloqueosDistribuidos(modelo);
  const nodoB = crearAlmacenBloqueosDistribuidos(modelo);
  const a = await nodoA.adquirir('equipo-1', recurso('cuboA'), propietario('cliente-a'), 15000);
  const b = await nodoB.adquirir('equipo-1', recurso('cuboA', 'elemento', { tipoElemento: 'cara', indiceElemento: 0, verticesLogicos: [0, 1, 2] }), propietario('cliente-b'), 15000);
  assert.equal(a.valor.ok, true);
  assert.equal(b.valor.ok, false);
  assert.equal(b.valor.conflicto.lock.usuario, 'cliente-a');
});

test('un cliente no puede renovar ni liberar bloqueos de otra instancia', async () => {
  const modelo = crearModeloFake();
  const nodoA = crearAlmacenBloqueosDistribuidos(modelo);
  const nodoB = crearAlmacenBloqueosDistribuidos(modelo);
  const adquirido = await nodoA.adquirir('equipo-1', recurso('cuboA'), propietario('cliente-a'), 15000);
  const llave = adquirido.valor.llave;
  const renovar = await nodoB.renovar('equipo-1', llave, 'cliente-b', 15000);
  const liberar = await nodoB.liberar('equipo-1', llave, 'cliente-b');
  assert.equal(renovar.valor, false);
  assert.equal(liberar.valor, null);
  assert.equal((await nodoB.obtener('equipo-1')).size, 1);
});

test('la desconexión libera los bloqueos del cliente en todas las instancias', async () => {
  const modelo = crearModeloFake();
  const nodoA = crearAlmacenBloqueosDistribuidos(modelo);
  const nodoB = crearAlmacenBloqueosDistribuidos(modelo);
  await nodoA.adquirir('equipo-1', recurso('cuboA'), propietario('cliente-a'), 15000);
  await nodoA.adquirir('equipo-1', recurso('cuboB'), propietario('cliente-a'), 15000);
  const liberados = await nodoB.liberarCliente('equipo-1', 'cliente-a');
  assert.equal(liberados.valor.length, 2);
  assert.equal((await nodoA.obtener('equipo-1')).size, 0);
});

test('los bloqueos vencidos se eliminan y los vigentes permanecen', async () => {
  const modelo = crearModeloFake();
  let ahora = 1000;
  const nodoA = crearAlmacenBloqueosDistribuidos(modelo, { reloj: () => ahora });
  await nodoA.adquirir('equipo-1', recurso('cuboA'), propietario('cliente-a'), 100);
  await nodoA.adquirir('equipo-1', recurso('cuboB'), propietario('cliente-b'), 500);
  ahora = 1200;
  const expirados = await nodoA.expirar('equipo-1');
  assert.equal(expirados.valor.length, 1);
  assert.equal((await nodoA.obtener('equipo-1')).size, 1);
});

test('una importación puede liberar los bloqueos del usuario sin liberar la reserva de sala', async () => {
  const modelo = crearModeloFake();
  const nodoA = crearAlmacenBloqueosDistribuidos(modelo);
  await nodoA.adquirir('equipo-1', recurso('cuboA'), propietario('cliente-a'), 15000);
  await nodoA.adquirir('equipo-1', { tipoRecurso: 'sala' }, propietario('cliente-a'), 15000);
  const resultado = await nodoA.liberarClienteExcepto('equipo-1', 'cliente-a', ['sala:estado']);
  const locks = await nodoA.obtener('equipo-1');
  assert.equal(resultado.valor.length, 1);
  assert.equal(locks.has('obj:cuboA'), false);
  assert.equal(locks.has('sala:estado'), true);
});
