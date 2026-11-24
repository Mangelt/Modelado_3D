'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validarIndiceElemento,
  claveObjeto,
  claveSala,
  claveElemento,
  adquirirBloqueo,
  renovarBloqueo,
  liberarBloqueo,
  liberarBloqueosCliente,
  expirarBloqueos
} = require('../lock-manager');

const objeto = { tipoRecurso: 'objeto', idComponente: 'cubo_1' };
const cara0 = { tipoRecurso: 'elemento', idComponente: 'cubo_1', tipoElemento: 'cara', indiceElemento: 0 };
const objeto2 = { tipoRecurso: 'objeto', idComponente: 'cubo_2' };
const vertice4 = { tipoRecurso: 'elemento', idComponente: 'cubo_1', tipoElemento: 'vertice', indiceElemento: 4 };
const propietario = (clienteId, usuario = clienteId) => ({ clienteId, usuario });
const TTL = 15000;

test('dos usuarios pueden bloquear subelementos distintos del mismo objeto', () => {
  const locks = new Map();
  assert.equal(adquirirBloqueo(locks, cara0, propietario('A'), 1000, TTL).ok, true);
  assert.equal(adquirirBloqueo(locks, vertice4, propietario('B'), 1000, TTL).ok, true);
  assert.equal(locks.size, 2);
});

test('el mismo subelemento solo puede pertenecer a un usuario a la vez', () => {
  const locks = new Map();
  assert.equal(adquirirBloqueo(locks, cara0, propietario('A'), 1000, TTL).ok, true);
  const resultado = adquirirBloqueo(locks, cara0, propietario('B'), 1000, TTL);
  assert.equal(resultado.ok, false);
  assert.equal(resultado.conflicto.lock.usuario, 'A');
});

test('un bloqueo de cara impide que otro usuario bloquee el objeto completo', () => {
  const locks = new Map();
  adquirirBloqueo(locks, cara0, propietario('A'), 1000, TTL);
  assert.equal(adquirirBloqueo(locks, objeto, propietario('B'), 1000, TTL).ok, false);
});

test('un bloqueo del objeto impide que otro usuario bloquee un vértice', () => {
  const locks = new Map();
  adquirirBloqueo(locks, objeto, propietario('A'), 1000, TTL);
  assert.equal(adquirirBloqueo(locks, vertice4, propietario('B'), 1000, TTL).ok, false);
});

test('el propietario puede renovar y liberar su bloqueo, pero otro usuario no', () => {
  const locks = new Map();
  const key = claveElemento('cubo_1', 'cara', 0);
  adquirirBloqueo(locks, cara0, propietario('A'), 1000, TTL);
  assert.equal(renovarBloqueo(locks, key, 'B', 2000, TTL), false);
  assert.equal(renovarBloqueo(locks, key, 'A', 2000, TTL), true);
  assert.equal(locks.get(key).vence, 17000);
  assert.equal(liberarBloqueo(locks, key, 'B'), null);
  assert.notEqual(liberarBloqueo(locks, key, 'A'), null);
  assert.equal(locks.size, 0);
});

test('la desconexión libera todos los bloqueos del cliente', () => {
  const locks = new Map();
  adquirirBloqueo(locks, objeto, propietario('A'), 1000, TTL);
  adquirirBloqueo(locks, cara0, propietario('A'), 1000, TTL);
  adquirirBloqueo(locks, objeto2, propietario('B'), 1000, TTL);
  const released = liberarBloqueosCliente(locks, 'A');
  assert.equal(released.length, 2);
  assert.equal(locks.has(claveObjeto('cubo_1')), false);
  assert.equal(locks.size, 1);
  assert.equal(locks.has(claveObjeto('cubo_2')), true);
});

test('los bloqueos caducados se liberan y los vigentes se conservan', () => {
  const locks = new Map();
  adquirirBloqueo(locks, cara0, propietario('A'), 1000, TTL);
  adquirirBloqueo(locks, vertice4, propietario('B'), 10000, TTL);
  const expired = expirarBloqueos(locks, 16000);
  assert.equal(expired.length, 1);
  assert.equal(locks.size, 1);
});

test('los índices de caras y vértices respetan la geometría de cada primitiva', () => {
  assert.equal(validarIndiceElemento('cubo', 'cara', 5), true);
  assert.equal(validarIndiceElemento('cubo', 'cara', 6), false);
  assert.equal(validarIndiceElemento('cubo', 'vertice', 23), true);
  assert.equal(validarIndiceElemento('cubo', 'vertice', 24), false);
  assert.equal(validarIndiceElemento('esfera', 'cara', 719), true);
  assert.equal(validarIndiceElemento('esfera', 'cara', 720), false);
  assert.equal(validarIndiceElemento('cilindro', 'vertice', 101), true);
  assert.equal(validarIndiceElemento('cilindro', 'vertice', 102), false);
  assert.equal(validarIndiceElemento('cubo', 'hueso', 0), false);
});

test('una cara y un vértice que comparten un vértice lógico no pueden bloquearse a la vez', () => {
  const locks = new Map();
  const caraConVertices = { ...cara0, verticesLogicos: [0, 1, 2, 3], indicesGeometria: [0, 1, 2, 3] };
  const verticeCompartido = { ...vertice4, verticesLogicos: [2], indicesGeometria: [2, 8, 14] };
  assert.equal(adquirirBloqueo(locks, caraConVertices, propietario('A'), 1000, TTL).ok, true);
  const resultado = adquirirBloqueo(locks, verticeCompartido, propietario('B'), 1000, TTL);
  assert.equal(resultado.ok, false);
  assert.equal(resultado.conflicto.lock.usuario, 'A');
});

test('dos caras sin vértices lógicos compartidos pueden bloquearse simultáneamente', () => {
  const locks = new Map();
  const caraA = { ...cara0, verticesLogicos: [0, 1, 2, 3], indicesGeometria: [0, 1, 2, 3] };
  const caraB = { ...cara0, indiceElemento: 1, verticesLogicos: [4, 5, 6, 7], indicesGeometria: [4, 5, 6, 7] };
  assert.equal(adquirirBloqueo(locks, caraA, propietario('A'), 1000, TTL).ok, true);
  assert.equal(adquirirBloqueo(locks, caraB, propietario('B'), 1000, TTL).ok, true);
  assert.equal(locks.size, 2);
});


test('un bloqueo de sala impide nuevas ediciones de otros usuarios', () => {
  const locks = new Map();
  assert.equal(adquirirBloqueo(locks, { tipoRecurso: 'sala' }, propietario('A'), 1000, TTL).ok, true);
  assert.equal(locks.has(claveSala()), true);
  assert.equal(adquirirBloqueo(locks, objeto, propietario('B'), 1000, TTL).ok, false);
});

test('el bloqueo de sala solo se concede cuando no hay bloqueos ajenos', () => {
  const locks = new Map();
  adquirirBloqueo(locks, objeto, propietario('A'), 1000, TTL);
  assert.equal(adquirirBloqueo(locks, { tipoRecurso: 'sala' }, propietario('B'), 1000, TTL).ok, false);
});
