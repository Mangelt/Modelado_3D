'use strict';

const WebSocket = require('ws');
const mongoose = require('mongoose');
const http = require('http');
const { URL } = require('url');
const crypto = require('crypto');
const { hashPassword, verifyPassword, createToken, verifyToken } = require('./auth');
const {
  validarIndiceElemento, claveObjeto, claveSala, claveElemento, analizarClave
} = require('./lock-manager');
const { LIMITES_VERTICES, validarBloqueoGeometrico, validarDelta, mismaLista, aplicarOffsetsVertices } = require('./geometry-edits');
const { clonar, aplicarEvento, reconstruirSnapshot, siguienteSecuenciaConfirmada } = require('./event-store');
const { crearAlmacenBloqueosDistribuidos } = require('./distributed-lock-store');
const { calcularEstadoHistorial, siguienteAccionHistorial } = require('./history-stack');

const PORT = Number(process.env.PORT) || 8080;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/sistemas_distribuidos_3d';
const MAX_OBJECTS = 200;
const MAX_HISTORY = 1000;
const SNAPSHOT_EVERY_EVENTS = 25;
const SNAPSHOT_INTERVAL_MS = 30 * 1000;
const LOCK_TTL_MS = 15000;
const SYNC_EVENTS_INTERVAL_MS = 300;
const SYNC_LOCKS_INTERVAL_MS = 500;
const INSTANCE_ID = crypto.randomUUID();
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const ROOM_RE = /^[A-Za-z0-9_-]{1,32}$/;
const USERNAME_RE = /^[\p{L}\p{N}._-]{3,24}$/u;
const MAX_AUTH_BODY = 8 * 1024;
const AUTH_RATE_WINDOW_MS = 15 * 60 * 1000;
const AUTH_RATE_MAX = 12;
const authAttempts = new Map();
const allowedOrigins = new Set(
  (process.env.CLIENT_ORIGINS || 'http://localhost:5500,http://127.0.0.1:5500')
    .split(',').map(value => value.trim()).filter(Boolean)
);

const salaSchema = new mongoose.Schema({
  nombreSala: { type: String, unique: true, required: true, index: true },
  snapshot: { type: mongoose.Schema.Types.Mixed, required: true },
  historial: { type: [mongoose.Schema.Types.Mixed], default: [] },
  secuencia: { type: Number, default: 0 },
  snapshotSecuencia: { type: Number, default: 0 }
}, { versionKey: false });
const SalaModel = mongoose.models.SalaProyecto || mongoose.model('SalaProyecto', salaSchema);

const eventoSchema = new mongoose.Schema({
  nombreSala: { type: String, required: true, index: true },
  secuencia: { type: Number, required: true },
  eventoId: { type: String, required: true, unique: true },
  tipo: { type: String, required: true },
  idObjeto: { type: String, default: null },
  usuario: { type: String, required: true },
  clienteId: { type: String, required: true },
  timestamp: { type: String, required: true },
  antes: { type: mongoose.Schema.Types.Mixed, default: null },
  despues: { type: mongoose.Schema.Types.Mixed, default: null },
  metadata: { type: mongoose.Schema.Types.Mixed, default: null }
}, { versionKey: false, collection: 'eventos_sala_proyectos' });
eventoSchema.index({ nombreSala: 1, secuencia: 1 }, { unique: true });
eventoSchema.add({ instanciaId: { type: String, default: 'legacy' } });
const EventoModel = mongoose.models.EventoSalaProyecto || mongoose.model('EventoSalaProyecto', eventoSchema);

const snapshotSchema = new mongoose.Schema({
  nombreSala: { type: String, required: true },
  secuencia: { type: Number, required: true },
  timestamp: { type: Date, default: Date.now },
  snapshot: { type: mongoose.Schema.Types.Mixed, required: true }
}, { versionKey: false, collection: 'snapshots_sala_proyectos' });
snapshotSchema.index({ nombreSala: 1, secuencia: 1 }, { unique: true });
const SnapshotModel = mongoose.models.SnapshotSalaProyecto || mongoose.model('SnapshotSalaProyecto', snapshotSchema);

const bloqueoSalaSchema = new mongoose.Schema({
  nombreSala: { type: String, required: true, unique: true, index: true },
  revision: { type: Number, default: 0 },
  bloqueos: { type: [mongoose.Schema.Types.Mixed], default: [] }
}, { versionKey: false, collection: 'bloqueos_sala_proyectos' });
const BloqueoSalaModel = mongoose.models.BloqueoSalaProyecto || mongoose.model('BloqueoSalaProyecto', bloqueoSalaSchema);
const almacenBloqueos = crearAlmacenBloqueosDistribuidos(BloqueoSalaModel);

const usuarioSchema = new mongoose.Schema({
  username: { type: String, required: true, trim: true, maxlength: 24 },
  usernameKey: { type: String, required: true, unique: true, index: true },
  passwordHash: { type: String, required: true, select: false }
}, { timestamps: true, versionKey: false });
const UsuarioModel = mongoose.models.UsuarioProyecto || mongoose.model('UsuarioProyecto', usuarioSchema);

const sesionSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, unique: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'UsuarioProyecto', required: true, index: true },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
  revokedAt: { type: Date, default: null }
}, { versionKey: false });
const SesionModel = mongoose.models.SesionProyecto || mongoose.model('SesionProyecto', sesionSchema);

const salasActivas = new Map();
const salasEnCarga = new Map();
const httpServer = http.createServer((req, res) => {
  manejarSolicitudHTTP(req, res).catch(err => {
    console.error('Error HTTP:', err.message);
    if (!res.headersSent) responderJSON(res, 500, { error: 'Ocurrió un error interno en el servidor.' });
    else res.destroy();
  });
});
const wss = new WebSocket.Server({ noServer: true, maxPayload: 64 * 1024 });
let flujoEventosMongo = null;
let flujoEventosMongoActivo = false;

function responderJSON(res, status, body, corsHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...corsHeaders
  });
  res.end(JSON.stringify(body));
}

function esOrigenPermitido(origin) {
  if (!origin) return true;
  if (allowedOrigins.has('*') || allowedOrigins.has(origin)) return true;
  if (origin === 'capacitor://localhost' || origin === 'ionic://localhost' || origin === 'http://localhost' || /^http:\/\/localhost(:\d+)?$/.test(origin)) {
    return true;
  }
  for (const pattern of allowedOrigins) {
    if (pattern.includes('*')) {
      const regex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
      if (regex.test(origin)) return true;
    }
  }
  return false;
}

function corsPara(req) {
  const origin = req.headers.origin;
  if (!origin) return {};
  if (!esOrigenPermitido(origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin'
  };
}

function leerJSON(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    let excedido = false;
    req.on('data', chunk => {
      if (excedido) return;
      bytes += chunk.length;
      if (bytes > MAX_AUTH_BODY) {
        excedido = true;
        reject(Object.assign(new Error('La solicitud supera el tamaño permitido.'), { status: 413 }));
        return;
      }
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      if (excedido) return;
      try { resolve(JSON.parse(body || '{}')); }
      catch { reject(Object.assign(new Error('El cuerpo JSON no es válido.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

async function crearSesion(user) {
  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000);
  await SesionModel.create({ sessionId, userId: user._id, expiresAt });
  const token = createToken({ id: user._id, username: user.username, sessionId });
  return { token, expiresAt };
}

async function sesionActiva(claims) {
  if (!claims) return null;
  const session = await SesionModel.findOne({
    sessionId: claims.sessionId,
    userId: claims.id,
    revokedAt: null,
    expiresAt: { $gt: new Date() }
  }).lean();
  return session;
}

function excedeLimiteAuth(ip) {
  const now = Date.now();
  const recientes = (authAttempts.get(ip) || []).filter(timestamp => now - timestamp < AUTH_RATE_WINDOW_MS);
  if (recientes.length >= AUTH_RATE_MAX) {
    authAttempts.set(ip, recientes);
    return true;
  }
  recientes.push(now);
  authAttempts.set(ip, recientes);
  return false;
}

function obtenerBearer(req) {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  return match ? match[1].trim() : '';
}

async function manejarSolicitudHTTP(req, res) {
  const corsHeaders = corsPara(req);
  if (corsHeaders === null) return responderJSON(res, 403, { error: 'Origen no permitido.' });
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders || {});
    return res.end();
  }

  const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && parsed.pathname === '/health') {
    return responderJSON(res, 200, {
      status: 'ok',
      version: '2.8.0',
      database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
      coordination: 'mongodb-atomic-cas',
      instanceId: INSTANCE_ID,
      websocket: 'available'
    }, corsHeaders || {});
  }

  if (req.method === 'GET' && parsed.pathname === '/ready') {
    const database = mongoose.connection.readyState === 1;
    return responderJSON(res, database ? 200 : 503, { status: database ? 'ready' : 'not-ready', version: '2.8.0', database: database ? 'connected' : 'disconnected' }, corsHeaders || {});
  }

  if (req.method === 'GET' && parsed.pathname === '/api/me') {
    const claims = verifyToken(obtenerBearer(req));
    if (!claims || !(await sesionActiva(claims))) return responderJSON(res, 401, { error: 'La sesión no es válida o ha expirado.' }, corsHeaders || {});
    const user = await UsuarioModel.findById(claims.id).select('username createdAt').lean();
    if (!user) return responderJSON(res, 401, { error: 'La cuenta ya no existe.' }, corsHeaders || {});
    return responderJSON(res, 200, {
      user: { id: String(user._id), username: user.username, createdAt: user.createdAt }
    }, corsHeaders || {});
  }

  const historyMatch = req.method === 'GET' && /^\/api\/rooms\/([A-Za-z0-9_-]{1,32})\/history$/.exec(parsed.pathname);
  const replayMatch = req.method === 'GET' && /^\/api\/rooms\/([A-Za-z0-9_-]{1,32})\/replay\/(\d+)$/.exec(parsed.pathname);
  if (historyMatch || replayMatch) {
    const claims = verifyToken(obtenerBearer(req));
    if (!claims || !(await sesionActiva(claims))) {
      return responderJSON(res, 401, { error: 'La sesión no es válida o ha expirado.' }, corsHeaders || {});
    }
    const nombreSala = (historyMatch || replayMatch)[1];
    const salaEnMemoria = salasActivas.get(nombreSala);
    if (salaEnMemoria) await salaEnMemoria.persistencia;
    const doc = await SalaModel.findOne({ nombreSala }).lean();
    if (!doc) return responderJSON(res, 404, { error: 'La sala no existe.' }, corsHeaders || {});

    if (historyMatch) {
      const limiteSolicitado = Number(parsed.searchParams.get('limit')) || 100;
      const limite = Math.min(200, Math.max(1, limiteSolicitado));
      const antesDe = Number(parsed.searchParams.get('before'));
      const filtro = { nombreSala };
      if (Number.isSafeInteger(antesDe) && antesDe > 0) filtro.secuencia = { $lt: antesDe };
      const eventosNuevos = await EventoModel.find(filtro).sort({ secuencia: -1 }).limit(limite).lean();
      const mapaEventos = new Map();
      for (const evento of [...(doc.historial || []), ...eventosNuevos]) {
        if (Number.isSafeInteger(evento.secuencia) && (!Number.isSafeInteger(antesDe) || antesDe <= 0 || evento.secuencia < antesDe)) {
          mapaEventos.set(evento.secuencia, evento);
        }
      }
      const eventos = [...mapaEventos.values()].sort((a, b) => a.secuencia - b.secuencia).slice(-limite);
      return responderJSON(res, 200, {
        sala: nombreSala,
        secuenciaActual: Math.max(Number(doc.secuencia) || 0, salaEnMemoria?.secuencia || 0),
        eventos
      }, corsHeaders || {});
    }

    const secuenciaObjetivo = Number(replayMatch[2]);
    const secuenciaMaxima = await EventoModel.findOne({ nombreSala }).sort({ secuencia: -1 }).select('secuencia').lean();
    const maximo = Math.max(Number(doc.secuencia) || 0, Number(secuenciaMaxima?.secuencia) || 0, salaEnMemoria?.secuencia || 0);
    if (!Number.isSafeInteger(secuenciaObjetivo) || secuenciaObjetivo < 0 || secuenciaObjetivo > maximo) {
      return responderJSON(res, 400, { error: `La secuencia debe estar entre 0 y ${maximo}.` }, corsHeaders || {});
    }
    const checkpoint = await SnapshotModel.findOne({ nombreSala, secuencia: { $lte: secuenciaObjetivo } })
      .sort({ secuencia: -1 }).lean();
    const snapshotBase = checkpoint?.snapshot || doc.snapshot;
    const baseSeq = checkpoint ? checkpoint.secuencia :
      (Number.isFinite(doc.snapshotSecuencia) ? doc.snapshotSecuencia : (Number(doc.secuencia) || 0));
    if (baseSeq > secuenciaObjetivo) {
      return responderJSON(res, 409, { error: 'No existe un checkpoint anterior a esa secuencia.' }, corsHeaders || {});
    }
    const eventos = await EventoModel.find({
      nombreSala,
      secuencia: { $gt: baseSeq, $lte: secuenciaObjetivo }
    }).sort({ secuencia: 1 }).lean();
    const reconstruido = reconstruirSnapshot({ ...snapshotBase, secuencia: baseSeq }, eventos, secuenciaObjetivo);
    return responderJSON(res, 200, {
      sala: nombreSala,
      secuencia: reconstruido.secuencia,
      eventosAplicados: reconstruido.aplicados,
      snapshot: reconstruido.snapshot
    }, corsHeaders || {});
  }

  if (req.method === 'POST' && parsed.pathname === '/api/logout') {
    const claims = verifyToken(obtenerBearer(req));
    if (claims) await SesionModel.updateOne({ sessionId: claims.sessionId, userId: claims.id, revokedAt: null }, { $set: { revokedAt: new Date() } });
    return responderJSON(res, 200, { message: 'Sesión cerrada.' }, corsHeaders || {});
  }

  if (req.method === 'POST' && ['/api/register', '/api/login'].includes(parsed.pathname)) {
    const ip = req.socket.remoteAddress || 'unknown';
    if (excedeLimiteAuth(ip)) {
      return responderJSON(res, 429, { error: 'Demasiados intentos. Espera 15 minutos e inténtalo de nuevo.' }, corsHeaders || {});
    }
    let body;
    try { body = await leerJSON(req); }
    catch (err) { return responderJSON(res, err.status || 400, { error: err.message }, corsHeaders || {}); }

    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!USERNAME_RE.test(username) || /[\u0000-\u001f]/.test(username)) {
      return responderJSON(res, 400, { error: 'El usuario debe tener entre 3 y 24 caracteres. Usa letras, números, punto, guion o guion bajo.' }, corsHeaders || {});
    }
    if (password.length < 8 || password.length > 128) {
      return responderJSON(res, 400, { error: 'La contraseña debe tener entre 8 y 128 caracteres.' }, corsHeaders || {});
    }

    const usernameKey = username.normalize('NFKC').toLocaleLowerCase('es-MX');
    if (parsed.pathname === '/api/register') {
      try {
        const user = await UsuarioModel.create({ username, usernameKey, passwordHash: await hashPassword(password) });
        const session = await crearSesion(user);
        return responderJSON(res, 201, {
          token: session.token,
          expiresAt: session.expiresAt,
          user: { id: String(user._id), username: user.username, createdAt: user.createdAt }
        }, corsHeaders || {});
      } catch (err) {
        if (err.code === 11000) return responderJSON(res, 409, { error: 'Ese nombre de usuario ya está registrado.' }, corsHeaders || {});
        console.error('Error al registrar usuario:', err.message);
        return responderJSON(res, 500, { error: 'No fue posible crear la cuenta.' }, corsHeaders || {});
      }
    }

    const user = await UsuarioModel.findOne({ usernameKey }).select('+passwordHash username createdAt').lean();
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      return responderJSON(res, 401, { error: 'Usuario o contraseña incorrectos.' }, corsHeaders || {});
    }
    const session = await crearSesion(user);
    return responderJSON(res, 200, {
      token: session.token,
      expiresAt: session.expiresAt,
      user: { id: String(user._id), username: user.username, createdAt: user.createdAt }
    }, corsHeaders || {});
  }

  return responderJSON(res, 404, { error: 'Ruta no encontrada.' }, corsHeaders || {});
}

function objetoValido(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return false;
  const tipo = d.tipoObjeto || 'cubo';
  if (!['cubo', 'esfera', 'cilindro'].includes(tipo)) return false;
  const campos = ['x','y','z','rx','ry','rz','sx','sy','sz'];
  for (const k of campos) {
    if (typeof d[k] !== 'number' || !Number.isFinite(d[k])) return false;
  }
  if (['x','y','z'].some(k => Math.abs(d[k]) > 20)) return false;
  if (['rx','ry','rz'].some(k => Math.abs(d[k]) > 100)) return false;
  if (['sx','sy','sz'].some(k => d[k] < 0.2 || d[k] > 3)) return false;
  if (typeof d.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(d.color)) return false;
  if (d.vertexOffsets !== undefined) {
    if (!d.vertexOffsets || typeof d.vertexOffsets !== 'object' || Array.isArray(d.vertexOffsets)) return false;
    const offsets = Object.entries(d.vertexOffsets);
    if (offsets.length > 500) return false;
    const limiteVertices = LIMITES_VERTICES[tipo];
    for (const [indice, offset] of offsets) {
      if (!/^(0|[1-9]\d*)$/.test(indice) || Number(indice) >= limiteVertices ||
          !offset || typeof offset !== 'object' || Array.isArray(offset) ||
          !validarDelta(offset)) return false;
    }
  }
  return true;
}

function snapshotValido(modelos) {
  if (!modelos || typeof modelos !== 'object' || Array.isArray(modelos)) return false;
  const entries = Object.entries(modelos);
  return entries.length <= MAX_OBJECTS && entries.every(([id, datos]) => ID_RE.test(id) && objetoValido(datos));
}

function enviar(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}
function difundir(sala, payload) {
  for (const client of sala.clientes) enviar(client, payload);
}
function error(ws, codigo, mensaje) {
  enviar(ws, { tipo: 'ERROR', codigo, mensaje });
}

async function obtenerOCrearSala(nombreSala) {
  if (salasActivas.has(nombreSala)) return salasActivas.get(nombreSala);
  if (salasEnCarga.has(nombreSala)) return salasEnCarga.get(nombreSala);
  const carga = cargarOCrearSala(nombreSala);
  salasEnCarga.set(nombreSala, carga);
  try {
    return await carga;
  } finally {
    if (salasEnCarga.get(nombreSala) === carga) salasEnCarga.delete(nombreSala);
  }
}

async function cargarOCrearSala(nombreSala) {
  let doc = await SalaModel.findOne({ nombreSala }).lean();
  if (!doc) {
    const inicial = {
      timestamp: Date.now(),
      modelos: {
        Cubo_Principal: {
          tipoObjeto: 'cubo', x: 0, y: 0.5, z: 0, rx: 0, ry: 0, rz: 0,
          sx: 1, sy: 1, sz: 1, color: '#38bdf8'
        }
      }
    };
    try {
      doc = await SalaModel.create({ nombreSala, snapshot: inicial, historial: [], secuencia: 0, snapshotSecuencia: 0 });
      doc = doc.toObject();
      await SnapshotModel.updateOne(
        { nombreSala, secuencia: 0 },
        { $setOnInsert: { nombreSala, secuencia: 0, timestamp: new Date(), snapshot: inicial } },
        { upsert: true }
      );
    } catch (e) {
      if (e.code !== 11000) throw e;
      doc = await SalaModel.findOne({ nombreSala }).lean();
    }
  }

  // Compatibilidad con salas creadas por versiones anteriores: su snapshot
  // representaba el estado completo hasta doc.secuencia.
  const snapshotGuardado = await SnapshotModel.findOne({ nombreSala }).sort({ secuencia: -1 }).lean();
  const secuenciaBase = snapshotGuardado
    ? Number(snapshotGuardado.secuencia) || 0
    : (Number.isFinite(doc.snapshotSecuencia) ? doc.snapshotSecuencia : (Number(doc.secuencia) || 0));
  const base = snapshotGuardado?.snapshot || doc.snapshot;
  if (!snapshotGuardado) {
    await SnapshotModel.updateOne(
      { nombreSala, secuencia: secuenciaBase },
      { $setOnInsert: { nombreSala, secuencia: secuenciaBase, timestamp: new Date(), snapshot: base } },
      { upsert: true }
    );
  }
  const eventosPosteriores = await EventoModel.find({ nombreSala, secuencia: { $gt: secuenciaBase } })
    .sort({ secuencia: 1 }).lean();
  const reconstruido = reconstruirSnapshot({ ...base, secuencia: secuenciaBase }, eventosPosteriores);
  if (!snapshotValido(reconstruido.snapshot.modelos)) {
    throw new Error(`El estado reconstruido de la sala ${nombreSala} no superó la validación.`);
  }

  const historialPersistido = await EventoModel.find({ nombreSala }).sort({ secuencia: -1 }).limit(MAX_HISTORY).lean();
  const historialLegacy = Array.isArray(doc.historial) ? doc.historial : [];
  const porSecuencia = new Map();
  for (const evento of [...historialLegacy, ...historialPersistido]) {
    if (Number.isSafeInteger(evento.secuencia)) porSecuencia.set(evento.secuencia, evento);
  }
  const historial = [...porSecuencia.values()].sort((a, b) => a.secuencia - b.secuencia).slice(-MAX_HISTORY);
  const ultimaSecuenciaEvento = eventosPosteriores.length
    ? eventosPosteriores[eventosPosteriores.length - 1].secuencia
    : secuenciaBase;
  // En standalone, doc.secuencia puede conservar un incremento huérfano si el
  // proceso cayó entre reservar el contador y guardar el evento. La secuencia
  // confirmada es la del checkpoint/evento persistido, no la del contador.
  const secuenciaActual = mongoUsaReplicaSet()
    ? Math.max(Number(doc.secuencia) || 0, reconstruido.secuencia, ultimaSecuenciaEvento)
    : Math.max(reconstruido.secuencia, ultimaSecuenciaEvento);
  if (!mongoUsaReplicaSet() && Number(doc.secuencia) !== secuenciaActual) {
    await SalaModel.updateOne({ nombreSala }, { $set: { secuencia: secuenciaActual } });
  }
  const ahora = Date.now();
  const sala = {
    nombreSala,
    bloqueos: new Map(),
    clientes: new Set(),
    snapshot: reconstruido.snapshot,
    historial,
    secuencia: secuenciaActual,
    secuenciaAplicada: reconstruido.secuencia,
    colaOperacion: Promise.resolve(),
    sincronizandoEventos: false,
    sincronizandoBloqueos: false,
    ultimoHuecoDesde: null,
    snapshotSecuencia: secuenciaBase,
    ultimoSnapshotAt: snapshotGuardado?.timestamp ? new Date(snapshotGuardado.timestamp).getTime() : ahora,
    snapshotPendienteSecuencia: secuenciaBase,
    persistencia: Promise.resolve(),
    errorPersistencia: false
  };
  sala.snapshot.timestamp = ahora;
  salasActivas.set(nombreSala, sala);
  return sala;
}

async function reconstruirSnapshotPersistido(nombreSala, hastaSecuencia) {
  const docSala = await SalaModel.findOne({ nombreSala }).lean();
  if (!docSala) return null;
  const checkpoint = await SnapshotModel.findOne({ nombreSala, secuencia: { $lte: hastaSecuencia } })
    .sort({ secuencia: -1 }).lean();
  const secuenciaBase = checkpoint
    ? Number(checkpoint.secuencia) || 0
    : (Number.isFinite(docSala.snapshotSecuencia) ? docSala.snapshotSecuencia : 0);
  const snapshotBase = checkpoint?.snapshot || docSala.snapshot;
  const eventos = await EventoModel.find({
    nombreSala,
    secuencia: { $gt: secuenciaBase, $lte: hastaSecuencia }
  }).sort({ secuencia: 1 }).lean();
  let esperada = secuenciaBase + 1;
  for (const evento of eventos) {
    if (evento.secuencia !== esperada) return null;
    esperada += 1;
  }
  if (esperada - 1 !== hastaSecuencia) return null;
  const reconstruido = reconstruirSnapshot({ ...snapshotBase, secuencia: secuenciaBase }, eventos, hastaSecuencia);
  if (reconstruido.secuencia !== hastaSecuencia || !snapshotValido(reconstruido.snapshot.modelos)) return null;
  return reconstruido.snapshot;
}

async function obtenerEstadoHistorial(nombreSala) {
  const eventos = await EventoModel.find({ nombreSala })
    .sort({ secuencia: 1 })
    .select('secuencia metadata')
    .lean();
  return calcularEstadoHistorial(eventos);
}

async function persistirSnapshotConsistente(sala, secuencia) {
  if (secuencia <= sala.snapshotSecuencia) return;
  const snapshotConsistente = await reconstruirSnapshotPersistido(sala.nombreSala, secuencia);
  if (!snapshotConsistente) {
    console.warn(`Checkpoint de ${sala.nombreSala} aplazado: todavía falta un evento anterior a la secuencia ${secuencia}.`);
    return;
  }
  await SnapshotModel.updateOne(
    { nombreSala: sala.nombreSala, secuencia },
    { $setOnInsert: { nombreSala: sala.nombreSala, secuencia, timestamp: new Date(), snapshot: snapshotConsistente } },
    { upsert: true }
  );
  // No permitir que un checkpoint atrasado sobrescriba el snapshot de
  // secuencia más alta si otra instancia terminó de persistir primero.
  await SalaModel.updateOne(
    {
      nombreSala: sala.nombreSala,
      $or: [
        { snapshotSecuencia: { $lt: secuencia } },
        { snapshotSecuencia: { $exists: false } }
      ]
    },
    { $set: { snapshot: snapshotConsistente, snapshotSecuencia: secuencia }, $max: { secuencia } }
  );
  sala.snapshotSecuencia = Math.max(sala.snapshotSecuencia, secuencia);
  sala.ultimoSnapshotAt = Date.now();
}

function guardarSnapshotEnCola(sala, secuencia) {
  sala.snapshotPendienteSecuencia = Math.max(sala.snapshotPendienteSecuencia || 0, secuencia);
  const trabajo = sala.persistencia.catch(err => {
    console.error('Error de persistencia anterior:', err.message);
  }).then(() => persistirSnapshotConsistente(sala, secuencia));
  sala.persistencia = trabajo.catch(err => {
    sala.errorPersistencia = true;
    console.error(`No se pudo guardar el snapshot de ${sala.nombreSala}:`, err.message);
    throw err;
  });
  return trabajo;
}

function mongoUsaReplicaSet() {
  const tipoTopologia = mongoose.connection.getClient()?.topology?.description?.type || '';
  return tipoTopologia.startsWith('ReplicaSet');
}

async function reservarYGuardarEvento(sala, baseEvento) {
  if (mongoUsaReplicaSet()) {
    // En el modo multi-instancia, reservar la secuencia e insertar el evento
    // en una sola transacción. Así, una caída entre ambas operaciones no deja
    // huecos que impidan reproducir el Event Store en los demás procesos.
    const session = await mongoose.startSession();
    let eventoConfirmado = null;
    try {
      await session.withTransaction(async () => {
        const contador = await SalaModel.findOneAndUpdate(
          { nombreSala: sala.nombreSala },
          { $inc: { secuencia: 1 } },
          { new: true, projection: { secuencia: 1 }, session }
        ).lean();
        if (!contador) throw new Error(`No se pudo reservar una secuencia para ${sala.nombreSala}.`);
        const evento = { ...baseEvento, secuencia: Number(contador.secuencia) };
        await EventoModel.updateOne(
          { nombreSala: sala.nombreSala, secuencia: evento.secuencia },
          { $setOnInsert: evento },
          { upsert: true, session }
        );
        eventoConfirmado = evento;
      });
    } finally {
      await session.endSession();
    }
    if (!eventoConfirmado) throw new Error('La transacción del evento terminó sin confirmar el registro.');
    return eventoConfirmado;
  }

  // En standalone se permite una sola instancia del backend y las operaciones
  // de la sala se serializan localmente. La secuencia se deriva del último
  // evento confirmado/checkpoint, no del contador (que pudo quedar adelantado
  // por una caída anterior entre el incremento y la inserción del evento).
  const ultimoEvento = await EventoModel.findOne({ nombreSala: sala.nombreSala })
    .sort({ secuencia: -1 }).select('secuencia').lean();
  const evento = { ...baseEvento, secuencia: siguienteSecuenciaConfirmada(
    Number(sala.snapshotSecuencia) || 0, Number(ultimoEvento?.secuencia) || 0
  ) };
  await EventoModel.create(evento);
  // El estado de sala refleja el último evento confirmado. Si este update falla,
  // el próximo arranque recupera la secuencia desde el Event Store.
  await SalaModel.updateOne(
    { nombreSala: sala.nombreSala },
    { $set: { secuencia: evento.secuencia } }
  );
  return evento;
}

async function registrarEvento(sala, tipo, ws, idObjeto, antes, despues, metadata = null) {
  sala.snapshot.timestamp = Date.now();
  const baseEvento = {
    nombreSala: sala.nombreSala,
    eventoId: crypto.randomUUID(),
    instanciaId: INSTANCE_ID,
    tipo,
    idObjeto: idObjeto || null,
    usuario: ws.nombreUsuario,
    clienteId: ws.clienteId,
    timestamp: new Date().toISOString(),
    antes: antes == null ? null : clonar(antes),
    despues: despues == null ? null : clonar(despues),
    metadata: metadata == null ? null : clonar(metadata)
  };
  let evento;
  try {
    evento = await reservarYGuardarEvento(sala, baseEvento);
  } catch (err) {
    // El snapshot en memoria ya pudo cambiar antes de registrar el evento.
    // Entrar en solo lectura evita aceptar más escrituras sin persistencia.
    sala.errorPersistencia = true;
    console.error(`La sala ${sala.nombreSala} quedó en modo solo lectura por un error del Event Store:`, err.message);
    throw err;
  }
  const secuencia = evento.secuencia;
  sala.secuencia = Math.max(sala.secuencia, secuencia);
  sala.historial.push(evento);
  if (sala.historial.length > MAX_HISTORY) sala.historial.splice(0, sala.historial.length - MAX_HISTORY);
  const checkpointPendiente = secuencia - Math.max(sala.snapshotSecuencia, sala.snapshotPendienteSecuencia || 0) >= SNAPSHOT_EVERY_EVENTS ||
    Date.now() - sala.ultimoSnapshotAt >= SNAPSHOT_INTERVAL_MS;
  if (checkpointPendiente) {
    sala.snapshotPendienteSecuencia = Math.max(sala.snapshotPendienteSecuencia || 0, secuencia);
    const trabajo = sala.persistencia.catch(err => {
      console.error('Error de persistencia anterior:', err.message);
    }).then(() => persistirSnapshotConsistente(sala, secuencia));
    sala.persistencia = trabajo.catch(err => {
      sala.errorPersistencia = true;
      console.error(`La sala ${sala.nombreSala} quedó en modo solo lectura por un error de persistencia:`, err.message);
      throw err;
    });
    await sala.persistencia;
  }
  return evento;
}

function notificarBloqueoLiberado(sala, llave, lock, extra = {}) {
  const recurso = analizarClave(llave);
  if (!recurso || recurso.tipoRecurso === 'sala') return;
  if (recurso.tipoRecurso === 'elemento') {
    difundir(sala, {
      tipo: 'BLOQUEO_ELEMENTO_LIBERADO',
      idComponente: recurso.idComponente,
      tipoElemento: recurso.tipoElemento,
      indiceElemento: recurso.indiceElemento,
      usuario: lock.usuario,
      clienteId: lock.clienteId,
      ...extra
    });
  } else {
    difundir(sala, {
      tipo: 'BLOQUEO_LIBERADO',
      idComponente: recurso.idComponente,
      usuario: lock.usuario,
      clienteId: lock.clienteId,
      ...extra
    });
  }
}

function payloadBloqueoOcupado(llave, lock) {
  const recurso = analizarClave(llave);
  if (!recurso || recurso.tipoRecurso === 'sala') return null;
  if (recurso.tipoRecurso === 'elemento') {
    return {
      tipo: 'BLOQUEO_ELEMENTO_OCUPADO',
      idComponente: recurso.idComponente,
      tipoElemento: recurso.tipoElemento,
      indiceElemento: recurso.indiceElemento,
      usuario: lock.usuario,
      clienteId: lock.clienteId
    };
  }
  return {
    tipo: 'BLOQUEO_OCUPADO',
    idComponente: recurso.idComponente,
    usuario: lock.usuario,
    clienteId: lock.clienteId
  };
}

async function sincronizarBloqueosSala(sala, emitir = true) {
  const nuevos = await almacenBloqueos.obtener(sala.nombreSala);
  const anteriores = sala.bloqueos || new Map();
  if (emitir) {
    for (const [llave, anterior] of anteriores.entries()) {
      const actual = nuevos.get(llave);
      if (!actual || actual.clienteId !== anterior.clienteId) {
        notificarBloqueoLiberado(sala, llave, anterior, { reemplazado: Boolean(actual) });
      }
    }
    for (const [llave, actual] of nuevos.entries()) {
      const anterior = anteriores.get(llave);
      if (!anterior || anterior.clienteId !== actual.clienteId) {
        const payload = payloadBloqueoOcupado(llave, actual);
        if (payload) difundir(sala, payload);
      }
    }
  }
  sala.bloqueos = nuevos;
  return nuevos;
}

function encolarOperacionSala(sala, trabajo) {
  const anterior = sala.colaOperacion || Promise.resolve();
  const siguiente = anterior.catch(() => {}).then(trabajo);
  sala.colaOperacion = siguiente.catch(err => {
    console.error(`Error en cola de operaciones de ${sala.nombreSala}:`, err.message);
  });
  return siguiente;
}

function payloadEventoRemoto(evento) {
  const base = { usuario: evento.usuario, secuencia: evento.secuencia, metadata: evento.metadata || null };
  switch (evento.tipo) {
    case 'CREAR_CUBO':
      return { ...base, tipo: 'NUEVO_CUBO_CREADO', id: evento.idObjeto, datos: evento.despues };
    case 'DUPLICAR_CUBO':
      return { ...base, tipo: 'CUBO_DUPLICADO', id: evento.idObjeto, datos: evento.despues };
    case 'ELIMINAR_CUBO':
      return { ...base, tipo: 'CUBO_ELIMINADO', id: evento.idObjeto };
    case 'TRANSFORMACION_DELTA':
      return { ...base, tipo: 'APLICAR_DELTA', idComponente: evento.idObjeto, delta: evento.despues };
    case 'EDICION_GEOMETRICA': {
      const despues = evento.despues || {};
      return {
        ...base,
        tipo: 'SUBELEMENTO_GEOMETRIA_ACTUALIZADA',
        idComponente: evento.idObjeto,
        tipoElemento: despues.tipoElemento,
        indiceElemento: despues.indiceElemento,
        verticesLogicos: Object.keys(despues.vertexOffsets || {}).map(Number),
        delta: despues.delta || { x: 0, y: 0, z: 0 }
      };
    }
    case 'IMPORTAR_MODELO':
    case 'DESHACER':
    case 'REHACER':
      return { ...base, tipo: 'MODELO_IMPORTADO', modelos: evento.despues, metadata: evento.metadata || null };
    default:
      return null;
  }
}

async function sincronizarEventosSala(sala) {
  if (sala.sincronizandoEventos) return;
  sala.sincronizandoEventos = true;
  try {
    await encolarOperacionSala(sala, async () => {
      const cursor = Number(sala.secuenciaAplicada) || 0;
      const eventos = await EventoModel.find({ nombreSala: sala.nombreSala, secuencia: { $gt: cursor } })
        .sort({ secuencia: 1 }).limit(200).lean();
      let aplicada = cursor;
      for (const evento of eventos) {
        if (evento.secuencia <= aplicada) continue;
        if (evento.secuencia > aplicada + 1) {
          if (!sala.ultimoHuecoDesde) sala.ultimoHuecoDesde = Date.now();
          if (Date.now() - sala.ultimoHuecoDesde >= 15000) {
            console.error(`La sala ${sala.nombreSala} tiene un hueco persistente en la secuencia ${aplicada + 1}; se pausa la reproducción para no aplicar eventos fuera de orden.`);
          }
          // No saltar secuencias ausentes: hacerlo dejaría snapshots distintos
          // entre instancias. En replica set los nuevos eventos se confirman
          // junto con el contador mediante transacción.
          break;
        }
        sala.snapshot = aplicarEvento(sala.snapshot, evento);
        sala.secuencia = Math.max(sala.secuencia, evento.secuencia);
        if (!sala.historial.some(item => item.eventoId === evento.eventoId)) sala.historial.push(evento);
        if (sala.historial.length > MAX_HISTORY) sala.historial.splice(0, sala.historial.length - MAX_HISTORY);
        if (evento.instanciaId !== INSTANCE_ID) {
          const payload = payloadEventoRemoto(evento);
          if (payload) difundir(sala, payload);
        }
        aplicada = evento.secuencia;
        sala.ultimoHuecoDesde = null;
      }
      sala.secuenciaAplicada = aplicada;
    });
  } catch (err) {
    console.error(`No se pudo sincronizar la sala ${sala.nombreSala}:`, err.message);
  } finally {
    sala.sincronizandoEventos = false;
  }
}

function iniciarFlujoEventosMongo() {
  if (!mongoUsaReplicaSet() || flujoEventosMongoActivo || mongoose.connection.readyState !== 1) return false;
  let stream;
  try {
    stream = EventoModel.watch(
      [{ $match: { operationType: 'insert' } }],
      { fullDocument: 'updateLookup', maxAwaitTimeMS: 1000 }
    );
  } catch (err) {
    console.error('No se pudo iniciar Change Stream; se usará el sondeo de respaldo:', err.message);
    return false;
  }
  flujoEventosMongo = stream;
  flujoEventosMongoActivo = true;
  stream.on('change', cambio => {
    const nombreSala = cambio.fullDocument?.nombreSala;
    const sala = nombreSala ? salasActivas.get(nombreSala) : null;
    if (sala && sala.clientes.size > 0) sincronizarEventosSala(sala).catch(err => {
      console.error(`No se pudo aplicar un cambio remoto en ${nombreSala}:`, err.message);
    });
  });
  stream.on('error', err => {
    if (flujoEventosMongo === stream) {
      flujoEventosMongo = null;
      flujoEventosMongoActivo = false;
    }
    console.error('Change Stream interrumpido; se activa el sondeo de respaldo:', err.message);
    stream.close().catch(() => {});
  });
  stream.on('close', () => {
    if (flujoEventosMongo === stream) {
      flujoEventosMongo = null;
      flujoEventosMongoActivo = false;
    }
  });
  console.log('Change Streams de MongoDB habilitados para propagar eventos entre instancias.');
  return true;
}

async function liberarBloqueosCliente(sala, ws) {
  await almacenBloqueos.liberarCliente(sala.nombreSala, ws.clienteId);
  await sincronizarBloqueosSala(sala);
}

function validarId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

function validarSubelemento(modelo, tipoElemento, indiceElemento) {
  return Boolean(modelo && validarIndiceElemento(modelo.tipoObjeto || 'cubo', tipoElemento, indiceElemento));
}

function rechazarUpgrade(socket, status, message) {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

httpServer.on('upgrade', async (req, socket, head) => {
  try {
    const corsHeaders = corsPara(req);
    if (corsHeaders === null) return rechazarUpgrade(socket, 403, 'Forbidden');
    const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const nombreSala = parsed.searchParams.get('sala') || 'sala-general';
    if (!ROOM_RE.test(nombreSala)) return rechazarUpgrade(socket, 400, 'Invalid Room');
    const claims = verifyToken(parsed.searchParams.get('token') || '');
    if (!claims || !(await sesionActiva(claims))) return rechazarUpgrade(socket, 401, 'Unauthorized');
    const user = await UsuarioModel.findById(claims.id).select('username').lean();
    if (!user) return rechazarUpgrade(socket, 401, 'Unauthorized');
    req.nombreSala = nombreSala;
    req.authUser = { ...claims, username: user.username };
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  } catch (err) {
    console.error('No se pudo autenticar el WebSocket:', err.message);
    if (socket.writable) rechazarUpgrade(socket, 500, 'Internal Server Error');
  }
});

wss.on('connection', async (ws, req) => {
  let sala;
  try {
    const nombreSala = req.nombreSala;
    const nombreUsuario = req.authUser.username;
    sala = await obtenerOCrearSala(nombreSala);
    await sincronizarEventosSala(sala);
    ws.nombreSala = nombreSala;
    ws.nombreUsuario = nombreUsuario;
    ws.usuarioId = req.authUser.id;
    ws.clienteId = crypto.randomUUID();
    sala.clientes.add(ws);
    await sincronizarBloqueosSala(sala, false);
    const controlHistorial = await obtenerEstadoHistorial(nombreSala);

    enviar(ws, {
      tipo: 'INICIALIZAR_ESTADO',
      snapshot: sala.snapshot,
      historial: sala.historial.slice(-100),
      secuencia: sala.secuencia,
      controlHistorial,
      instanciaId: INSTANCE_ID,
      clienteId: ws.clienteId
    });
    for (const [llave, lock] of sala.bloqueos.entries()) {
      const payload = payloadBloqueoOcupado(llave, lock);
      if (payload) enviar(ws, payload);
    }
    difundir(sala, { tipo: 'USUARIO_CONECTADO', usuario: nombreUsuario, clienteId: ws.clienteId });
  } catch (err) {
    console.error('No se pudo inicializar la conexión:', err);
    error(ws, 'ERROR_SALA', 'No fue posible cargar la sala. Intenta nuevamente.');
    ws.close(1011, 'Error de sala');
    return;
  }

  ws.on('message', raw => {
    encolarOperacionSala(sala, async () => {
    try {
      const data = JSON.parse(raw.toString());
      if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.tipo !== 'string') {
        return error(ws, 'MENSAJE_INVALIDO', 'Formato de mensaje no válido.');
      }
      if (sala.errorPersistencia && !['RENOVAR_BLOQUEO_ELEMENTO', 'LIBERAR_BLOQUEO_ELEMENTO', 'LIBERAR_BLOQUEO'].includes(data.tipo)) {
        return error(ws, 'PERSISTENCIA_NO_DISPONIBLE', 'La sala está en modo solo lectura porque falló el guardado. Reconéctate cuando MongoDB esté disponible.');
      }
      const id = data.id || data.idComponente;
      switch (data.tipo) {
        case 'PING': {
          const nonce = typeof data.nonce === 'string' && data.nonce.length <= 128 ? data.nonce : '';
          enviar(ws, { tipo: 'PONG', nonce, serverTime: Date.now() });
          break;
        }
        case 'CREAR_CUBO':
        case 'DUPLICAR_CUBO': {
          if (!validarId(data.id) || !objetoValido(data.datos || data.pos)) {
            return error(ws, 'DATOS_INVALIDOS', 'El identificador o las propiedades del objeto no son válidos.');
          }
          if (Object.keys(sala.snapshot.modelos).length >= MAX_OBJECTS) {
            return error(ws, 'LIMITE_OBJETOS', `La sala admite como máximo ${MAX_OBJECTS} objetos.`);
          }
          if (sala.snapshot.modelos[data.id]) return error(ws, 'ID_DUPLICADO', 'Ya existe un objeto con ese identificador.');
          const propietario = { clienteId: ws.clienteId, usuario: ws.nombreUsuario };
          const reserva = await almacenBloqueos.adquirir(
            sala.nombreSala, { tipoRecurso: 'objeto', idComponente: data.id }, propietario, LOCK_TTL_MS
          );
          await sincronizarBloqueosSala(sala);
          if (!reserva.valor.ok) {
            return error(ws, 'SALA_EN_EDICION', `No se puede crear el objeto mientras ${reserva.valor.conflicto.lock.usuario} tenga reservada la sala.`);
          }
          try {
            const datos = data.datos || data.pos;
            sala.snapshot.modelos[data.id] = datos;
            await registrarEvento(sala, data.tipo, ws, data.id, null, datos);
            difundir(sala, { tipo: data.tipo === 'CREAR_CUBO' ? 'NUEVO_CUBO_CREADO' : 'CUBO_DUPLICADO', id: data.id, datos, usuario: ws.nombreUsuario, secuencia: sala.secuencia });
          } finally {
            await almacenBloqueos.liberar(sala.nombreSala, claveObjeto(data.id), ws.clienteId);
            await sincronizarBloqueosSala(sala);
          }
          break;
        }
        case 'ELIMINAR_CUBO': {
          if (!validarId(id) || !sala.snapshot.modelos[id]) return error(ws, 'OBJETO_NO_EXISTE', 'El objeto que intentas eliminar no existe.');
          const reserva = await almacenBloqueos.eliminarObjetoSiLibre(
            sala.nombreSala, id, { clienteId: ws.clienteId, usuario: ws.nombreUsuario }, LOCK_TTL_MS
          );
          await sincronizarBloqueosSala(sala);
          if (!reserva.valor.ok) return error(ws, 'OBJETO_BLOQUEADO', `El objeto o uno de sus subelementos está siendo editado por ${reserva.valor.conflicto.lock.usuario}.`);
          const antes = sala.snapshot.modelos[id];
          delete sala.snapshot.modelos[id];
          await registrarEvento(sala, 'ELIMINAR_CUBO', ws, id, antes, null);
          await almacenBloqueos.liberar(sala.nombreSala, claveObjeto(id), ws.clienteId);
          await sincronizarBloqueosSala(sala);
          difundir(sala, { tipo: 'CUBO_ELIMINADO', id, usuario: ws.nombreUsuario, secuencia: sala.secuencia });
          break;
        }
        case 'SOLICITAR_BLOQUEO': {
          const idObjeto = data.idComponente;
          if (!validarId(idObjeto) || !sala.snapshot.modelos[idObjeto]) return error(ws, 'OBJETO_NO_EXISTE', 'No se puede bloquear un objeto inexistente.');
          const recurso = { tipoRecurso: 'objeto', idComponente: idObjeto };
          const resultado = await almacenBloqueos.adquirir(sala.nombreSala, recurso, { clienteId: ws.clienteId, usuario: ws.nombreUsuario }, LOCK_TTL_MS);
          await sincronizarBloqueosSala(sala);
          if (!resultado.valor.ok) {
            enviar(ws, { tipo: 'BLOQUEO_DENEGADO', idComponente: idObjeto, usuario: resultado.valor.conflicto.lock.usuario });
          } else {
            enviar(ws, { tipo: 'BLOQUEO_CONCEDIDO', idComponente: idObjeto, venceEn: LOCK_TTL_MS });
          }
          break;
        }
        case 'SOLICITAR_BLOQUEO_ELEMENTO': {
          const idObjeto = data.idComponente;
          const tipoElemento = data.tipoElemento;
          const indiceElemento = data.indiceElemento;
          const modelo = sala.snapshot.modelos[idObjeto];
          if (!validarId(idObjeto) || !modelo) return error(ws, 'OBJETO_NO_EXISTE', 'No se puede bloquear un elemento de un objeto inexistente.');
          if (!validarSubelemento(modelo, tipoElemento, indiceElemento)) {
            return error(ws, 'SUBELEMENTO_INVALIDO', 'El tipo o índice del subelemento no corresponde a la geometría seleccionada.');
          }
          if (!validarBloqueoGeometrico(modelo, data)) {
            return error(ws, 'GEOMETRIA_INVALIDA', 'La selección geométrica no es válida. Vuelve a seleccionar la cara o el vértice.');
          }
          const recurso = {
            tipoRecurso: 'elemento', idComponente: idObjeto, tipoElemento, indiceElemento,
            verticesLogicos: data.verticesLogicos,
            indicesGeometria: data.indicesGeometria
          };
          const resultado = await almacenBloqueos.adquirir(sala.nombreSala, recurso, { clienteId: ws.clienteId, usuario: ws.nombreUsuario }, LOCK_TTL_MS);
          await sincronizarBloqueosSala(sala);
          const datosElemento = { idComponente: idObjeto, tipoElemento, indiceElemento };
          if (!resultado.valor.ok) {
            enviar(ws, { tipo: 'BLOQUEO_ELEMENTO_DENEGADO', ...datosElemento, usuario: resultado.valor.conflicto.lock.usuario });
          } else {
            enviar(ws, { tipo: 'BLOQUEO_ELEMENTO_CONCEDIDO', ...datosElemento, venceEn: LOCK_TTL_MS });
          }
          break;
        }
        case 'APLICAR_EDICION_GEOMETRICA': {
          const { idComponente, tipoElemento, indiceElemento, verticesLogicos, indicesGeometria, delta } = data;
          const modelo = sala.snapshot.modelos[idComponente];
          if (!validarId(idComponente) || !modelo || !validarSubelemento(modelo, tipoElemento, indiceElemento) ||
              !validarBloqueoGeometrico(modelo, data) || !validarDelta(delta)) {
            return error(ws, 'EDICION_GEOMETRICA_INVALIDA', 'Los datos de la modificación geométrica no son válidos.');
          }
          const llave = claveElemento(idComponente, tipoElemento, indiceElemento);
          const renovacion = await almacenBloqueos.renovar(sala.nombreSala, llave, ws.clienteId, LOCK_TTL_MS);
          await sincronizarBloqueosSala(sala);
          const lock = sala.bloqueos.get(llave);
          if (!renovacion.valor || !lock || lock.clienteId !== ws.clienteId ||
              !mismaLista(lock.verticesLogicos, verticesLogicos) ||
              !mismaLista(lock.indicesGeometria, indicesGeometria)) {
            return error(ws, 'SIN_BLOQUEO_ELEMENTO', 'Necesitas tener el bloqueo vigente de esa cara o vértice para modificarlo.');
          }
          const cambios = aplicarOffsetsVertices(modelo, verticesLogicos, delta);
          const antes = { tipoElemento, indiceElemento, vertexOffsets: cambios.antes };
          const despues = { tipoElemento, indiceElemento, vertexOffsets: cambios.despues, delta: { x: delta.x, y: delta.y, z: delta.z } };
          await registrarEvento(sala, 'EDICION_GEOMETRICA', ws, idComponente, antes, despues);
          difundir(sala, {
            tipo: 'SUBELEMENTO_GEOMETRIA_ACTUALIZADA', idComponente, tipoElemento, indiceElemento,
            verticesLogicos, indicesGeometria, delta: despues.delta,
            usuario: ws.nombreUsuario, secuencia: sala.secuencia
          });
          break;
        }
        case 'RENOVAR_BLOQUEO_ELEMENTO': {
          const { idComponente, tipoElemento, indiceElemento } = data;
          if (!validarId(idComponente) || !validarSubelemento(sala.snapshot.modelos[idComponente], tipoElemento, indiceElemento)) return;
          const llave = claveElemento(idComponente, tipoElemento, indiceElemento);
          const renovacion = await almacenBloqueos.renovar(sala.nombreSala, llave, ws.clienteId, LOCK_TTL_MS);
          await sincronizarBloqueosSala(sala);
          if (renovacion.valor) {
            enviar(ws, { tipo: 'BLOQUEO_ELEMENTO_RENOVADO', idComponente, tipoElemento, indiceElemento, venceEn: LOCK_TTL_MS });
          } else {
            enviar(ws, { tipo: 'BLOQUEO_ELEMENTO_LIBERADO', idComponente, tipoElemento, indiceElemento, usuario: '', clienteId: ws.clienteId, expirado: true });
          }
          break;
        }
        case 'LIBERAR_BLOQUEO_ELEMENTO': {
          const { idComponente, tipoElemento, indiceElemento } = data;
          if (!validarId(idComponente) || !['cara', 'vertice'].includes(tipoElemento) || !Number.isInteger(indiceElemento)) return;
          const llave = claveElemento(idComponente, tipoElemento, indiceElemento);
          await almacenBloqueos.liberar(sala.nombreSala, llave, ws.clienteId);
          await sincronizarBloqueosSala(sala);
          break;
        }
        case 'TRANSFORMACION_DELTA': {
          const idObjeto = data.idComponente;
          if (!validarId(idObjeto) || !sala.snapshot.modelos[idObjeto] || !objetoValido(data.delta)) {
            return error(ws, 'TRANSFORMACION_INVALIDA', 'La transformación contiene valores fuera de rango o un objeto inexistente.');
          }
          const llave = claveObjeto(idObjeto);
          const renovacion = await almacenBloqueos.renovar(sala.nombreSala, llave, ws.clienteId, LOCK_TTL_MS);
          await sincronizarBloqueosSala(sala);
          if (!renovacion.valor) return error(ws, 'SIN_BLOQUEO', 'Debes obtener el bloqueo del objeto antes de modificarlo.');
          const antes = sala.snapshot.modelos[idObjeto];
          sala.snapshot.modelos[idObjeto] = data.delta;
          await registrarEvento(sala, 'TRANSFORMACION_DELTA', ws, idObjeto, antes, data.delta);
          difundir(sala, { tipo: 'APLICAR_DELTA', idComponente: idObjeto, delta: data.delta, usuario: ws.nombreUsuario, secuencia: sala.secuencia });
          break;
        }
        case 'LIBERAR_BLOQUEO': {
          if (!validarId(data.idComponente)) return;
          await almacenBloqueos.liberar(sala.nombreSala, claveObjeto(data.idComponente), ws.clienteId);
          await sincronizarBloqueosSala(sala);
          break;
        }
        case 'IMPORTAR_MODELO': {
          if (!snapshotValido(data.modelos)) return error(ws, 'IMPORTACION_INVALIDA', 'El JSON no es válido o supera los límites permitidos.');
          const accionHistorial = ['deshacer', 'rehacer'].includes(data.accionHistorial) ? data.accionHistorial : null;
          let metadataHistorial = null;
          let secuenciaObjetivo = null;
          let secuenciaBase = null;
          let snapshotActual = null;

          if (accionHistorial) {
            const docSala = await SalaModel.findOne({ nombreSala: sala.nombreSala }).select('secuencia').lean();
            const eventoMaximo = await EventoModel.findOne({ nombreSala: sala.nombreSala }).sort({ secuencia: -1 }).select('secuencia').lean();
            const secuenciaActual = Math.max(Number(docSala?.secuencia) || 0, Number(eventoMaximo?.secuencia) || 0, sala.secuencia || 0);
            secuenciaBase = Number(data.secuenciaBase);
            secuenciaObjetivo = Number(data.secuenciaObjetivo);
            if (!Number.isSafeInteger(secuenciaBase) || secuenciaBase !== secuenciaActual) {
              return error(ws, 'HISTORIAL_DESACTUALIZADO', 'La sala cambió mientras preparabas la operación. Actualiza el historial e inténtalo nuevamente.');
            }
            if (!Number.isSafeInteger(secuenciaObjetivo) || secuenciaObjetivo < 0 || secuenciaObjetivo >= secuenciaActual) {
              return error(ws, 'HISTORIAL_INVALIDO', 'La versión solicitada no es válida.');
            }
            const estadoHistorial = await obtenerEstadoHistorial(sala.nombreSala);
            const accion = siguienteAccionHistorial(estadoHistorial, accionHistorial);
            if (!accion.ok || accion.secuenciaObjetivo !== secuenciaObjetivo) {
              return error(ws, 'HISTORIAL_DESACTUALIZADO', accion.motivo || 'La pila de historial cambió. Actualiza e inténtalo nuevamente.');
            }
            snapshotActual = await reconstruirSnapshotPersistido(sala.nombreSala, secuenciaActual);
            const snapshotObjetivo = await reconstruirSnapshotPersistido(sala.nombreSala, secuenciaObjetivo);
            if (!snapshotActual || !snapshotObjetivo || !snapshotValido(snapshotObjetivo.modelos)) {
              return error(ws, 'HISTORIAL_NO_DISPONIBLE', 'No se pudo reconstruir la versión solicitada.');
            }
            data.modelos = snapshotObjetivo.modelos;
            metadataHistorial = { accionHistorial, secuenciaObjetivo, secuenciaBase };
          }

          const propietario = { clienteId: ws.clienteId, usuario: ws.nombreUsuario };
          const reservaSala = await almacenBloqueos.adquirir(sala.nombreSala, { tipoRecurso: 'sala' }, propietario, LOCK_TTL_MS);
          await sincronizarBloqueosSala(sala);
          if (!reservaSala.valor.ok) {
            return error(ws, 'SALA_EN_EDICION', `No se puede importar mientras ${reservaSala.valor.conflicto.lock.usuario} tenga un objeto o subelemento bloqueado.`);
          }
          try {
            if (accionHistorial) {
              // Revalidar bajo el bloqueo de sala: otra instancia pudo terminar
              // una edición entre la primera lectura y la adquisición del lock.
              const docBloqueado = await SalaModel.findOne({ nombreSala: sala.nombreSala }).select('secuencia').lean();
              const eventoBloqueado = await EventoModel.findOne({ nombreSala: sala.nombreSala }).sort({ secuencia: -1 }).select('secuencia').lean();
              const secuenciaBloqueada = Math.max(Number(docBloqueado?.secuencia) || 0, Number(eventoBloqueado?.secuencia) || 0);
              if (secuenciaBloqueada !== secuenciaBase) {
                return error(ws, 'HISTORIAL_DESACTUALIZADO', 'La sala cambió antes de reservarla. Actualiza el historial e inténtalo nuevamente.');
              }
            }
            if (snapshotActual) {
              sala.snapshot = clonar(snapshotActual);
              sala.secuencia = Math.max(sala.secuencia, secuenciaBase);
              sala.secuenciaAplicada = Math.max(sala.secuenciaAplicada || 0, secuenciaBase);
            }
            const antes = clonar(sala.snapshot.modelos);
            sala.snapshot.modelos = data.modelos;
            await almacenBloqueos.liberarClienteExcepto(sala.nombreSala, ws.clienteId, [claveSala()]);
            const tipoEvento = accionHistorial === 'deshacer' ? 'DESHACER' : (accionHistorial === 'rehacer' ? 'REHACER' : 'IMPORTAR_MODELO');
            await registrarEvento(sala, tipoEvento, ws, null, antes, data.modelos, metadataHistorial);
            await sincronizarBloqueosSala(sala);
            difundir(sala, {
              tipo: 'MODELO_IMPORTADO', modelos: data.modelos, usuario: ws.nombreUsuario,
              secuencia: sala.secuencia, metadata: metadataHistorial
            });
          } finally {
            await almacenBloqueos.liberar(sala.nombreSala, claveSala(), ws.clienteId);
            await sincronizarBloqueosSala(sala);
          }
          break;
        }
        default:
          error(ws, 'ACCION_DESCONOCIDA', 'La acción solicitada no está permitida.');
      }
    } catch (err) {
      console.error('Error procesando mensaje:', err);
      error(ws, 'ERROR_INTERNO', 'Ocurrió un error al procesar la operación.');
    }
    });
  });

  ws.on('close', () => {
    sala.clientes.delete(ws);
    encolarOperacionSala(sala, async () => {
      await liberarBloqueosCliente(sala, ws);
      difundir(sala, { tipo: 'USUARIO_DESCONECTADO', usuario: ws.nombreUsuario });
    }).catch(err => console.error('No se pudieron liberar los bloqueos al desconectar:', err.message));
  });
  ws.on('error', err => console.error('Error WebSocket:', err.message));
});

setInterval(async () => {
  for (const sala of salasActivas.values()) {
    if (sala.sincronizandoBloqueos) continue;
    sala.sincronizandoBloqueos = true;
    try {
      await almacenBloqueos.expirar(sala.nombreSala);
      await sincronizarBloqueosSala(sala);
    } catch (err) {
      console.error(`No se pudieron sincronizar bloqueos de ${sala.nombreSala}:`, err.message);
    } finally {
      sala.sincronizandoBloqueos = false;
    }
  }
}, SYNC_LOCKS_INTERVAL_MS).unref();

// Cada instancia consulta el registro de eventos compartido en MongoDB. Así,
// los clientes conectados a procesos distintos reciben las mismas mutaciones.
setInterval(() => {
  // En replica set los Change Streams dan propagación inmediata. El sondeo se
  // conserva como respaldo y para instalaciones locales standalone.
  if (flujoEventosMongoActivo) return;
  for (const sala of salasActivas.values()) {
    if (sala.clientes.size > 0) sincronizarEventosSala(sala).catch(() => {});
  }
}, SYNC_EVENTS_INTERVAL_MS).unref();

setInterval(() => {
  if (mongoose.connection.readyState === 1 && mongoUsaReplicaSet() && !flujoEventosMongoActivo) {
    iniciarFlujoEventosMongo();
  }
}, 5000).unref();

setInterval(() => {
  for (const sala of salasActivas.values()) {
    const secuenciaPendiente = Math.max(sala.snapshotSecuencia || 0, sala.snapshotPendienteSecuencia || 0);
    if (!sala.errorPersistencia && sala.secuencia > secuenciaPendiente && Date.now() - sala.ultimoSnapshotAt >= SNAPSHOT_INTERVAL_MS) {
      const secuencia = sala.secuencia;
      guardarSnapshotEnCola(sala, secuencia).catch(() => {});
    }
  }
}, 5000).unref();

setInterval(() => {
  const now = Date.now();
  for (const [ip, attempts] of authAttempts.entries()) {
    const remaining = attempts.filter(timestamp => now - timestamp < AUTH_RATE_WINDOW_MS);
    if (remaining.length) authAttempts.set(ip, remaining);
    else authAttempts.delete(ip);
  }
}, AUTH_RATE_WINDOW_MS).unref();

mongoose.connect(MONGO_URI)
  .then(async () => {
    await Promise.all([SalaModel.init(), EventoModel.init(), SnapshotModel.init(), BloqueoSalaModel.init(), UsuarioModel.init(), SesionModel.init()]);
    iniciarFlujoEventosMongo();
    httpServer.listen(PORT, () => {
      console.log(`Servidor HTTP y WebSocket v2.8.0 iniciado en puerto ${PORT}.`);
      console.log(`MongoDB conectado. WebSocket escuchando en puerto ${PORT}.`);
      console.log('Autenticación habilitada: POST /api/register y POST /api/login.');
      console.log('Bloqueos distribuidos entre instancias habilitados mediante compare-and-swap de MongoDB.');
      console.log('Historial colaborativo con deshacer/rehacer y restauración persistente habilitado.');
      console.log('Sincronización entre instancias habilitada mediante lectura incremental del Event Store.');
      console.log(`Event Sourcing habilitado; checkpoints cada ${SNAPSHOT_EVERY_EVENTS} eventos o ${SNAPSHOT_INTERVAL_MS / 1000}s.`);
      console.log(`ID de instancia: ${INSTANCE_ID}`);
    });
  })
  .catch(err => {
    console.error('No se pudo conectar a MongoDB:', err.message);
    process.exit(1);
  });

let cierreEnCurso = false;
async function cerrarServidor(signal) {
  if (cierreEnCurso) return;
  cierreEnCurso = true;
  console.log(`\nCerrando servidor (${signal})...`);
  for (const cliente of wss.clients) cliente.terminate();
  await Promise.allSettled([...wss.clients].map(ws => {
    const sala = salasActivas.get(ws.nombreSala);
    return sala ? almacenBloqueos.liberarCliente(sala.nombreSala, ws.clienteId) : Promise.resolve();
  }));
  await Promise.allSettled([...salasActivas.values()].map(sala => sala.persistencia));
  if (flujoEventosMongo) await flujoEventosMongo.close().catch(() => {});
  await new Promise(resolve => httpServer.close(() => resolve()));
  await mongoose.disconnect();
  process.exit(0);
}
process.once('SIGINT', () => cerrarServidor('SIGINT'));
process.once('SIGTERM', () => cerrarServidor('SIGTERM'));
