'use strict';

const { validarIndiceElemento } = require('./lock-manager');

// Cantidad máxima de posiciones BufferGeometry producidas por las primitivas
// actuales del editor (Three.js r128).
const LIMITES_VERTICES = Object.freeze({ cubo: 24, esfera: 425, cilindro: 102 });
const MAX_LOGICAL_VERTICES_PER_EDIT = 32;
const MAX_GEOMETRY_INDICES_PER_EDIT = 128;
const MAX_OFFSET = 2;

function listaEnteraUnica(lista, limite, minimo = 1, maximo = 128) {
  return Array.isArray(lista) && lista.length >= minimo && lista.length <= maximo &&
    lista.every(n => Number.isInteger(n) && n >= 0 && n < limite) &&
    new Set(lista).size === lista.length;
}

function validarBloqueoGeometrico(modelo, data) {
  if (!modelo || !data || !validarIndiceElemento(modelo.tipoObjeto || 'cubo', data.tipoElemento, data.indiceElemento)) return false;
  const limite = LIMITES_VERTICES[modelo.tipoObjeto || 'cubo'];
  const vertices = data.verticesLogicos;
  const indices = data.indicesGeometria;
  if (!Number.isInteger(limite)) return false;
  if (!listaEnteraUnica(vertices, limite, data.tipoElemento === 'vertice' ? 1 : 2, MAX_LOGICAL_VERTICES_PER_EDIT)) return false;
  if (!listaEnteraUnica(indices, limite, 1, MAX_GEOMETRY_INDICES_PER_EDIT)) return false;
  if (!vertices.every(indice => indices.includes(indice))) return false;
  if (data.tipoElemento === 'vertice' && vertices.length !== 1) return false;
  return true;
}

function validarDelta(delta) {
  return Boolean(delta && typeof delta === 'object' &&
    ['x', 'y', 'z'].every(k => typeof delta[k] === 'number' && Number.isFinite(delta[k]) && Math.abs(delta[k]) <= MAX_OFFSET));
}

function mismaLista(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const ordenadaA = [...a].sort((x, y) => x - y);
  const ordenadaB = [...b].sort((x, y) => x - y);
  return ordenadaA.every((valor, i) => valor === ordenadaB[i]);
}

function aplicarOffsetsVertices(modelo, verticesLogicos, delta) {
  if (!modelo.vertexOffsets || typeof modelo.vertexOffsets !== 'object' || Array.isArray(modelo.vertexOffsets)) {
    modelo.vertexOffsets = {};
  }
  const antes = {};
  const despues = {};
  for (const indice of verticesLogicos) {
    const clave = String(indice);
    antes[clave] = modelo.vertexOffsets[clave] || { x: 0, y: 0, z: 0 };
    despues[clave] = { x: delta.x, y: delta.y, z: delta.z };
  }
  Object.assign(modelo.vertexOffsets, despues);
  return { antes, despues };
}

module.exports = {
  LIMITES_VERTICES,
  validarBloqueoGeometrico,
  validarDelta,
  mismaLista,
  aplicarOffsetsVertices
};
