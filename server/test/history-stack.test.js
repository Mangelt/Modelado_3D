'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { calcularEstadoHistorial, siguienteAccionHistorial } = require('../history-stack');

function ev(secuencia, metadata = null) { return { secuencia, metadata }; }

test('construye pila de deshacer desde eventos normales', () => {
  const estado = calcularEstadoHistorial([ev(1), ev(2), ev(3)]);
  assert.equal(estado.cursor, 3);
  assert.deepEqual(estado.undoStack, [0, 1, 2]);
  assert.deepEqual(estado.redoStack, []);
});

test('deshacer repetido y rehacer conserva el orden lógico', () => {
  let estado = calcularEstadoHistorial([ev(1), ev(2), ev(3)]);
  const undo1 = siguienteAccionHistorial(estado, 'deshacer');
  assert.equal(undo1.secuenciaObjetivo, 2);
  estado = calcularEstadoHistorial([
    ev(1), ev(2), ev(3), ev(4, { accionHistorial: 'deshacer', secuenciaObjetivo: 2 })
  ]);
  assert.equal(estado.cursor, 2);
  assert.deepEqual(estado.undoStack, [0, 1]);
  assert.deepEqual(estado.redoStack, [3]);
  const undo2 = siguienteAccionHistorial(estado, 'deshacer');
  assert.equal(undo2.secuenciaObjetivo, 1);
  estado = calcularEstadoHistorial([
    ev(1), ev(2), ev(3), ev(4, { accionHistorial: 'deshacer', secuenciaObjetivo: 2 }),
    ev(5, { accionHistorial: 'deshacer', secuenciaObjetivo: 1 })
  ]);
  assert.equal(estado.cursor, 1);
  assert.deepEqual(estado.redoStack, [3, 2]);
  const redo1 = siguienteAccionHistorial(estado, 'rehacer');
  assert.equal(redo1.secuenciaObjetivo, 2);
});

test('un cambio nuevo después de deshacer invalida rehacer', () => {
  const eventos = [
    ev(1), ev(2), ev(3), ev(4, { accionHistorial: 'deshacer', secuenciaObjetivo: 2 }), ev(5)
  ];
  const estado = calcularEstadoHistorial(eventos);
  assert.equal(estado.cursor, 5);
  assert.deepEqual(estado.redoStack, []);
  assert.equal(siguienteAccionHistorial(estado, 'rehacer').ok, false);
});

test('rechaza deshacer o rehacer cuando la pila está vacía', () => {
  const estado = calcularEstadoHistorial([]);
  assert.equal(siguienteAccionHistorial(estado, 'deshacer').ok, false);
  assert.equal(siguienteAccionHistorial(estado, 'rehacer').ok, false);
});

test('limita el tamaño de las pilas conservando las acciones recientes', () => {
  const estado = calcularEstadoHistorial(Array.from({ length: 600 }, (_, i) => ev(i + 1)));
  assert.equal(estado.undoStack.length, 500);
  assert.equal(estado.undoStack.at(-1), 599);
});
