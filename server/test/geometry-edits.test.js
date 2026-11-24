'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validarBloqueoGeometrico,
  validarDelta,
  mismaLista,
  aplicarOffsetsVertices
} = require('../geometry-edits');

const cubo = { tipoObjeto: 'cubo' };

test('valida una cara con sus vértices lógicos e índices geométricos', () => {
  assert.equal(validarBloqueoGeometrico(cubo, {
    tipoElemento: 'cara', indiceElemento: 0,
    verticesLogicos: [0, 1, 2, 3], indicesGeometria: [0, 1, 2, 3, 8, 9]
  }), true);
});

test('valida un vértice con todas sus copias de BufferGeometry', () => {
  assert.equal(validarBloqueoGeometrico(cubo, {
    tipoElemento: 'vertice', indiceElemento: 0,
    verticesLogicos: [0], indicesGeometria: [0, 8, 16]
  }), true);
});

test('rechaza índices y listas geométricas inválidas', () => {
  assert.equal(validarBloqueoGeometrico(cubo, {
    tipoElemento: 'cara', indiceElemento: 6,
    verticesLogicos: [0, 1, 2], indicesGeometria: [0, 1, 2]
  }), false);
  assert.equal(validarBloqueoGeometrico(cubo, {
    tipoElemento: 'vertice', indiceElemento: 0,
    verticesLogicos: [0, 1], indicesGeometria: [0, 1]
  }), false);
  assert.equal(validarBloqueoGeometrico(cubo, {
    tipoElemento: 'cara', indiceElemento: 0,
    verticesLogicos: [0, 1, 2], indicesGeometria: [0, 1, 24]
  }), false);
});

test('valida desplazamientos finitos dentro del rango permitido', () => {
  assert.equal(validarDelta({ x: 0.5, y: -1, z: 2 }), true);
  assert.equal(validarDelta({ x: 2.1, y: 0, z: 0 }), false);
  assert.equal(validarDelta({ x: NaN, y: 0, z: 0 }), false);
});

test('compara índices geométricos sin depender del orden', () => {
  assert.equal(mismaLista([1, 2, 3], [3, 2, 1]), true);
  assert.equal(mismaLista([1, 2], [1, 3]), false);
});

test('actualiza desplazamientos absolutos y conserva los anteriores para el historial', () => {
  const modelo = { vertexOffsets: { '3': { x: 0, y: 0, z: 0 } } };
  const resultado = aplicarOffsetsVertices(modelo, [3, 7], { x: 0.5, y: -0.25, z: 1 });
  assert.deepEqual(resultado.antes['3'], { x: 0, y: 0, z: 0 });
  assert.deepEqual(resultado.despues['7'], { x: 0.5, y: -0.25, z: 1 });
  assert.deepEqual(modelo.vertexOffsets['3'], { x: 0.5, y: -0.25, z: 1 });
  assert.deepEqual(modelo.vertexOffsets['7'], { x: 0.5, y: -0.25, z: 1 });
});
