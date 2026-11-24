'use strict';

function clonar(valor) {
  return valor == null ? valor : JSON.parse(JSON.stringify(valor));
}


/**
 * Calcula la siguiente secuencia desde fuentes confirmadas. En MongoDB
 * standalone no hay transacción entre contador y evento: tras una caída, el
 * contador de SalaProyecto puede quedar adelantado. El último evento insertado
 * y el checkpoint son las fuentes de verdad para continuar sin dejar huecos.
 */
function siguienteSecuenciaConfirmada(secuenciaCheckpoint, secuenciaUltimoEvento) {
  const checkpoint = Number.isSafeInteger(secuenciaCheckpoint) && secuenciaCheckpoint >= 0
    ? secuenciaCheckpoint : 0;
  const ultimoEvento = Number.isSafeInteger(secuenciaUltimoEvento) && secuenciaUltimoEvento >= 0
    ? secuenciaUltimoEvento : 0;
  return Math.max(checkpoint, ultimoEvento) + 1;
}

/** Aplica un evento de dominio sobre un snapshot, sin modificar el original. */
function aplicarEvento(snapshotEntrada, evento) {
  const snapshot = clonar(snapshotEntrada || { timestamp: Date.now(), modelos: {} });
  if (!snapshot.modelos || typeof snapshot.modelos !== 'object' || Array.isArray(snapshot.modelos)) {
    snapshot.modelos = {};
  }
  const modelos = snapshot.modelos;
  const id = evento.idObjeto;
  const despues = evento.despues;

  switch (evento.tipo) {
    case 'CREAR_CUBO':
    case 'DUPLICAR_CUBO':
      if (id && despues) modelos[id] = clonar(despues);
      break;
    case 'ELIMINAR_CUBO':
      if (id) delete modelos[id];
      break;
    case 'TRANSFORMACION_DELTA':
      if (id && despues) modelos[id] = clonar(despues);
      break;
    case 'EDICION_GEOMETRICA': {
      const modelo = id && modelos[id];
      const offsets = despues?.vertexOffsets;
      if (modelo && offsets && typeof offsets === 'object' && !Array.isArray(offsets)) {
        modelo.vertexOffsets ||= {};
        for (const [indice, valor] of Object.entries(offsets)) {
          modelo.vertexOffsets[indice] = clonar(valor);
        }
      }
      break;
    }
    case 'IMPORTAR_MODELO':
    case 'DESHACER':
    case 'REHACER':
      if (despues && typeof despues === 'object' && !Array.isArray(despues)) {
        snapshot.modelos = clonar(despues);
      }
      break;
    default:
      // Los eventos de otros dominios no alteran el estado geométrico.
      break;
  }
  snapshot.timestamp = evento.timestamp ? new Date(evento.timestamp).getTime() : Date.now();
  return snapshot;
}

/** Reconstruye estado desde un checkpoint y aplica los eventos posteriores. */
function reconstruirSnapshot(snapshotBase, eventos, hastaSecuencia = Infinity) {
  let snapshot = clonar(snapshotBase || { timestamp: Date.now(), modelos: {} });
  let secuencia = Number(snapshotBase?.secuencia) || 0;
  const ordenados = [...(eventos || [])]
    .filter(evento => Number.isSafeInteger(evento.secuencia) && evento.secuencia > secuencia && evento.secuencia <= hastaSecuencia)
    .sort((a, b) => a.secuencia - b.secuencia);
  let aplicados = 0;
  for (const evento of ordenados) {
    snapshot = aplicarEvento(snapshot, evento);
    secuencia = evento.secuencia;
    aplicados += 1;
  }
  return { snapshot, secuencia, aplicados };
}

module.exports = { clonar, aplicarEvento, reconstruirSnapshot, siguienteSecuenciaConfirmada };
