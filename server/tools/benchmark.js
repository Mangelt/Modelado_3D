'use strict';

const WebSocket = require('ws');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const API_BASE = process.env.API_BASE || 'http://127.0.0.1:8080';
const WS_BASE = process.env.WS_BASE || 'ws://127.0.0.1:8080';
const clientsArg = process.argv.find(arg => arg.startsWith('--clients='));
const CLIENTS = Math.min(100, Math.max(2, Number(clientsArg?.split('=')[1]) || 50));
const thresholdArg = process.argv.find(arg => arg.startsWith('--threshold-ms='));
const LATENCY_THRESHOLD_MS = Math.max(1, Number(thresholdArg?.split('=')[1]) || 50);
const reportArg = process.argv.find(arg => arg.startsWith('--report='));
const TIMEOUT_MS = 15000;

function percentil(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

async function autenticarUsuarioTemporal() {
  const username = `carga${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`.slice(0, 24);
  const password = `T-${crypto.randomBytes(18).toString('hex')}`;
  const response = await fetch(`${API_BASE}/api/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.token) throw new Error(`No se pudo crear la cuenta temporal de carga (${response.status}): ${body.error || 'respuesta inesperada'}`);
  return { username, token: body.token };
}

function esperarMensaje(ws, predicate, etiqueta, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const limpiar = () => {
      clearTimeout(timer);
      ws.off('message', listener);
      ws.off('error', onError);
      ws.off('close', onClose);
    };
    const onError = err => { limpiar(); reject(new Error(`${etiqueta}: ${err.message}`)); };
    const onClose = () => { limpiar(); reject(new Error(`${etiqueta}: el WebSocket se cerró.`)); };
    const timer = setTimeout(() => { limpiar(); reject(new Error(`${etiqueta}: tiempo de espera agotado.`)); }, timeoutMs);
    const listener = raw => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!predicate(msg)) return;
      limpiar(); resolve(msg);
    };
    ws.on('message', listener);
    ws.once('error', onError);
    ws.once('close', onClose);
  });
}

function abrirCliente(url, indice) {
  const ws = new WebSocket(url);
  ws.on('error', () => {});
  return esperarMensaje(ws, msg => msg.tipo === 'INICIALIZAR_ESTADO', `cliente ${indice + 1} inicialización`)
    .then(inicial => ({ ws, inicial }))
    .catch(err => { ws.terminate(); throw err; });
}

function enviar(ws, payload) {
  if (ws.readyState !== WebSocket.OPEN) throw new Error('Un cliente se desconectó durante la prueba.');
  ws.send(JSON.stringify(payload));
}

function medirPing(ws, indice) {
  const nonce = crypto.randomUUID();
  const inicio = performance.now();
  const espera = esperarMensaje(ws, msg => msg.tipo === 'PONG' && msg.nonce === nonce, `PONG del cliente ${indice + 1}`);
  enviar(ws, { tipo: 'PING', nonce, clientTime: Date.now() });
  return espera.then(() => performance.now() - inicio);
}

async function cerrarSesion(token) {
  await fetch(`${API_BASE}/api/logout`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }
  }).catch(() => {});
}

function resumir(titulo, valores) {
  const ordenados = valores.slice().sort((a, b) => a - b);
  const promedio = valores.reduce((a, b) => a + b, 0) / Math.max(1, valores.length);
  const resultado = {
    muestras: valores.length,
    promedioMs: Number(promedio.toFixed(2)),
    medianaMs: Number(percentil(ordenados, 0.50).toFixed(2)),
    p95Ms: Number(percentil(ordenados, 0.95).toFixed(2)),
    maximoMs: Number((ordenados.at(-1) || 0).toFixed(2))
  };
  console.log(`\n${titulo}`);
  console.log(`  Muestras correctas: ${resultado.muestras}`);
  console.log(`  Promedio: ${resultado.promedioMs.toFixed(2)} ms`);
  console.log(`  Mediana: ${resultado.medianaMs.toFixed(2)} ms`);
  console.log(`  P95: ${resultado.p95Ms.toFixed(2)} ms`);
  console.log(`  Máximo: ${resultado.maximoMs.toFixed(2)} ms`);
  return resultado;
}

(async () => {
  let usuarioTemporal = null;
  let clientes = [];
  let idTemporal = null;
  try {
    console.log(`Prueba de rendimiento: ${CLIENTS} conexiones WebSocket simultáneas.`);
    console.log(`API: ${API_BASE}`);
    // La protección anti-fuerza-bruta limita los registros por IP. Una única
    // cuenta temporal evita desactivar esa protección durante el benchmark.
    // Cada socket recibe un clienteId distinto del servidor y cuenta como una
    // conexión concurrente independiente, aunque comparte la identidad de prueba.
    usuarioTemporal = await autenticarUsuarioTemporal();
    const sala = `carga_${Date.now().toString(36)}`;
    const url = `${WS_BASE}?sala=${encodeURIComponent(sala)}&token=${encodeURIComponent(usuarioTemporal.token)}`;
    const aperturas = await Promise.all(Array.from({ length: CLIENTS }, (_, i) => abrirCliente(url, i)));
    clientes = aperturas;
    const sockets = clientes.map(c => c.ws);
    console.log(`Conexiones abiertas simultáneamente: ${sockets.length}/${CLIENTS}`);
    console.log(`Identidad temporal compartida: ${usuarioTemporal.username}; clientes de socket distintos: ${sockets.length}`);

    const pingResults = await Promise.all(sockets.map((ws, i) => medirPing(ws, i)));
    const pingStats = resumir('PING/PONG del gateway (ida y vuelta)', pingResults);

    // Crea un modelo temporal y mide la difusión de una mutación real a cada cliente observador.
    idTemporal = `perf_${crypto.randomBytes(5).toString('hex')}`;
    const datosIniciales = {
      tipoObjeto: 'cubo', x: 0, y: 0.5, z: 0, rx: 0, ry: 0, rz: 0,
      sx: 1, sy: 1, sz: 1, color: '#38bdf8'
    };
    const confirmacionesCreacion = sockets.map((ws, i) => esperarMensaje(
      ws, msg => msg.tipo === 'NUEVO_CUBO_CREADO' && msg.id === idTemporal, `creación observada por cliente ${i + 1}`
    ));
    enviar(sockets[0], { tipo: 'CREAR_CUBO', id: idTemporal, datos: datosIniciales });
    await Promise.all(confirmacionesCreacion);

    const bloqueo = esperarMensaje(sockets[0], msg => msg.tipo === 'BLOQUEO_CONCEDIDO' && msg.idComponente === idTemporal, 'bloqueo temporal para medir edición');
    enviar(sockets[0], { tipo: 'SOLICITAR_BLOQUEO', idComponente: idTemporal });
    await bloqueo;

    const observadores = sockets.slice(1);
    const inicio = performance.now();
    const propagacion = observadores.map((ws, i) => esperarMensaje(
      ws,
      msg => msg.tipo === 'APLICAR_DELTA' && msg.idComponente === idTemporal && msg.delta?.x === 0.35,
      `propagación de edición al cliente ${i + 2}`
    ).then(() => performance.now() - inicio));
    enviar(sockets[0], {
      tipo: 'TRANSFORMACION_DELTA', idComponente: idTemporal,
      delta: { ...datosIniciales, x: 0.35 }
    });
    const editResults = await Promise.all(propagacion);
    const editStats = resumir('Propagación de una transformación real a los clientes observadores', editResults);
    const cumpleUmbral = editStats.p95Ms < LATENCY_THRESHOLD_MS;
    console.log(`\nObjetivo RNF-01: P95 < ${LATENCY_THRESHOLD_MS} ms: ${cumpleUmbral ? 'CUMPLIDO EN ESTA MUESTRA' : 'NO CUMPLIDO EN ESTA MUESTRA'}`);
    if (!cumpleUmbral) process.exitCode = 2;

    const eliminado = esperarMensaje(sockets[0], msg => msg.tipo === 'CUBO_ELIMINADO' && msg.id === idTemporal, 'limpieza del objeto temporal');
    enviar(sockets[0], { tipo: 'ELIMINAR_CUBO', id: idTemporal });
    await eliminado;
    idTemporal = null;

    const informe = {
      fecha: new Date().toISOString(),
      clientesSolicitados: CLIENTS,
      clientesConectados: clientes.length,
      umbralP95Ms: LATENCY_THRESHOLD_MS,
      objetivoRNF01CumplidoEnMuestra: editStats.p95Ms < LATENCY_THRESHOLD_MS,
      pingPong: pingStats,
      propagacionTransformacion: editStats,
      interpretacion: 'La propagación mide el tiempo desde el envío en el cliente emisor hasta la recepción del evento WebSocket en los clientes observadores. No mide por sí sola el renderizado/pintura de píxeles.'
    };
    if (reportArg) {
      const destino = path.resolve(process.cwd(), reportArg.split('=')[1]);
      fs.mkdirSync(path.dirname(destino), { recursive: true });
      fs.writeFileSync(destino, `${JSON.stringify(informe, null, 2)}\n`, { mode: 0o600 });
      console.log(`Informe JSON guardado en: ${destino}`);
    }
    console.log('\nRESULTADO: conexiones, PING/PONG y propagación de una transformación medidos correctamente.');
    console.log(informe.interpretacion);
  } catch (err) {
    console.error('\nLa prueba no terminó correctamente:', err.message);
    process.exitCode = 1;
  } finally {
    if (idTemporal && clientes.length && clientes[0].ws.readyState === WebSocket.OPEN) {
      try { enviar(clientes[0].ws, { tipo: 'ELIMINAR_CUBO', id: idTemporal }); } catch {}
    }
    for (const cliente of clientes) {
      if (cliente.ws.readyState === WebSocket.OPEN) cliente.ws.close(1000, 'load test complete');
      else if (cliente.ws.readyState !== WebSocket.CLOSED) cliente.ws.terminate();
    }
    if (usuarioTemporal) await cerrarSesion(usuarioTemporal.token);
  }
})();
