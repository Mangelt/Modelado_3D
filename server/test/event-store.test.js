'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { aplicarEvento, reconstruirSnapshot, siguienteSecuenciaConfirmada } = require('../event-store');

const base = {
  timestamp: 1000,
  modelos: {
    cubo: { tipoObjeto: 'cubo', x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1, color: '#38bdf8', vertexOffsets: {} }
  }
};

function evento(secuencia, tipo, idObjeto, antes, despues) {
  return { secuencia, tipo, idObjeto, antes, despues, timestamp: new Date(1000 + secuencia).toISOString() };
}

test('reproduce creación, transformación y eliminación en orden de secuencia', () => {
  const eventos = [
    evento(1, 'CREAR_CUBO', 'nuevo', null, { tipoObjeto: 'cubo', x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1, color: '#ffffff' }),
    evento(2, 'TRANSFORMACION_DELTA', 'cubo', base.modelos.cubo, { ...base.modelos.cubo, x: 2 }),
    evento(3, 'ELIMINAR_CUBO', 'nuevo', null, null)
  ];
  const resultado = reconstruirSnapshot({ ...base, secuencia: 0 }, eventos);
  assert.equal(resultado.secuencia, 3);
  assert.equal(resultado.aplicados, 3);
  assert.equal(resultado.snapshot.modelos.cubo.x, 2);
  assert.equal(resultado.snapshot.modelos.nuevo, undefined);
});

test('reproduce offsets geométricos sobre el snapshot', () => {
  const ev = evento(1, 'EDICION_GEOMETRICA', 'cubo', null, {
    tipoElemento: 'vertice', indiceElemento: 2,
    vertexOffsets: { '2': { x: 0.5, y: -0.25, z: 0.75 } }
  });
  const resultado = aplicarEvento({ ...base, modelos: structuredClone(base.modelos) }, ev);
  assert.deepEqual(resultado.modelos.cubo.vertexOffsets['2'], { x: 0.5, y: -0.25, z: 0.75 });
});

test('reproduce importación completa y permite limitar la secuencia', () => {
  const importado = { esfera: { tipoObjeto: 'esfera', x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1, color: '#00ff00' } };
  const eventos = [
    evento(1, 'IMPORTAR_MODELO', null, base.modelos, importado),
    evento(2, 'TRANSFORMACION_DELTA', 'esfera', importado.esfera, { ...importado.esfera, x: 1 })
  ];
  const resultado = reconstruirSnapshot({ ...base, secuencia: 0 }, eventos, 1);
  assert.equal(resultado.secuencia, 1);
  assert.equal(resultado.snapshot.modelos.esfera.x, 0);
  assert.equal(resultado.snapshot.modelos.cubo, undefined);
});

test('no aplica eventos anteriores al checkpoint ni posteriores al corte', () => {
  const checkpoint = { ...base, secuencia: 4 };
  const eventos = [
    evento(2, 'TRANSFORMACION_DELTA', 'cubo', null, { ...base.modelos.cubo, x: 9 }),
    evento(5, 'TRANSFORMACION_DELTA', 'cubo', null, { ...base.modelos.cubo, x: 5 }),
    evento(6, 'TRANSFORMACION_DELTA', 'cubo', null, { ...base.modelos.cubo, x: 6 })
  ];
  const resultado = reconstruirSnapshot(checkpoint, eventos, 5);
  assert.equal(resultado.secuencia, 5);
  assert.equal(resultado.snapshot.modelos.cubo.x, 5);
  assert.equal(resultado.aplicados, 1);
});

test('deshacer y rehacer reconstruyen snapshots como eventos nuevos', () => {
  const estado0 = { timestamp: 1000, modelos: structuredClone(base.modelos) };
  const estado1 = { cubo: { ...base.modelos.cubo, x: 1 } };
  const estado2 = { cubo: { ...base.modelos.cubo, x: 2 } };
  const eventos = [
    evento(1, 'IMPORTAR_MODELO', null, estado0.modelos, estado1),
    evento(2, 'IMPORTAR_MODELO', null, estado1, estado2),
    { ...evento(3, 'DESHACER', null, estado2, estado1), metadata: { accionHistorial: 'deshacer', secuenciaObjetivo: 1 } },
    { ...evento(4, 'REHACER', null, estado1, estado2), metadata: { accionHistorial: 'rehacer', secuenciaObjetivo: 2 } }
  ];
  const undo = reconstruirSnapshot(estado0, eventos, 3);
  assert.equal(undo.snapshot.modelos.cubo.x, 1);
  const redo = reconstruirSnapshot(estado0, eventos, 4);
  assert.equal(redo.snapshot.modelos.cubo.x, 2);
});


test('la siguiente secuencia ignora contadores huérfanos y usa el último evento confirmado', () => {
  assert.equal(siguienteSecuenciaConfirmada(4, 7), 8);
  assert.equal(siguienteSecuenciaConfirmada(4, 0), 5);
  assert.equal(siguienteSecuenciaConfirmada(0, 0), 1);
});

test('la siguiente secuencia no acepta números negativos o inválidos', () => {
  assert.equal(siguienteSecuenciaConfirmada(-1, 3), 4);
  assert.equal(siguienteSecuenciaConfirmada(2.5, 4), 5);
  assert.equal(siguienteSecuenciaConfirmada(NaN, NaN), 1);
});
