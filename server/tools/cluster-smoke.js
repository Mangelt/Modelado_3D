'use strict';

const WebSocket = require('ws');
const crypto = require('crypto');

const API_BASE = process.env.API_BASE || 'http://127.0.0.1:8080';
const WS_BASE = process.env.WS_BASE || 'ws://127.0.0.1:8080';
const TIMEOUT_MS = 15000;

async function registrarUsuario(prefijo) {
  const username = `${prefijo}${Date.now()}${crypto.randomBytes(2).toString('hex')}`.slice(0, 24);
  const password = `T-${crypto.randomBytes(20).toString('hex')}`;
  const response = await fetch(`${API_BASE}/api/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.token) throw new Error(`No se pudo registrar ${username}: ${body.error || response.status}`);
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
    const onError = err => { limpiar(); reject(new Error(`WebSocket falló esperando ${etiqueta}: ${err.message}`)); };
    const onClose = (code, reason) => { limpiar(); reject(new Error(`WebSocket se cerró esperando ${etiqueta} (${code} ${reason.toString()}).`)); };
    const timer = setTimeout(() => { limpiar(); reject(new Error(`Tiempo agotado esperando ${etiqueta}.`)); }, timeoutMs);
    const listener = raw => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (!predicate(message)) return;
      limpiar(); resolve(message);
    };
    ws.on('message', listener);
    ws.once('error', onError);
    ws.once('close', onClose);
  });
}

async function abrirSocket(token, room) {
  const url = `${WS_BASE}?sala=${encodeURIComponent(room)}&token=${encodeURIComponent(token)}`;
  const ws = new WebSocket(url);
  ws.on('error', () => {});
  try {
    const inicial = await esperarMensaje(ws, m => m.tipo === 'INICIALIZAR_ESTADO', 'inicialización WebSocket');
    return { ws, inicial };
  } catch (err) { ws.terminate(); throw err; }
}

function enviar(ws, payload) {
  if (ws.readyState !== WebSocket.OPEN) throw new Error('El WebSocket dejó de estar conectado.');
  ws.send(JSON.stringify(payload));
}

async function cerrarSesion(token) {
  await fetch(`${API_BASE}/api/logout`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }
  }).catch(() => {});
}

(async () => {
  const usuarios = [];
  const sockets = [];
  let idTemporal = null;
  try {
    console.log('Prueba distribuida: exclusión de objeto/cara, edición remota y liberación por desconexión.');
    usuarios.push(await registrarUsuario('nodoa'));
    usuarios.push(await registrarUsuario('nodob'));
    const room = `cluster_${Date.now().toString(36)}`;

    let par = null;
    for (let intento = 0; intento < 12; intento += 1) {
      const a = await abrirSocket(usuarios[0].token, room);
      const b = await abrirSocket(usuarios[1].token, room);
      sockets.push(a.ws, b.ws);
      if (a.inicial.instanciaId && b.inicial.instanciaId && a.inicial.instanciaId !== b.inicial.instanciaId) {
        par = [a, b]; break;
      }
      a.ws.close(); b.ws.close();
      await new Promise(resolve => setTimeout(resolve, 120));
    }
    if (!par) throw new Error('No se consiguieron dos instancias diferentes. Comprueba el balanceador y que haya dos backends.');
    let [a, b] = par;
    console.log(`Instancia A: ${a.inicial.instanciaId}`);
    console.log(`Instancia B: ${b.inicial.instanciaId}`);

    idTemporal = `smoke_${crypto.randomBytes(5).toString('hex')}`;
    const creadoA = esperarMensaje(a.ws, m => m.tipo === 'NUEVO_CUBO_CREADO' && m.id === idTemporal, 'creación local');
    const creadoB = esperarMensaje(b.ws, m => m.tipo === 'NUEVO_CUBO_CREADO' && m.id === idTemporal, 'difusión de creación entre instancias');
    enviar(a.ws, {
      tipo: 'CREAR_CUBO', id: idTemporal,
      datos: { tipoObjeto: 'cubo', x: 0, y: 0.5, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1, color: '#38bdf8' }
    });
    await Promise.all([creadoA, creadoB]);
    console.log('OK: se creó un objeto temporal y se propagó a los dos procesos.');

    const esperaA = esperarMensaje(a.ws, m => ['BLOQUEO_CONCEDIDO', 'BLOQUEO_DENEGADO'].includes(m.tipo) && m.idComponente === idTemporal, 'bloqueo de objeto A');
    const esperaB = esperarMensaje(b.ws, m => ['BLOQUEO_CONCEDIDO', 'BLOQUEO_DENEGADO'].includes(m.tipo) && m.idComponente === idTemporal, 'bloqueo de objeto B');
    enviar(a.ws, { tipo: 'SOLICITAR_BLOQUEO', idComponente: idTemporal });
    enviar(b.ws, { tipo: 'SOLICITAR_BLOQUEO', idComponente: idTemporal });
    const [resultadoA, resultadoB] = await Promise.all([esperaA, esperaB]);
    const ganadores = [resultadoA, resultadoB].filter(r => r.tipo === 'BLOQUEO_CONCEDIDO');
    const denegados = [resultadoA, resultadoB].filter(r => r.tipo === 'BLOQUEO_DENEGADO');
    if (ganadores.length !== 1 || denegados.length !== 1) throw new Error(`Exclusión mutua incorrecta: ${resultadoA.tipo}/${resultadoB.tipo}.`);
    console.log('OK: solo una instancia obtuvo el bloqueo del objeto.');
    const ownerObjeto = resultadoA.tipo === 'BLOQUEO_CONCEDIDO' ? a : b;
    const otroObjeto = ownerObjeto === a ? b : a;
    const liberadoObjeto = esperarMensaje(otroObjeto.ws, m => m.tipo === 'BLOQUEO_LIBERADO' && m.idComponente === idTemporal, 'liberación de bloqueo de objeto');
    enviar(ownerObjeto.ws, { tipo: 'LIBERAR_BLOQUEO', idComponente: idTemporal });
    await liberadoObjeto;

    // Bloqueo de cara y edición geométrica con difusión al otro backend.
    const seleccionCara = { idComponente: idTemporal, tipoElemento: 'cara', indiceElemento: 0, verticesLogicos: [0, 1, 2], indicesGeometria: [0, 1, 2] };
    const caraA = esperarMensaje(a.ws, m => ['BLOQUEO_ELEMENTO_CONCEDIDO', 'BLOQUEO_ELEMENTO_DENEGADO'].includes(m.tipo) && m.idComponente === idTemporal && m.tipoElemento === 'cara', 'bloqueo de cara A');
    const caraB = esperarMensaje(b.ws, m => ['BLOQUEO_ELEMENTO_CONCEDIDO', 'BLOQUEO_ELEMENTO_DENEGADO'].includes(m.tipo) && m.idComponente === idTemporal && m.tipoElemento === 'cara', 'bloqueo de cara B');
    enviar(a.ws, { tipo: 'SOLICITAR_BLOQUEO_ELEMENTO', ...seleccionCara });
    enviar(b.ws, { tipo: 'SOLICITAR_BLOQUEO_ELEMENTO', ...seleccionCara });
    const [ca, cb] = await Promise.all([caraA, caraB]);
    const ownerCara = ca.tipo === 'BLOQUEO_ELEMENTO_CONCEDIDO' ? a : b;
    const observerCara = ownerCara === a ? b : a;
    if ([ca, cb].filter(r => r.tipo === 'BLOQUEO_ELEMENTO_CONCEDIDO').length !== 1) throw new Error('La exclusión mutua de cara no funcionó.');
    const editada = esperarMensaje(observerCara.ws, m => m.tipo === 'SUBELEMENTO_GEOMETRIA_ACTUALIZADA' && m.idComponente === idTemporal, 'edición geométrica remota');
    enviar(ownerCara.ws, { tipo: 'APLICAR_EDICION_GEOMETRICA', ...seleccionCara, delta: { x: 0.25, y: 0, z: 0 } });
    await editada;
    console.log('OK: el bloqueo de cara fue exclusivo y la deformación se propagó al otro proceso.');
    const caraLiberada = esperarMensaje(observerCara.ws, m => m.tipo === 'BLOQUEO_ELEMENTO_LIBERADO' && m.idComponente === idTemporal && m.tipoElemento === 'cara', 'liberación explícita de cara');
    enviar(ownerCara.ws, { tipo: 'LIBERAR_BLOQUEO_ELEMENTO', idComponente: idTemporal, tipoElemento: 'cara', indiceElemento: 0 });
    await caraLiberada;
    console.log('OK: la liberación explícita de la cara se propagó entre instancias.');

    // Verifica que cerrar abruptamente el socket libere un bloqueo en MongoDB.
    const seleccionVertice = { idComponente: idTemporal, tipoElemento: 'vertice', indiceElemento: 5, verticesLogicos: [5], indicesGeometria: [5] };
    const verticeA = esperarMensaje(a.ws, m => ['BLOQUEO_ELEMENTO_CONCEDIDO', 'BLOQUEO_ELEMENTO_DENEGADO'].includes(m.tipo) && m.idComponente === idTemporal && m.tipoElemento === 'vertice', 'bloqueo de vértice A');
    enviar(a.ws, { tipo: 'SOLICITAR_BLOQUEO_ELEMENTO', ...seleccionVertice });
    const respuestaVertice = await verticeA;
    if (respuestaVertice.tipo !== 'BLOQUEO_ELEMENTO_CONCEDIDO') throw new Error('No se pudo adquirir el bloqueo temporal del vértice.');
    const liberadoPorCierre = esperarMensaje(b.ws, m => m.tipo === 'BLOQUEO_ELEMENTO_LIBERADO' && m.idComponente === idTemporal && m.tipoElemento === 'vertice', 'liberación por cierre abrupto', TIMEOUT_MS);
    a.ws.terminate();
    await liberadoPorCierre;
    console.log('OK: al desconectar abruptamente el cliente, el bloqueo se liberó en el otro proceso.');

    const eliminado = esperarMensaje(b.ws, m => m.tipo === 'CUBO_ELIMINADO' && m.id === idTemporal, 'limpieza del objeto de prueba');
    enviar(b.ws, { tipo: 'ELIMINAR_CUBO', id: idTemporal });
    await eliminado;
    idTemporal = null;
    console.log('OK: objeto temporal eliminado.');
    console.log('\nRESULTADO: coordinación distribuida, bloqueo geométrico, difusión y liberación por desconexión verificados.');
  } catch (err) {
    console.error('\nPRUEBA NO SUPERADA:', err.message);
    process.exitCode = 1;
  } finally {
    if (idTemporal) {
      for (const ws of sockets) {
        if (ws.readyState === WebSocket.OPEN) {
          try { enviar(ws, { tipo: 'ELIMINAR_CUBO', id: idTemporal }); } catch {}
        }
      }
    }
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'cluster smoke test complete');
      else if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
    }
    for (const user of usuarios) await cerrarSesion(user.token);
  }
})();
