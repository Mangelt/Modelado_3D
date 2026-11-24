/* Editor 3D colaborativo: cliente WebSocket + Three.js */
'use strict';

let socket = null;
let escena, camara, renderizador, controles, gridHelper;
const objetos3D = new Map();
let objetoSeleccionado = null;
let bloqueadoPorMi = false;
let bloqueoSolicitado = false;
let cambioPendiente = false;
let toastTimer = null;
let modoSeleccion = 'objeto';
let elementoSeleccionado = null;
let bloqueoElementoPorMi = false;
let bloqueoElementoSolicitado = false;
let overlayElemento = null;
let renovarElementoTimer = null;
let edicionGeometricaPendiente = false;
let authToken = localStorage.getItem('editor3d_token') || '';
let usuarioAutenticado = null;
let clienteIdPropio = null;
let autenticando = false;
let historialCargando = false;
let historialHayMas = false;
let historialAntesDe = null;
let historialSecuenciaActual = 0;
let historialVersionSeleccionada = null;
let pilaDeshacer = [];
let pilaRehacer = [];
let cursorHistorial = 0;
let ultimaSecuenciaEvento = 0;
let accionHistorialPendiente = false;

const DEFAULT_CLOUD_BACKEND_URL = 'https://modelado3d-production.up.railway.app';
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
const IDS_CONTROLES = ['pos-x','pos-y','pos-z','rot-x','rot-y','rot-z','scale-x','scale-y','scale-z','obj-color'];
const punterosCanvas = new Set();
let pointerInicioCanvas = null;

function el(id) { return document.getElementById(id); }
function conectado() { return socket && socket.readyState === WebSocket.OPEN; }
function usuario() { return usuarioAutenticado?.username || ''; }
function salaActual() { return el('txt-room').value.trim(); }

function aviso(mensaje) {
  const t = el('toast');
  t.textContent = mensaje;
  t.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.style.display = 'none', 3000);
}
function registrarActividad(texto) {
  const ul = el('activity-log');
  const li = document.createElement('li');
  li.textContent = texto;
  ul.prepend(li);
  while (ul.children.length > 30) ul.lastElementChild.remove();
}
function setEstadoConexion(texto, color) {
  el('connection-status').textContent = texto;
  el('connection-status').style.color = color;
}

const muestrasFrameCliente = [];
function medirRecepcionHastaFrame(msg, recibidoEn) {
  if (!['NUEVO_CUBO_CREADO','CUBO_DUPLICADO','CUBO_ELIMINADO','APLICAR_DELTA','SUBELEMENTO_GEOMETRIA_ACTUALIZADA','MODELO_IMPORTADO'].includes(msg?.tipo)) return;
  // Dos requestAnimationFrame permiten que ocurra al menos un ciclo de render
  // antes de registrar la muestra. Es una métrica local, no una medida de red.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const ms = performance.now() - recibidoEn;
    muestrasFrameCliente.push(ms);
    if (muestrasFrameCliente.length > 100) muestrasFrameCliente.shift();
    const ordenadas = muestrasFrameCliente.slice().sort((a, b) => a - b);
    const p95 = ordenadas[Math.min(ordenadas.length - 1, Math.ceil(ordenadas.length * 0.95) - 1)] || 0;
    const salida = el('latency-status');
    if (salida) {
      salida.textContent = `Frame cliente: ${ms.toFixed(1)} ms · P95 ${p95.toFixed(1)} ms`;
      salida.title = `Último cambio recibido→siguiente ciclo de renderizado: ${ms.toFixed(2)} ms. P95 móvil de ${ordenadas.length} muestras: ${p95.toFixed(2)} ms. No incluye tiempo de red ni confirma la latencia total del sistema.`;
    }
  }));
}

function actualizarControlesDeshacerRehacer() {
  const deshacer = el('btn-undo');
  const rehacer = el('btn-redo');
  if (!deshacer || !rehacer) return;
  deshacer.disabled = !conectado() || accionHistorialPendiente || pilaDeshacer.length === 0;
  rehacer.disabled = !conectado() || accionHistorialPendiente || pilaRehacer.length === 0;
}

function limitarPilaHistorial(pila) {
  if (pila.length > 500) pila.splice(0, pila.length - 500);
}

function actualizarPilasHistorial(msg) {
  if (!msg || !Number.isSafeInteger(msg.secuencia)) return;
  ultimaSecuenciaEvento = Math.max(ultimaSecuenciaEvento, msg.secuencia);
  if (msg.tipo === 'MODELO_IMPORTADO' && msg.metadata?.accionHistorial) {
    const objetivo = Number(msg.metadata.secuenciaObjetivo);
    if (!Number.isSafeInteger(objetivo) || objetivo < 0) return;
    if (msg.metadata.accionHistorial === 'deshacer') {
      if (pilaDeshacer.length) pilaDeshacer.pop();
      pilaRehacer.push(cursorHistorial);
      cursorHistorial = objetivo;
    } else if (msg.metadata.accionHistorial === 'rehacer') {
      if (pilaRehacer.length) pilaRehacer.pop();
      pilaDeshacer.push(cursorHistorial);
      cursorHistorial = objetivo;
    }
    accionHistorialPendiente = false;
  } else if (msg.secuencia > cursorHistorial) {
    pilaDeshacer.push(cursorHistorial);
    cursorHistorial = msg.secuencia;
    pilaRehacer = [];
  }
  limitarPilaHistorial(pilaDeshacer);
  limitarPilaHistorial(pilaRehacer);
  actualizarControlesDeshacerRehacer();
}

async function ejecutarDeshacerRehacer(accion) {
  if (!conectado() || accionHistorialPendiente) return;
  const pila = accion === 'deshacer' ? pilaDeshacer : pilaRehacer;
  if (!pila.length) return aviso(accion === 'deshacer' ? 'No hay cambios que deshacer.' : 'No hay cambios que rehacer.');
  const secuenciaObjetivo = pila[pila.length - 1];
  const secuenciaBase = ultimaSecuenciaEvento;
  accionHistorialPendiente = true;
  actualizarControlesDeshacerRehacer();
  try {
    const resultado = await solicitarAPI(`/api/rooms/${encodeURIComponent(salaActual())}/replay/${secuenciaObjetivo}`);
    if (ultimaSecuenciaEvento !== secuenciaBase) {
      throw new Error('Otro usuario modificó la sala. Actualiza el estado e inténtalo nuevamente.');
    }
    const modelos = resultado.snapshot?.modelos;
    if (!modelos || typeof modelos !== 'object' || Array.isArray(modelos)) throw new Error('No se pudo reconstruir la versión solicitada.');
    if (!enviar({
      tipo: 'IMPORTAR_MODELO', modelos,
      accionHistorial: accion,
      secuenciaObjetivo,
      secuenciaBase
    })) throw new Error('No se pudo enviar la operación al servidor.');
    aviso(accion === 'deshacer' ? 'Deshaciendo último cambio…' : 'Rehaciendo último cambio…');
  } catch (err) {
    accionHistorialPendiente = false;
    actualizarControlesDeshacerRehacer();
    aviso(err.message);
  }
}

function mismaSeleccionElemento(msg) {
  return elementoSeleccionado &&
    elementoSeleccionado.idComponente === msg.idComponente &&
    elementoSeleccionado.tipoElemento === msg.tipoElemento &&
    elementoSeleccionado.indiceElemento === msg.indiceElemento;
}

function limpiarOverlayElemento() {
  if (!overlayElemento) return;
  const padre = overlayElemento.parent;
  if (padre) padre.remove(overlayElemento);
  overlayElemento.traverse?.(obj => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
      else obj.material.dispose();
    }
  });
  overlayElemento = null;
}

function actualizarPanelElemento() {
  const modo = el('selection-mode');
  const etiqueta = el('element-info');
  const estado = el('element-lock-status');
  const boton = el('btn-element-lock');
  const ayuda = el('element-help');
  if (!modo || !etiqueta || !estado || !boton || !ayuda) return;

  if (modoSeleccion === 'objeto') {
    etiqueta.textContent = 'Modo objeto';
    estado.textContent = 'No aplica';
    estado.style.background = '#555';
    boton.disabled = true;
    boton.textContent = 'Iniciar edición';
    ayuda.textContent = 'Cambia a Cara o Vértice para seleccionar un subelemento del modelo.';
    actualizarControlesDesplazamiento();
    return;
  }
  if (!elementoSeleccionado) {
    etiqueta.textContent = 'Ninguno';
    estado.textContent = 'Sin selección';
    estado.style.background = '#555';
    boton.disabled = true;
    boton.textContent = 'Iniciar edición';
    ayuda.textContent = modoSeleccion === 'cara'
      ? 'Haz clic sobre una cara del objeto para seleccionarla.'
      : 'Haz clic sobre un vértice del objeto para seleccionarlo.';
    actualizarControlesDesplazamiento();
    return;
  }

  etiqueta.textContent = `${elementoSeleccionado.idComponente} · ${elementoSeleccionado.etiqueta}`;
  boton.disabled = !conectado() || (!bloqueadoElementoPorMi && bloqueoElementoSolicitado);
  boton.textContent = bloqueoElementoPorMi ? 'Terminar edición' : (bloqueoElementoSolicitado ? 'Solicitando…' : 'Iniciar edición');
  estado.textContent = bloqueoElementoPorMi ? 'Bloqueado por ti' : (bloqueoElementoSolicitado ? 'Solicitando…' : (elementoSeleccionado.ocupadoPor || 'Libre'));
  estado.style.background = bloqueoElementoPorMi ? '#237a45' : (elementoSeleccionado.ocupadoPor ? '#a66b20' : '#555');
  ayuda.textContent = modoSeleccion === 'cara'
    ? 'La cara seleccionada queda reservada para tu sesión mientras mantengas la edición.'
    : 'El vértice seleccionado queda reservado para tu sesión mientras mantengas la edición.';
  actualizarControlesDesplazamiento();
}

function limpiarSeleccionElemento(enviarLiberacion = true) {
  if (enviarLiberacion && bloqueoElementoPorMi && elementoSeleccionado && conectado()) {
    enviar({
      tipo: 'LIBERAR_BLOQUEO_ELEMENTO',
      idComponente: elementoSeleccionado.idComponente,
      tipoElemento: elementoSeleccionado.tipoElemento,
      indiceElemento: elementoSeleccionado.indiceElemento
    });
  }
  if (renovarElementoTimer) clearInterval(renovarElementoTimer);
  renovarElementoTimer = null;
  limpiarOverlayElemento();
  elementoSeleccionado = null;
  bloqueoElementoPorMi = false;
  bloqueoElementoSolicitado = false;
  edicionGeometricaPendiente = false;
  actualizarPanelElemento();
}

function solicitarBloqueoElemento() {
  if (!elementoSeleccionado || !conectado()) return aviso('Selecciona un subelemento y conéctate a una sala.');
  if (bloqueadoElementoPorMi) {
    limpiarSeleccionElemento(true);
    return;
  }
  if (bloqueoElementoSolicitado) return;
  bloqueoElementoSolicitado = enviar({
    tipo: 'SOLICITAR_BLOQUEO_ELEMENTO',
    idComponente: elementoSeleccionado.idComponente,
    tipoElemento: elementoSeleccionado.tipoElemento,
    indiceElemento: elementoSeleccionado.indiceElemento,
    verticesLogicos: elementoSeleccionado.verticesLogicos,
    indicesGeometria: elementoSeleccionado.indicesGeometria
  });
  actualizarPanelElemento();
}

function iniciarRenovacionBloqueoElemento() {
  if (renovarElementoTimer) clearInterval(renovarElementoTimer);
  renovarElementoTimer = setInterval(() => {
    if (!bloqueadoElementoPorMi || !elementoSeleccionado || !conectado()) return;
    enviar({
      tipo: 'RENOVAR_BLOQUEO_ELEMENTO',
      idComponente: elementoSeleccionado.idComponente,
      tipoElemento: elementoSeleccionado.tipoElemento,
      indiceElemento: elementoSeleccionado.indiceElemento
    });
  }, 5000);
}

function obtenerTopologia(mesh) {
  if (mesh.userData.topologiaGeometria) return mesh.userData.topologiaGeometria;
  const position = mesh.geometry.getAttribute('position');
  const representantePorIndice = new Array(position.count);
  const indicesPorLogico = new Map();
  const porCoordenada = new Map();
  for (let i = 0; i < position.count; i++) {
    const clave = [position.getX(i), position.getY(i), position.getZ(i)]
      .map(n => Math.abs(n) < 1e-6 ? '0.00000' : n.toFixed(5)).join('|');
    let representante = porCoordenada.get(clave);
    if (representante === undefined) {
      representante = i;
      porCoordenada.set(clave, representante);
      indicesPorLogico.set(representante, []);
    }
    representantePorIndice[i] = representante;
    indicesPorLogico.get(representante).push(i);
  }
  mesh.userData.topologiaGeometria = { representantePorIndice, indicesPorLogico };
  return mesh.userData.topologiaGeometria;
}

function expandirVerticesLogicos(mesh, indicesRaw) {
  const topologia = obtenerTopologia(mesh);
  const verticesLogicos = [...new Set(indicesRaw.map(i => topologia.representantePorIndice[i]))].sort((a,b) => a-b);
  const indicesGeometria = [...new Set(verticesLogicos.flatMap(i => topologia.indicesPorLogico.get(i) || [i]))].sort((a,b) => a-b);
  return { verticesLogicos, indicesGeometria };
}

function obtenerIndicesCara(mesh, hit) {
  const geometry = mesh.geometry;
  const esCuboAgrupado = datosObjeto(mesh).tipoObjeto === 'cubo' && geometry.groups?.length >= 6;
  let indice;
  let indicesRaw;
  let etiqueta;
  if (esCuboAgrupado && Number.isInteger(hit.faceIndex)) {
    // BoxGeometry conserva seis grupos de material, aunque el Mesh use un
    // material único. La cara se identifica por el triángulo intersectado,
    // no por face.materialIndex (que puede ser 0 en un material único).
    const inicioTriangulo = hit.faceIndex * 3;
    const group = geometry.groups.find(g => inicioTriangulo >= g.start && inicioTriangulo < g.start + g.count);
    if (!group) return { indice: -1, indices: [], indicesVisualizacion: [], verticesLogicos: [], etiqueta: 'Cara inválida' };
    indicesRaw = [];
    for (let i = group.start; i < group.start + group.count; i++) {
      indicesRaw.push(geometry.index ? geometry.index.getX(i) : i);
    }
    indice = group.materialIndex;
    etiqueta = `Cara ${indice + 1}`;
  } else {
    indice = hit.faceIndex;
    indicesRaw = [hit.face.a, hit.face.b, hit.face.c];
    etiqueta = `Cara triangular ${indice + 1}`;
  }
  const topologia = expandirVerticesLogicos(mesh, [...new Set(indicesRaw)]);
  return {
    indice,
    indices: topologia.indicesGeometria,
    indicesVisualizacion: [...new Set(indicesRaw)],
    verticesLogicos: topologia.verticesLogicos,
    etiqueta
  };
}

function obtenerVerticeCercano(mesh, hit) {
  const candidatos = [hit.face.a, hit.face.b, hit.face.c];
  const localPoint = mesh.worldToLocal(hit.point.clone());
  const position = mesh.geometry.getAttribute('position');
  let mejorRaw = candidatos[0];
  let distancia = Infinity;
  for (const indice of candidatos) {
    const punto = new THREE.Vector3().fromBufferAttribute(position, indice);
    const d = punto.distanceToSquared(localPoint);
    if (d < distancia) { distancia = d; mejorRaw = indice; }
  }
  const topologia = obtenerTopologia(mesh);
  const representante = topologia.representantePorIndice[mejorRaw];
  const indicesGeometria = topologia.indicesPorLogico.get(representante) || [representante];
  return {
    indice: representante,
    indices: [...indicesGeometria],
    indicesVisualizacion: [representante],
    verticesLogicos: [representante],
    etiqueta: `Vértice ${representante + 1}`
  };
}

function resaltarSubelemento(mesh, indices, tipoElemento) {
  limpiarOverlayElemento();
  const position = mesh.geometry.getAttribute('position');
  if (tipoElemento === 'vertice') {
    const indice = indices[0];
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.065, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0xffd54f, depthTest: true })
    );
    marker.position.fromBufferAttribute(position, indice);
    mesh.add(marker);
    overlayElemento = marker;
    return;
  }

  const vertices = [];
  for (const indice of indices) {
    vertices.push(position.getX(indice), position.getY(indice), position.getZ(indice));
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.computeVertexNormals();
  const material = new THREE.MeshBasicMaterial({
    color: 0xffd54f, transparent: true, opacity: 0.48,
    side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1
  });
  const highlight = new THREE.Mesh(geometry, material);
  mesh.add(highlight);
  overlayElemento = highlight;
}

function seleccionarSubelemento(hit, tipoElemento) {
  const mesh = hit.object;
  if (objetoSeleccionado !== mesh) seleccionarObjeto(mesh.name);
  if (elementoSeleccionado && elementoSeleccionado.idComponente === mesh.name &&
      elementoSeleccionado.tipoElemento === tipoElemento) {
    const candidato = tipoElemento === 'cara' ? obtenerIndicesCara(mesh, hit) : obtenerVerticeCercano(mesh, hit);
    if (elementoSeleccionado.indiceElemento === candidato.indice) return;
  }
  limpiarSeleccionElemento(true);
  const seleccionado = tipoElemento === 'cara' ? obtenerIndicesCara(mesh, hit) : obtenerVerticeCercano(mesh, hit);
  if (!Number.isInteger(seleccionado.indice) || seleccionado.indice < 0) return;
  elementoSeleccionado = {
    idComponente: mesh.name,
    tipoElemento,
    indiceElemento: seleccionado.indice,
    etiqueta: seleccionado.etiqueta,
    indicesGeometria: seleccionado.indices,
    indicesVisualizacion: seleccionado.indicesVisualizacion,
    verticesLogicos: seleccionado.verticesLogicos,
    ocupadoPor: ''
  };
  resaltarSubelemento(mesh, seleccionado.indicesVisualizacion, tipoElemento);
  leerDesplazamientoElemento();
  actualizarPanelElemento();
}

function cambiarModoSeleccion() {
  limpiarSeleccionElemento(true);
  modoSeleccion = el('selection-mode').value;
  el('viewport-help').textContent = modoSeleccion === 'objeto'
    ? 'Clic para seleccionar · Arrastrar para orbitar · Rueda para zoom'
    : (modoSeleccion === 'cara'
      ? 'Modo Cara: clic sobre una cara para seleccionarla · Arrastrar para orbitar'
      : 'Modo Vértice: clic cerca de un vértice para seleccionarlo · Arrastrar para orbitar');
  actualizarPanelElemento();
}
function enviar(datos) {
  if (!conectado()) {
    aviso('Conéctate a una sala para realizar cambios compartidos.');
    return false;
  }
  socket.send(JSON.stringify(datos));
  return true;
}
function validarIdentidad() {
  const r = salaActual();
  if (!authToken || !usuarioAutenticado) {
    mostrarAcceso('Inicia sesión para conectarte a una sala.');
    return false;
  }
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(r)) {
    aviso('La sala solo admite letras, números, guion y guion bajo (máximo 32).');
    el('txt-room').focus(); return false;
  }
  return true;
}

function esEntornoNativoMovil() {
  if (window.Capacitor?.isNativePlatform?.()) return true;
  if (location.protocol === 'capacitor:' || location.protocol === 'file:') return true;
  return location.protocol === 'https:' && (location.hostname === 'localhost' || location.hostname === '127.0.0.1') && !location.port;
}

function esDespliegueEstatico() {
  return location.hostname.endsWith('.vercel.app') ||
    location.hostname.endsWith('.web.app') ||
    location.hostname.endsWith('.firebaseapp.com');
}

function apiBase() {
  if (esEntornoNativoMovil() || esDespliegueEstatico()) {
    return DEFAULT_CLOUD_BACKEND_URL;
  }
  const protocolo = location.protocol === 'https:' ? 'https:' : 'http:';
  // Desarrollo local con python -m http.server en 5500: API directa en 8080.
  // En Docker/Kubernetes, nginx enruta /api al servicio backend por el mismo origen.
  if (location.port === '5500') return `${protocolo}//${location.hostname || '127.0.0.1'}:8080`;
  return `${protocolo}//${location.host}`;
}

async function solicitarAPI(ruta, metodo = 'GET', datos = null) {
  const headers = {};
  if (datos) headers['Content-Type'] = 'application/json';
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  let respuesta;
  try {
    respuesta = await fetch(`${apiBase()}${ruta}`, {
      method: metodo,
      headers,
      body: datos ? JSON.stringify(datos) : undefined
    });
  } catch (err) {
    throw Object.assign(
      new Error(`No se pudo conectar al servidor en ${apiBase()}. Verifica tu conexión o que el backend esté activo.`),
      { esRed: true }
    );
  }
  let resultado;
  try { resultado = await respuesta.json(); }
  catch {
    if (respuesta.status === 404) {
      throw Object.assign(new Error(`Ruta ${ruta} no encontrada en ${apiBase()}.`), { status: 404 });
    }
    throw Object.assign(new Error('El servidor devolvió una respuesta no válida.'), { status: respuesta.status });
  }
  if (!respuesta.ok) throw Object.assign(new Error(resultado.error || `Error HTTP ${respuesta.status}.`), { status: respuesta.status });
  return resultado;
}

function etiquetaTipoEvento(tipo) {
  const etiquetas = {
    CREAR_CUBO: 'Creación de objeto',
    DUPLICAR_CUBO: 'Duplicación de objeto',
    ELIMINAR_CUBO: 'Eliminación de objeto',
    TRANSFORMACION_DELTA: 'Cambio de transformación',
    EDICION_GEOMETRICA: 'Edición geométrica',
    IMPORTAR_MODELO: 'Importación de modelo',
    DESHACER: 'Deshacer',
    REHACER: 'Rehacer'
  };
  return etiquetas[tipo] || String(tipo || 'Evento');
}

function fechaEvento(timestamp) {
  const fecha = new Date(timestamp);
  return Number.isNaN(fecha.getTime()) ? 'Fecha no disponible' : fecha.toLocaleString();
}

function mostrarEventoHistorial(evento) {
  const li = document.createElement('li');
  li.className = 'history-event';
  li.dataset.secuencia = String(evento.secuencia);
  const main = document.createElement('div');
  main.className = 'history-event-main';
  const title = document.createElement('div');
  title.className = 'history-event-title';
  title.textContent = `#${evento.secuencia} · ${etiquetaTipoEvento(evento.tipo)}`;
  const meta = document.createElement('div');
  meta.className = 'history-event-meta';
  meta.textContent = `${evento.usuario || 'Usuario'} · ${fechaEvento(evento.timestamp)}${evento.idObjeto ? ` · ${evento.idObjeto}` : ''}`;
  main.append(title, meta);
  const actions = document.createElement('div');
  actions.className = 'history-event-actions';
  const view = document.createElement('button');
  view.type = 'button'; view.className = 'btn'; view.textContent = 'Ver versión';
  view.addEventListener('click', () => previsualizarVersion(evento.secuencia, li));
  actions.append(view);
  li.append(main, actions);
  return li;
}

async function abrirHistorial() {
  if (!conectado()) return aviso('Conéctate a una sala para consultar su historial.');
  const dialog = el('history-dialog');
  if (!dialog.open) dialog.showModal();
  await cargarHistorial(true);
}

async function cargarHistorial(reiniciar = false) {
  if (historialCargando) return;
  historialCargando = true;
  const lista = el('history-events');
  const estado = el('history-status');
  const mas = el('history-load-more');
  if (reiniciar) {
    lista.replaceChildren();
    historialAntesDe = null;
    historialHayMas = false;
    historialVersionSeleccionada = null;
    el('history-preview').hidden = true;
    el('btn-history-restore').disabled = true;
  }
  estado.textContent = 'Consultando el historial de la sala…';
  mas.disabled = true;
  try {
    const parametros = new URLSearchParams({ limit: '50' });
    if (Number.isSafeInteger(historialAntesDe) && historialAntesDe > 0) parametros.set('before', String(historialAntesDe));
    const resultado = await solicitarAPI(`/api/rooms/${encodeURIComponent(salaActual())}/history?${parametros}`);
    historialSecuenciaActual = resultado.secuenciaActual || 0;
    const eventos = Array.isArray(resultado.eventos) ? resultado.eventos : [];
    eventos.forEach(evento => lista.append(mostrarEventoHistorial(evento)));
    if (eventos.length) historialAntesDe = Math.min(...eventos.map(evento => evento.secuencia));
    historialHayMas = eventos.length === 50;
    estado.textContent = eventos.length
      ? `Sala ${resultado.sala} · secuencia actual ${historialSecuenciaActual} · ${lista.children.length} eventos cargados.`
      : (reiniciar ? 'Todavía no hay eventos registrados en esta sala.' : 'No hay más eventos anteriores.');
    mas.hidden = !historialHayMas;
  } catch (err) {
    estado.textContent = `No se pudo consultar el historial: ${err.message}`;
    mas.hidden = true;
  } finally {
    historialCargando = false;
    mas.disabled = false;
  }
}

async function previsualizarVersion(secuencia, fila) {
  if (!Number.isSafeInteger(secuencia) || secuencia < 0) return;
  el('history-status').textContent = `Reconstruyendo la versión ${secuencia}…`;
  try {
    const resultado = await solicitarAPI(`/api/rooms/${encodeURIComponent(salaActual())}/replay/${secuencia}`);
    historialVersionSeleccionada = resultado;
    for (const item of el('history-events').children) item.classList.toggle('selected', item === fila);
    const modelos = resultado.snapshot?.modelos || {};
    const ids = Object.keys(modelos);
    el('history-preview-title').textContent = `Versión #${resultado.secuencia}`;
    el('history-preview-summary').textContent = `Reconstruida con ${resultado.eventosAplicados} eventos. Contiene ${ids.length} objetos. Esta vista previa no modifica el modelo activo.`;
    const lista = el('history-preview-objects');
    lista.replaceChildren();
    ids.slice(0, 30).forEach(id => {
      const li = document.createElement('li');
      li.textContent = `${id} (${modelos[id]?.tipoObjeto || 'objeto'})`;
      lista.append(li);
    });
    if (ids.length > 30) {
      const li = document.createElement('li'); li.textContent = `… y ${ids.length - 30} objetos más.`; lista.append(li);
    }
    el('history-preview').hidden = false;
    el('btn-history-restore').disabled = !conectado();
    el('history-status').textContent = `Versión ${secuencia} reconstruida correctamente.`;
  } catch (err) {
    historialVersionSeleccionada = null;
    el('history-preview').hidden = true;
    el('history-status').textContent = `No se pudo reconstruir la versión: ${err.message}`;
  }
}

function restaurarVersionHistorial() {
  if (!historialVersionSeleccionada || !conectado()) return aviso('Conéctate a la sala antes de restaurar una versión.');
  const secuencia = historialVersionSeleccionada.secuencia;
  const modelos = historialVersionSeleccionada.snapshot?.modelos;
  if (!modelos || typeof modelos !== 'object' || Array.isArray(modelos)) return aviso('La versión seleccionada no contiene un modelo válido.');
  const cantidad = Object.keys(modelos).length;
  const confirmar = confirm(`Se reemplazará el estado actual por la versión #${secuencia} (${cantidad} objetos). La restauración se guardará como un evento nuevo y conservará el historial existente. ¿Continuar?`);
  if (!confirmar) return;
  if (enviar({ tipo: 'IMPORTAR_MODELO', modelos })) {
    aviso(`Restauración de la versión #${secuencia} solicitada. Se conservará el historial.`);
    el('history-dialog').close();
    historialVersionSeleccionada = null;
  }
}

function mostrarAcceso(mensaje = '') {
  el('auth-overlay').style.display = 'flex';
  el('auth-message').textContent = mensaje;
  setEstadoConexion('Sin sesión', '#e6b84b');
}

function ocultarAcceso() {
  el('auth-overlay').style.display = 'none';
  el('auth-message').textContent = '';
}

async function autenticar(modo) {
  if (autenticando) return;
  const username = el('auth-username').value.trim();
  const password = el('auth-password').value;
  if (!/^[\p{L}\p{N}._-]{3,24}$/u.test(username)) {
    return mostrarAcceso('El usuario debe tener entre 3 y 24 caracteres. Usa letras, números, punto, guion o guion bajo.');
  }
  if (password.length < 8 || password.length > 128) {
    return mostrarAcceso('La contraseña debe tener entre 8 y 128 caracteres.');
  }
  autenticando = true;
  el('btn-login').disabled = true;
  el('btn-register').disabled = true;
  el('auth-message').textContent = modo === 'register' ? 'Creando cuenta…' : 'Iniciando sesión…';
  try {
    const resultado = await solicitarAPI(modo === 'register' ? '/api/register' : '/api/login', 'POST', { username, password });
    authToken = resultado.token;
    usuarioAutenticado = resultado.user;
    localStorage.setItem('editor3d_token', authToken);
    el('txt-username').value = usuarioAutenticado.username;
    el('auth-password').value = '';
    ocultarAcceso();
    registrarActividad(modo === 'register' ? `Cuenta creada: ${usuarioAutenticado.username}` : `Sesión iniciada: ${usuarioAutenticado.username}`);
    conectar();
  } catch (err) {
    mostrarAcceso(err.message);
  } finally {
    autenticando = false;
    el('btn-login').disabled = false;
    el('btn-register').disabled = false;
  }
}

async function restaurarSesion() {
  if (!authToken) return mostrarAcceso();
  try {
    const resultado = await solicitarAPI('/api/me');
    usuarioAutenticado = resultado.user;
    el('txt-username').value = usuarioAutenticado.username;
    ocultarAcceso();
    conectar();
  } catch (err) {
    if (err.esRed) {
      mostrarAcceso(err.message);
      return;
    }
    if (err.status === 401 || err.status === 403) {
      authToken = '';
      usuarioAutenticado = null;
      localStorage.removeItem('editor3d_token');
      mostrarAcceso('Tu sesión venció o dejó de ser válida. Inicia sesión nuevamente.');
      return;
    }
    mostrarAcceso(err.message || 'No se pudo validar la sesión.');
  }
}

async function cerrarSesion() {
  if (socket) {
    socket.onclose = null;
    socket.close(1000, 'Sesión cerrada');
    socket = null;
  }
  // Revoca la sesión en MongoDB; el token local se elimina incluso si el servidor no responde.
  try {
    if (authToken) await solicitarAPI('/api/logout', 'POST');
  } catch (err) {
    console.warn('No se pudo confirmar el cierre remoto de sesión:', err.message);
  }
  authToken = '';
  usuarioAutenticado = null;
  localStorage.removeItem('editor3d_token');
  el('txt-username').value = 'Sin sesión';
  bloqueadoPorMi = false;
  bloqueoSolicitado = false;
  pilaDeshacer = [];
  pilaRehacer = [];
  cursorHistorial = 0;
  ultimaSecuenciaEvento = 0;
  accionHistorialPendiente = false;
  actualizarControlesDeshacerRehacer();
  limpiarSeleccionElemento(false);
  cerrarPanelesMoviles();
  mostrarAcceso('Sesión cerrada. Puedes iniciar sesión con otra cuenta.');
  setEstadoConexion('Desconectado', '#ff7777');
  el('btn-join-room').textContent = 'Conectar';
}

function init3D() {
  const canvas = el('canvas3d');
  escena = new THREE.Scene();
  escena.background = new THREE.Color(0x17191d);
  camara = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
  camara.position.set(6, 5, 7);
  renderizador = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderizador.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  controles = new THREE.OrbitControls(camara, renderizador.domElement);
  controles.enableDamping = true;
  controles.dampingFactor = 0.07;
  gridHelper = new THREE.GridHelper(40, 40, 0x555555, 0x292929);
  escena.add(gridHelper);
  escena.add(new THREE.AmbientLight(0xffffff, 0.72));
  const luz = new THREE.DirectionalLight(0xffffff, 0.65);
  luz.position.set(8, 14, 10);
  escena.add(luz);
  canvas.addEventListener('pointerdown', iniciarPunteroCanvas);
  canvas.addEventListener('pointerup', finalizarPunteroCanvas);
  canvas.addEventListener('pointercancel', cancelarPunteroCanvas);
  window.addEventListener('resize', ajustarRenderizador);
  window.addEventListener('orientationchange', () => setTimeout(ajustarRenderizador, 150));
  window.addEventListener('keydown', atajoTeclado);
  ajustarRenderizador();
  animar();
}
function ajustarRenderizador() {
  const canvas = el('canvas3d');
  const w = Math.max(1, canvas.clientWidth), h = Math.max(1, canvas.clientHeight);
  camara.aspect = w / h;
  camara.updateProjectionMatrix();
  renderizador.setSize(w, h, false);
}
function animar() {
  requestAnimationFrame(animar);
  controles.update();
  renderizador.render(escena, camara);
}
function geometriaPorTipo(tipo) {
  if (tipo === 'esfera') return new THREE.SphereGeometry(0.6, 24, 16);
  if (tipo === 'cilindro') return new THREE.CylinderGeometry(0.5, 0.5, 1, 24);
  return new THREE.BoxGeometry(1, 1, 1);
}
function datosPorDefecto(tipo) {
  return { tipoObjeto: tipo, x:0, y:0.5, z:0, rx:0, ry:0, rz:0, sx:1, sy:1, sz:1, color:'#38bdf8', vertexOffsets:{} };
}
function datosValidos(d) {
  if (!d || !['cubo','esfera','cilindro'].includes(d.tipoObjeto || 'cubo')) return false;
  const ks = ['x','y','z','rx','ry','rz','sx','sy','sz'];
  if (!ks.every(k => typeof d[k] === 'number' && Number.isFinite(d[k])) ||
      !['x','y','z'].every(k => Math.abs(d[k]) <= 20) ||
      !['sx','sy','sz'].every(k => d[k] >= .2 && d[k] <= 3) ||
      typeof d.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(d.color)) return false;
  if (d.vertexOffsets !== undefined) {
    if (!d.vertexOffsets || typeof d.vertexOffsets !== 'object' || Array.isArray(d.vertexOffsets) || Object.keys(d.vertexOffsets).length > 500) return false;
    const limite = { cubo:24, esfera:425, cilindro:102 }[d.tipoObjeto || 'cubo'];
    for (const [indice, offset] of Object.entries(d.vertexOffsets)) {
      if (!/^(0|[1-9]\d*)$/.test(indice) || Number(indice) >= limite || !offset ||
          !['x','y','z'].every(k => typeof offset[k] === 'number' && Number.isFinite(offset[k]) && Math.abs(offset[k]) <= 2)) return false;
    }
  }
  return true;
}
function aplicarOffsetsGeometria(mesh) {
  const position = mesh.geometry.getAttribute('position');
  const base = mesh.userData.basePositions;
  if (!base || base.length !== position.array.length) return;
  position.array.set(base);
  const topologia = obtenerTopologia(mesh);
  for (const [indiceTexto, delta] of Object.entries(mesh.userData.vertexOffsets || {})) {
    const indice = Number(indiceTexto);
    const indices = topologia.indicesPorLogico.get(indice) || [];
    for (const raw of indices) {
      const offset = raw * 3;
      position.array[offset] = base[offset] + delta.x;
      position.array[offset + 1] = base[offset + 1] + delta.y;
      position.array[offset + 2] = base[offset + 2] + delta.z;
    }
  }
  position.needsUpdate = true;
  mesh.geometry.computeVertexNormals();
  mesh.geometry.computeBoundingBox();
  mesh.geometry.computeBoundingSphere();
}
function leerDesplazamientoElemento() {
  const mesh = elementoSeleccionado ? objetos3D.get(elementoSeleccionado.idComponente) : null;
  const indices = elementoSeleccionado?.verticesLogicos || [];
  const offsets = indices.map(indice => mesh?.userData.vertexOffsets[String(indice)] || {x:0,y:0,z:0});
  const cantidad = Math.max(1, offsets.length);
  const offset = {
    x: offsets.reduce((s, v) => s + v.x, 0) / cantidad,
    y: offsets.reduce((s, v) => s + v.y, 0) / cantidad,
    z: offsets.reduce((s, v) => s + v.z, 0) / cantidad
  };
  for (const [axis, id] of Object.entries({x:'element-dx',y:'element-dy',z:'element-dz'})) el(id).value = offset[axis];
  actualizarEtiquetasDesplazamiento();
}
function actualizarEtiquetasDesplazamiento() {
  for (const axis of ['x','y','z']) el(`val-element-d${axis}`).value = Number(el(`element-d${axis}`).value).toFixed(2);
}
function actualizarControlesDesplazamiento() {
  const habilitado = Boolean(elementoSeleccionado && bloqueoElementoPorMi && !edicionGeometricaPendiente);
  for (const id of ['element-dx','element-dy','element-dz','btn-apply-geometry']) {
    const control = el(id);
    if (control) control.disabled = !habilitado;
  }
  const estado = el('geometry-edit-status');
  if (estado) estado.textContent = !elementoSeleccionado ? 'Selecciona una cara o vértice.' :
    !bloqueoElementoPorMi ? 'Inicia la edición para habilitar los desplazamientos.' :
    edicionGeometricaPendiente ? 'Guardando modificación…' : 'Puedes desplazar el elemento seleccionado.';
}
function aplicarDesplazamientoElemento() {
  if (!elementoSeleccionado || !bloqueoElementoPorMi || !conectado() || edicionGeometricaPendiente) return;
  const delta = {x:Number(el('element-dx').value), y:Number(el('element-dy').value), z:Number(el('element-dz').value)};
  if (!['x','y','z'].every(k => Number.isFinite(delta[k]) && Math.abs(delta[k]) <= 2)) return aviso('El desplazamiento debe estar entre -2 y 2.');
  edicionGeometricaPendiente = enviar({
    tipo: 'APLICAR_EDICION_GEOMETRICA',
    idComponente: elementoSeleccionado.idComponente,
    tipoElemento: elementoSeleccionado.tipoElemento,
    indiceElemento: elementoSeleccionado.indiceElemento,
    verticesLogicos: elementoSeleccionado.verticesLogicos,
    indicesGeometria: elementoSeleccionado.indicesGeometria,
    delta
  });
  actualizarControlesDesplazamiento();
}
function crearObjeto(id, datos) {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id) || !datosValidos(datos) || objetos3D.has(id)) return false;
  const material = new THREE.MeshStandardMaterial({ color: datos.color, roughness: .65, metalness: .05 });
  const geometry = geometriaPorTipo(datos.tipoObjeto || 'cubo');
  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData.basePositions = new Float32Array(geometry.getAttribute('position').array);
  mesh.userData.vertexOffsets = { ...(datos.vertexOffsets || {}) };
  mesh.name = id;
  obtenerTopologia(mesh);
  aplicarOffsetsGeometria(mesh);
  mesh.position.set(datos.x, datos.y, datos.z);
  mesh.rotation.set(datos.rx, datos.ry, datos.rz);
  mesh.scale.set(datos.sx, datos.sy, datos.sz);
  escena.add(mesh);
  objetos3D.set(id, mesh);
  actualizarOutliner();
  if (!objetoSeleccionado) seleccionarObjeto(id);
  return true;
}
function datosObjeto(obj) {
  return {
    tipoObjeto: obj.geometry.type === 'SphereGeometry' ? 'esfera' :
      obj.geometry.type === 'CylinderGeometry' ? 'cilindro' : 'cubo',
    x:obj.position.x,y:obj.position.y,z:obj.position.z,
    rx:obj.rotation.x,ry:obj.rotation.y,rz:obj.rotation.z,
    sx:obj.scale.x,sy:obj.scale.y,sz:obj.scale.z,
    color:'#'+obj.material.color.getHexString(),
    vertexOffsets: { ...(obj.userData.vertexOffsets || {}) }
  };
}
function limpiarEscena(modelos = {}) {
  for (const obj of objetos3D.values()) {
    escena.remove(obj); obj.geometry.dispose(); obj.material.dispose();
  }
  limpiarSeleccionElemento(false);
  objetos3D.clear(); objetoSeleccionado = null; bloqueadoPorMi = false; bloqueoSolicitado = false;
  el('outliner').replaceChildren();
  actualizarPropiedades(null);
  for (const [id, d] of Object.entries(modelos)) crearObjeto(id, d);
}
function actualizarOutliner() {
  const ul = el('outliner'); ul.replaceChildren();
  for (const [id, obj] of objetos3D) {
    const li = document.createElement('li');
    li.dataset.id = id;
    const name = document.createElement('span'); name.textContent = id;
    const type = document.createElement('small'); type.textContent = datosObjeto(obj).tipoObjeto;
    li.append(name, type);
    li.classList.toggle('selected', objetoSeleccionado === obj);
    li.addEventListener('click', () => seleccionarObjeto(id));
    ul.appendChild(li);
  }
  el('btn-duplicate').disabled = !objetoSeleccionado;
  el('btn-delete').disabled = !objetoSeleccionado;
}
function actualizarPropiedades(obj) {
  IDS_CONTROLES.forEach(id => { el(id).disabled = !obj; });
  if (!obj) {
    el('lbl-id').textContent = 'Ninguno';
    el('lbl-status').textContent = 'Libre';
    el('lbl-status').style.background = '#555';
    el('lock-owner').textContent = '';
    return;
  }
  const d = datosObjeto(obj);
  el('lbl-id').textContent = obj.name;
  for (const [id, value] of Object.entries({
    'pos-x':d.x,'pos-y':d.y,'pos-z':d.z,'rot-x':d.rx,'rot-y':d.ry,'rot-z':d.rz,
    'scale-x':d.sx,'scale-y':d.sy,'scale-z':d.sz,'obj-color':d.color
  })) el(id).value = value;
  actualizarEtiquetas();
  const ocupadoOtro = !bloqueadoPorMi && el('lock-owner').textContent.startsWith('Editando:');
  el('lbl-status').textContent = bloqueadoPorMi ? 'Bloqueado por ti' : (ocupadoOtro ? 'En uso' : 'Libre');
  el('lbl-status').style.background = bloqueadoPorMi ? '#237a45' : (ocupadoOtro ? '#a66b20' : '#555');
}
function actualizarEtiquetas() {
  IDS_CONTROLES.filter(id => id !== 'obj-color').forEach(id => {
    const out = el('val-'+id);
    if (out) out.value = Number(el(id).value).toFixed(1);
  });
}
function seleccionarObjeto(id) {
  const obj = objetos3D.get(id);
  if (!obj) return;
  if (objetoSeleccionado !== obj) limpiarSeleccionElemento(true);
  if (objetoSeleccionado) objetoSeleccionado.material.emissive.setHex(0x000000);
  objetoSeleccionado = obj;
  obj.material.emissive.setHex(0x202020);
  bloqueadoPorMi = false; bloqueoSolicitado = false; cambioPendiente = false;
  actualizarPropiedades(obj); actualizarOutliner();
}
function iniciarPunteroCanvas(event) {
  punterosCanvas.add(event.pointerId);
  if (punterosCanvas.size > 1 || (event.pointerType === 'mouse' && event.button !== 0)) {
    pointerInicioCanvas = null;
    return;
  }
  pointerInicioCanvas = { id: event.pointerId, x: event.clientX, y: event.clientY };
}
function cancelarPunteroCanvas(event) {
  punterosCanvas.delete(event.pointerId);
  if (pointerInicioCanvas?.id === event.pointerId) pointerInicioCanvas = null;
}
function finalizarPunteroCanvas(event) {
  punterosCanvas.delete(event.pointerId);
  const inicio = pointerInicioCanvas;
  if (!inicio || inicio.id !== event.pointerId) return;
  pointerInicioCanvas = null;
  if (Math.hypot(event.clientX - inicio.x, event.clientY - inicio.y) >= 6) return;
  seleccionarDesdeCanvas(event);
}
function seleccionarDesdeCanvas(event) {
  const rect = renderizador.domElement.getBoundingClientRect();
  mouse.x = ((event.clientX-rect.left)/rect.width)*2-1;
  mouse.y = -((event.clientY-rect.top)/rect.height)*2+1;
  raycaster.setFromCamera(mouse, camara);
  const hits = raycaster.intersectObjects([...objetos3D.values()]);
  if (!hits.length) {
    if (modoSeleccion !== 'objeto') limpiarSeleccionElemento(true);
    return;
  }
  const hit = hits[0];
  if (modoSeleccion === 'objeto') {
    limpiarSeleccionElemento(true);
    seleccionarObjeto(hit.object.name);
  } else {
    seleccionarSubelemento(hit, modoSeleccion);
  }
}
function solicitarBloqueo() {
  if (!objetoSeleccionado || bloqueadoPorMi || bloqueoSolicitado) return;
  bloqueoSolicitado = enviar({tipo:'SOLICITAR_BLOQUEO',idComponente:objetoSeleccionado.name});
  if (bloqueoSolicitado) el('lbl-status').textContent = 'Solicitando…';
}
function leerTransformacion() {
  const d = {};
  for (const [key,id] of Object.entries({
    x:'pos-x',y:'pos-y',z:'pos-z',rx:'rot-x',ry:'rot-y',rz:'rot-z',
    sx:'scale-x',sy:'scale-y',sz:'scale-z'
  })) d[key] = Number(el(id).value);
  d.color = el('obj-color').value;
  d.tipoObjeto = datosObjeto(objetoSeleccionado).tipoObjeto;
  d.vertexOffsets = { ...(objetoSeleccionado.userData.vertexOffsets || {}) };
  return d;
}
function aplicarCambios() {
  if (!objetoSeleccionado) return;
  if (!bloqueadoPorMi) { cambioPendiente = true; solicitarBloqueo(); return; }
  const d = leerTransformacion();
  if (!datosValidos(d)) { aviso('Valores de transformación fuera de rango.'); return; }
  objetoSeleccionado.position.set(d.x,d.y,d.z);
  objetoSeleccionado.rotation.set(d.rx,d.ry,d.rz);
  objetoSeleccionado.scale.set(d.sx,d.sy,d.sz);
  objetoSeleccionado.material.color.set(d.color);
  actualizarEtiquetas();
  enviar({tipo:'TRANSFORMACION_DELTA',idComponente:objetoSeleccionado.name,delta:d});
}
function liberarBloqueo() {
  if (bloqueadoPorMi && objetoSeleccionado && conectado()) {
    enviar({tipo:'LIBERAR_BLOQUEO',idComponente:objetoSeleccionado.name});
  }
  bloqueadoPorMi = false; bloqueoSolicitado = false;
}
function generarIdCorto() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID().slice(0, 8);
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
function crearNuevo(tipo) {
  if (!conectado()) return aviso('Conéctate a una sala antes de crear objetos.');
  if (objetos3D.size >= 200) return aviso('Límite de 200 objetos por sala alcanzado.');
  const id = `${tipo}_${generarIdCorto()}`;
  enviar({tipo:'CREAR_CUBO',id,datos:datosPorDefecto(tipo)});
}
function duplicarSeleccionado() {
  if (!objetoSeleccionado || !conectado()) return;
  if (objetos3D.size >= 200) return aviso('Límite de 200 objetos por sala alcanzado.');
  const d = datosObjeto(objetoSeleccionado); d.x = Math.min(20,d.x+1.2);
  const id = `copia_${generarIdCorto()}`;
  enviar({tipo:'DUPLICAR_CUBO',id,datos:d});
}
function eliminarSeleccionado() {
  if (!objetoSeleccionado || !conectado()) return;
  if (!confirm(`¿Eliminar "${objetoSeleccionado.name}" de la sala?`)) return;
  enviar({tipo:'ELIMINAR_CUBO',id:objetoSeleccionado.name});
}
function wsEndpoint() {
  if (esEntornoNativoMovil() || esDespliegueEstatico()) {
    return `${DEFAULT_CLOUD_BACKEND_URL.replace(/^http/i, 'ws')}/ws`;
  }
  const protocolo = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = location.hostname || '127.0.0.1';
  return location.port === '5500'
    ? `${protocolo}//${host}:8080`
    : `${protocolo}//${location.host}/ws`;
}
function conectar() {
  if (!validarIdentidad()) return;
  if (socket) { socket.onclose = null; socket.close(); }
  const endpoint = wsEndpoint();
  const url = `${endpoint}?sala=${encodeURIComponent(salaActual())}&token=${encodeURIComponent(authToken)}`;
  socket = new WebSocket(url);
  setEstadoConexion('Conectando…','#e6b84b');
  socket.onopen = () => {
    setEstadoConexion(`Conectado · ${salaActual()}`,'#4caf50');
    registrarActividad(`Conectado a la sala ${salaActual()}`);
    el('btn-join-room').textContent = 'Conectado';
  };
  socket.onmessage = event => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return aviso('El servidor envió un mensaje ilegible.'); }
    procesarMensaje(msg);
  };
  socket.onerror = () => aviso('Error de conexión con el servidor WebSocket.');
  socket.onclose = () => {
    setEstadoConexion('Desconectado','#ff7777');
    el('btn-join-room').textContent = 'Conectar';
    bloqueadoPorMi = false; bloqueoSolicitado = false;
    bloqueoElementoPorMi = false; bloqueoElementoSolicitado = false;
    if (renovarElementoTimer) clearInterval(renovarElementoTimer); renovarElementoTimer = null;
    if (objetoSeleccionado) actualizarPropiedades(objetoSeleccionado);
    actualizarPanelElemento();
    actualizarControlesDeshacerRehacer();
    registrarActividad('Conexión cerrada.');
  };
}
function procesarMensaje(msg) {
  const recibidoEn = performance.now();
  if (['NUEVO_CUBO_CREADO','CUBO_DUPLICADO','CUBO_ELIMINADO','APLICAR_DELTA','SUBELEMENTO_GEOMETRIA_ACTUALIZADA','MODELO_IMPORTADO'].includes(msg.tipo)) {
    actualizarPilasHistorial(msg);
  }
  switch(msg.tipo) {
    case 'INICIALIZAR_ESTADO':
      clienteIdPropio = msg.clienteId || null;
      cursorHistorial = Number(msg.controlHistorial?.cursor) || 0;
      ultimaSecuenciaEvento = Number(msg.secuencia) || 0;
      pilaDeshacer = Array.isArray(msg.controlHistorial?.undoStack) ? msg.controlHistorial.undoStack.slice(-500) : [];
      pilaRehacer = Array.isArray(msg.controlHistorial?.redoStack) ? msg.controlHistorial.redoStack.slice(-500) : [];
      accionHistorialPendiente = false;
      actualizarControlesDeshacerRehacer();
      limpiarEscena(msg.snapshot?.modelos || {});
      (msg.historial || []).slice(-12).reverse().forEach(ev => registrarActividad(`#${ev.secuencia} ${ev.usuario}: ${ev.tipo}`));
      registrarActividad('Modelo sincronizado con el servidor.');
      break;
    case 'BLOQUEO_CONCEDIDO':
      if (objetoSeleccionado?.name === msg.idComponente) {
        bloqueadoPorMi = true; bloqueoSolicitado = false;
        el('lbl-status').textContent = 'Bloqueado por ti'; el('lbl-status').style.background = '#237a45';
        if (cambioPendiente) { cambioPendiente = false; aplicarCambios(); }
      }
      break;
    case 'BLOQUEO_DENEGADO':
      if (objetoSeleccionado?.name === msg.idComponente) {
        bloqueadoPorMi = false; bloqueoSolicitado = false; cambioPendiente = false;
        actualizarPropiedades(objetoSeleccionado);
        el('lbl-status').textContent = 'En uso'; el('lbl-status').style.background = '#a66b20';
        el('lock-owner').textContent = `Editando: ${msg.usuario || 'otro usuario'}`;
        aviso(`El objeto está bloqueado por ${msg.usuario || 'otro usuario'}.`);
      }
      break;
    case 'BLOQUEO_OCUPADO':
      if (objetoSeleccionado?.name === msg.idComponente && msg.clienteId !== undefined) {
        el('lock-owner').textContent = msg.usuario === usuario() ? 'Bloqueo activo' : `Editando: ${msg.usuario}`;
      }
      break;
    case 'BLOQUEO_LIBERADO':
      if (objetoSeleccionado?.name === msg.idComponente) {
        bloqueadoPorMi = false; bloqueoSolicitado = false;
        el('lbl-status').textContent = 'Libre'; el('lbl-status').style.background = '#555';
        el('lock-owner').textContent = '';
      }
      break;
    case 'BLOQUEO_ELEMENTO_CONCEDIDO':
      if (mismaSeleccionElemento(msg)) {
        bloqueoElementoPorMi = true;
        bloqueoElementoSolicitado = false;
        elementoSeleccionado.ocupadoPor = '';
        iniciarRenovacionBloqueoElemento();
        leerDesplazamientoElemento();
        actualizarPanelElemento();
        registrarActividad(`Bloqueo concedido: ${elementoSeleccionado.etiqueta} de ${elementoSeleccionado.idComponente}`);
      } else {
        // La respuesta llegó después de que el usuario seleccionó otro elemento.
        enviar({ tipo: 'LIBERAR_BLOQUEO_ELEMENTO', idComponente: msg.idComponente, tipoElemento: msg.tipoElemento, indiceElemento: msg.indiceElemento });
      }
      break;
    case 'BLOQUEO_ELEMENTO_DENEGADO':
      if (mismaSeleccionElemento(msg)) {
        bloqueoElementoPorMi = false;
        bloqueoElementoSolicitado = false;
        elementoSeleccionado.ocupadoPor = `En uso por ${msg.usuario || 'otro usuario'}`;
        actualizarPanelElemento();
        aviso(`Ese subelemento está bloqueado por ${msg.usuario || 'otro usuario'}.`);
      }
      break;
    case 'BLOQUEO_ELEMENTO_OCUPADO':
      if (mismaSeleccionElemento(msg) && msg.clienteId !== clienteIdPropio) {
        elementoSeleccionado.ocupadoPor = `En uso por ${msg.usuario || 'otro usuario'}`;
        actualizarPanelElemento();
      }
      break;
    case 'BLOQUEO_ELEMENTO_LIBERADO':
      if (mismaSeleccionElemento(msg)) {
        if (msg.clienteId && msg.clienteId === clienteIdPropio && bloqueoElementoPorMi) {
          bloqueoElementoPorMi = false;
          bloqueoElementoSolicitado = false;
          if (renovarElementoTimer) clearInterval(renovarElementoTimer); renovarElementoTimer = null;
        }
        elementoSeleccionado.ocupadoPor = '';
        actualizarPanelElemento();
      }
      break;
    case 'BLOQUEO_ELEMENTO_RENOVADO':
      break;
    case 'SUBELEMENTO_GEOMETRIA_ACTUALIZADA': {
      const mesh = objetos3D.get(msg.idComponente);
      if (mesh && Array.isArray(msg.verticesLogicos) && msg.delta &&
          ['x','y','z'].every(k => Number.isFinite(msg.delta[k]))) {
        mesh.userData.vertexOffsets ||= {};
        for (const indice of msg.verticesLogicos) {
          if (Number.isInteger(indice) && indice >= 0) mesh.userData.vertexOffsets[String(indice)] = { ...msg.delta };
        }
        aplicarOffsetsGeometria(mesh);
        if (elementoSeleccionado?.idComponente === msg.idComponente) {
          const mismo = elementoSeleccionado.tipoElemento === msg.tipoElemento && elementoSeleccionado.indiceElemento === msg.indiceElemento;
          if (mismo) {
            edicionGeometricaPendiente = false;
            resaltarSubelemento(mesh, elementoSeleccionado.indicesVisualizacion, elementoSeleccionado.tipoElemento);
            leerDesplazamientoElemento();
            actualizarPanelElemento();
          }
        }
        registrarActividad(`${msg.usuario} desplazó ${msg.tipoElemento} ${msg.indiceElemento + 1} de ${msg.idComponente}`);
      }
      break;
    }
    case 'NUEVO_CUBO_CREADO':
    case 'CUBO_DUPLICADO':
      if (crearObjeto(msg.id,msg.datos || msg.pos)) registrarActividad(`${msg.usuario} agregó ${msg.id}`);
      break;
    case 'CUBO_ELIMINADO': {
      const obj = objetos3D.get(msg.id);
      if (obj) { escena.remove(obj); obj.geometry.dispose(); obj.material.dispose(); objetos3D.delete(msg.id); }
      if (elementoSeleccionado?.idComponente === msg.id) limpiarSeleccionElemento(false);
      if (objetoSeleccionado?.name === msg.id) { objetoSeleccionado = null; actualizarPropiedades(null); }
      actualizarOutliner(); registrarActividad(`${msg.usuario} eliminó ${msg.id}`);
      break;
    }
    case 'APLICAR_DELTA': {
      const obj = objetos3D.get(msg.idComponente);
      if (obj && datosValidos(msg.delta)) {
        const d=msg.delta;
        obj.position.set(d.x,d.y,d.z); obj.rotation.set(d.rx,d.ry,d.rz);
        obj.scale.set(d.sx,d.sy,d.sz); obj.material.color.set(d.color);
        if (objetoSeleccionado === obj) actualizarPropiedades(obj);
        registrarActividad(`${msg.usuario} modificó ${msg.idComponente}`);
      }
      break;
    }
    case 'MODELO_IMPORTADO':
      limpiarEscena(msg.modelos || {});
      if (msg.metadata?.accionHistorial === 'deshacer') {
        registrarActividad(`${msg.usuario} deshizo un cambio (versión ${msg.metadata.secuenciaObjetivo}).`);
        aviso('Cambio deshecho y sincronizado.');
      } else if (msg.metadata?.accionHistorial === 'rehacer') {
        registrarActividad(`${msg.usuario} rehizo un cambio (versión ${msg.metadata.secuenciaObjetivo}).`);
        aviso('Cambio rehecho y sincronizado.');
      } else {
        registrarActividad(`${msg.usuario} importó o restauró un modelo completo.`);
        aviso('Modelo importado y sincronizado.');
      }
      break;
    case 'ERROR':
      if (['HISTORIAL_DESACTUALIZADO','HISTORIAL_INVALIDO','HISTORIAL_NO_DISPONIBLE','SALA_EN_EDICION','PERSISTENCIA_NO_DISPONIBLE'].includes(msg.codigo)) {
        accionHistorialPendiente = false;
        actualizarControlesDeshacerRehacer();
      }
      aviso(msg.mensaje || 'El servidor rechazó la operación.');
      if (msg.codigo === 'SIN_BLOQUEO' || msg.codigo === 'OBJETO_BLOQUEADO') {
        bloqueadoPorMi = false; bloqueoSolicitado = false; cambioPendiente = false;
      }
      if (msg.codigo === 'SUBELEMENTO_INVALIDO' || msg.codigo === 'GEOMETRIA_INVALIDA' ||
          msg.codigo === 'EDICION_GEOMETRICA_INVALIDA' || msg.codigo === 'SIN_BLOQUEO_ELEMENTO') {
        edicionGeometricaPendiente = false;
        if (msg.codigo === 'SUBELEMENTO_INVALIDO' || msg.codigo === 'GEOMETRIA_INVALIDA' || msg.codigo === 'SIN_BLOQUEO_ELEMENTO') {
          bloqueoElementoPorMi = false;
          bloqueoElementoSolicitado = false;
          if (renovarElementoTimer) clearInterval(renovarElementoTimer);
          renovarElementoTimer = null;
        }
        actualizarPanelElemento();
      }
      break;
    case 'USUARIO_CONECTADO':
      registrarActividad(`${msg.usuario} se unió a la sala.`);
      break;
    case 'USUARIO_DESCONECTADO':
      registrarActividad(`${msg.usuario} salió de la sala.`);
      break;
  }
  medirRecepcionHastaFrame(msg, recibidoEn);
}
function exportarModelo() {
  const modelos = {};
  for (const [id,obj] of objetos3D) modelos[id]=datosObjeto(obj);
  const blob = new Blob([JSON.stringify({version:1,exportadoEn:new Date().toISOString(),modelos},null,2)],{type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url;
  a.download = `modelo-3d-${salaActual() || 'sala'}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  aviso('Modelo exportado en formato JSON.');
}
async function importarModelo(file) {
  if (!file || !conectado()) return aviso('Conéctate a una sala antes de importar.');
  if (file.size > 1024*1024) return aviso('El archivo supera el máximo de 1 MB.');
  try {
    const parsed=JSON.parse(await file.text());
    const modelos=parsed.modelos;
    if (!modelos || typeof modelos!=='object' || Array.isArray(modelos) || Object.keys(modelos).length>200) throw new Error('Estructura o cantidad de objetos inválida.');
    for (const [id,d] of Object.entries(modelos)) {
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(id) || !datosValidos(d)) throw new Error(`Datos inválidos en el objeto "${id}".`);
    }
    if (!confirm(`Se reemplazarán los ${objetos3D.size} objetos actuales por ${Object.keys(modelos).length} objetos. ¿Continuar?`)) return;
    enviar({tipo:'IMPORTAR_MODELO',modelos});
  } catch(err) { aviso(`No se pudo importar: ${err.message}`); }
}
function atajoTeclado(e) {
  if (el('auth-overlay')?.style.display !== 'none' || el('history-dialog')?.open) return;
  if (['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName) || document.activeElement.isContentEditable) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); ejecutarDeshacerRehacer('deshacer'); return; }
  if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); ejecutarDeshacerRehacer('rehacer'); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); eliminarSeleccionado(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase()==='d') { e.preventDefault(); duplicarSeleccionado(); }
  if (e.key === 'Escape') {
    liberarBloqueo();
    if (bloqueadoElementoPorMi) limpiarSeleccionElemento(true);
  }
}

el('btn-add-cube').addEventListener('click',()=>crearNuevo('cubo'));
el('btn-add-sphere').addEventListener('click',()=>crearNuevo('esfera'));
el('btn-add-cylinder').addEventListener('click',()=>crearNuevo('cilindro'));
el('btn-duplicate').addEventListener('click',duplicarSeleccionado);
el('btn-delete').addEventListener('click',eliminarSeleccionado);
el('btn-join-room').addEventListener('click',conectar);
el('selection-mode').addEventListener('change',cambiarModoSeleccion);
el('btn-element-lock').addEventListener('click',solicitarBloqueoElemento);
el('btn-apply-geometry').addEventListener('click',aplicarDesplazamientoElemento);
for (const id of ['element-dx','element-dy','element-dz']) el(id).addEventListener('input',actualizarEtiquetasDesplazamiento);
el('btn-logout').addEventListener('click',cerrarSesion);
el('auth-form').addEventListener('submit',event=>{event.preventDefault();autenticar('login');});
el('btn-register').addEventListener('click',()=>autenticar('register'));
el('btn-export').addEventListener('click',exportarModelo);
el('btn-history').addEventListener('click',abrirHistorial);
el('btn-undo').addEventListener('click',()=>ejecutarDeshacerRehacer('deshacer'));
el('btn-redo').addEventListener('click',()=>ejecutarDeshacerRehacer('rehacer'));
el('btn-history-close').addEventListener('click',()=>el('history-dialog').close());
el('btn-history-close-footer').addEventListener('click',()=>el('history-dialog').close());
el('btn-history-refresh').addEventListener('click',()=>cargarHistorial(true));
el('history-load-more').addEventListener('click',()=>cargarHistorial(false));
el('btn-history-restore').addEventListener('click',restaurarVersionHistorial);
el('btn-import').addEventListener('click',()=>el('file-import').click());
el('file-import').addEventListener('change',e=>{importarModelo(e.target.files[0]);e.target.value='';});
el('btn-grid').addEventListener('click',()=>{
  gridHelper.visible=!gridHelper.visible;
  el('btn-grid').textContent=gridHelper.visible?'Ocultar cuadrícula':'Mostrar cuadrícula';
});
el('btn-camera').addEventListener('click',()=>{
  camara.position.set(6,5,7); controles.target.set(0,0,0); controles.update();
});
IDS_CONTROLES.forEach(id=>{
  el(id).addEventListener('pointerdown',solicitarBloqueo);
  el(id).addEventListener('input',()=>{actualizarEtiquetas();aplicarCambios();});
  el(id).addEventListener('change',liberarBloqueo);
});
function cerrarPanelesMoviles() {
  el('sidebar-left')?.classList.remove('mobile-open');
  el('sidebar-right')?.classList.remove('mobile-open');
  el('sidebar-backdrop')?.classList.remove('active');
}

function inicializarControlesMoviles() {
  const btnToggleLeft = el('btn-toggle-left');
  const btnToggleRight = el('btn-toggle-right');
  const btnCloseLeft = el('btn-close-sidebar-left');
  const btnCloseRight = el('btn-close-sidebar-right');
  const backdrop = el('sidebar-backdrop');

  btnToggleLeft?.addEventListener('click', () => {
    const abierto = el('sidebar-left')?.classList.toggle('mobile-open');
    el('sidebar-right')?.classList.remove('mobile-open');
    if (abierto) backdrop?.classList.add('active');
    else backdrop?.classList.remove('active');
  });

  btnToggleRight?.addEventListener('click', () => {
    const abierto = el('sidebar-right')?.classList.toggle('mobile-open');
    el('sidebar-left')?.classList.remove('mobile-open');
    if (abierto) backdrop?.classList.add('active');
    else backdrop?.classList.remove('active');
  });

  btnCloseLeft?.addEventListener('click', cerrarPanelesMoviles);
  btnCloseRight?.addEventListener('click', cerrarPanelesMoviles);
  backdrop?.addEventListener('click', cerrarPanelesMoviles);

  el('canvas3d')?.addEventListener('pointerdown', cerrarPanelesMoviles);
}

window.addEventListener('beforeunload',liberarBloqueo);
window.addEventListener('load',()=>{
  init3D();
  actualizarPanelElemento();
  restaurarSesion();
  inicializarControlesMoviles();
});
