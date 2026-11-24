'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const TOKEN_TTL_SECONDS = 12 * 60 * 60;
// En desarrollo se crea un secreto local privado y persistente. También puede
// proporcionarse AUTH_SECRET desde el entorno (ver .env.example).
function cargarSecreto() {
  if (process.env.AUTH_SECRET) return crypto.createHash('sha256').update(process.env.AUTH_SECRET).digest();
  const secretPath = process.env.AUTH_SECRET_FILE || path.join(__dirname, '.auth-secret');
  try { return fs.readFileSync(secretPath); }
  catch (err) {
    if (err.code !== 'ENOENT') throw err;
    const generated = crypto.randomBytes(32);
    try { fs.writeFileSync(secretPath, generated, { flag: 'wx', mode: 0o600 }); return generated; }
    catch (writeError) {
      if (writeError.code === 'EEXIST') return fs.readFileSync(secretPath);
      throw writeError;
    }
  }
}
const TOKEN_SECRET = cargarSecreto();

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, 64);
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

async function verifyPassword(password, storedHash) {
  if (typeof storedHash !== 'string') return false;
  const parts = storedHash.split(':');
  if (parts.length !== 2 || !/^[a-f0-9]{32}$/.test(parts[0]) || !/^[a-f0-9]{128}$/.test(parts[1])) return false;
  const salt = Buffer.from(parts[0], 'hex');
  const expected = Buffer.from(parts[1], 'hex');
  const actual = await scrypt(password, salt, expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

function createToken(user, secret = TOKEN_SECRET, now = Date.now()) {
  const issuedAt = Math.floor(now / 1000);
  const payload = Buffer.from(JSON.stringify({
    sub: String(user.id || user._id),
    username: user.username,
    sid: user.sessionId,
    iat: issuedAt,
    exp: issuedAt + TOKEN_TTL_SECONDS
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyToken(token, secret = TOKEN_SECRET, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [payload, signature] = parts;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest();
  let received;
  try { received = Buffer.from(signature, 'base64url'); } catch { return null; }
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!decoded || typeof decoded.sub !== 'string' || typeof decoded.username !== 'string' || typeof decoded.sid !== 'string') return null;
    if (!Number.isFinite(decoded.exp) || decoded.exp <= Math.floor(now / 1000)) return null;
    return { id: decoded.sub, username: decoded.username, sessionId: decoded.sid, exp: decoded.exp };
  } catch {
    return null;
  }
}

module.exports = { hashPassword, verifyPassword, createToken, verifyToken, TOKEN_TTL_SECONDS };
