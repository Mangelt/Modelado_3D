'use strict';

const MAX_HISTORY_DEPTH = 500;

function clonarEstado(estado) {
  return {
    cursor: Number.isSafeInteger(estado?.cursor) ? estado.cursor : 0,
    undoStack: Array.isArray(estado?.undoStack) ? estado.undoStack.filter(Number.isSafeInteger).slice(-MAX_HISTORY_DEPTH) : [],
    redoStack: Array.isArray(estado?.redoStack) ? estado.redoStack.filter(Number.isSafeInteger).slice(-MAX_HISTORY_DEPTH) : []
  };
}

/** Reconstruye el cursor global desde el Event Store; sobrevive a reinicios. */
function calcularEstadoHistorial(eventos = []) {
  const estado = { cursor: 0, undoStack: [], redoStack: [] };
  const ordenados = [...eventos]
    .filter(evento => Number.isSafeInteger(evento.secuencia) && evento.secuencia > 0)
    .sort((a, b) => a.secuencia - b.secuencia);

  for (const evento of ordenados) {
    const accion = evento.metadata?.accionHistorial;
    const objetivo = evento.metadata?.secuenciaObjetivo;
    if (accion === 'deshacer') {
      if (estado.undoStack.length) estado.undoStack.pop();
      estado.redoStack.push(estado.cursor);
      estado.cursor = Number.isSafeInteger(objetivo) ? objetivo : Math.max(0, evento.secuencia - 2);
    } else if (accion === 'rehacer') {
      if (estado.redoStack.length) estado.redoStack.pop();
      estado.undoStack.push(estado.cursor);
      estado.cursor = Number.isSafeInteger(objetivo) ? objetivo : Math.max(0, evento.secuencia - 1);
    } else {
      estado.undoStack.push(estado.cursor);
      estado.cursor = evento.secuencia;
      estado.redoStack = [];
    }
    if (estado.undoStack.length > MAX_HISTORY_DEPTH) estado.undoStack.splice(0, estado.undoStack.length - MAX_HISTORY_DEPTH);
    if (estado.redoStack.length > MAX_HISTORY_DEPTH) estado.redoStack.splice(0, estado.redoStack.length - MAX_HISTORY_DEPTH);
  }
  return estado;
}

function siguienteAccionHistorial(estadoEntrada, accion) {
  const estado = clonarEstado(estadoEntrada);
  if (accion === 'deshacer') {
    if (!estado.undoStack.length) return { ok: false, motivo: 'No hay cambios que deshacer.', estado };
    const secuenciaObjetivo = estado.undoStack.pop();
    estado.redoStack.push(estado.cursor);
    estado.cursor = secuenciaObjetivo;
    return { ok: true, secuenciaObjetivo, estado };
  }
  if (accion === 'rehacer') {
    if (!estado.redoStack.length) return { ok: false, motivo: 'No hay cambios que rehacer.', estado };
    const secuenciaObjetivo = estado.redoStack.pop();
    estado.undoStack.push(estado.cursor);
    estado.cursor = secuenciaObjetivo;
    return { ok: true, secuenciaObjetivo, estado };
  }
  return { ok: false, motivo: 'Acción de historial desconocida.', estado };
}

module.exports = { MAX_HISTORY_DEPTH, calcularEstadoHistorial, siguienteAccionHistorial };
