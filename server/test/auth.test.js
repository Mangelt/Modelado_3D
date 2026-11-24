'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword, verifyPassword, createToken, verifyToken } = require('../auth');

const secret = Buffer.from('prueba-secreta-del-editor-3d-de-al-menos-32-bytes');

test('la contraseña se almacena como hash y se verifica sin guardarla en texto claro', async () => {
  const password = 'ClaveSegura_2026';
  const hash = await hashPassword(password);
  assert.notEqual(hash, password);
  assert.equal(await verifyPassword(password, hash), true);
  assert.equal(await verifyPassword('otra-clave', hash), false);
  assert.equal(await verifyPassword(password, 'hash-invalido'), false);
});

test('el token firmado identifica usuario y sesión', () => {
  const now = 1_800_000_000_000;
  const token = createToken({ id: 'usuario-1', username: 'Miguel', sessionId: 'sesion-1' }, secret, now);
  const claims = verifyToken(token, secret, now + 1000);
  assert.equal(claims.id, 'usuario-1');
  assert.equal(claims.username, 'Miguel');
  assert.equal(claims.sessionId, 'sesion-1');
});

test('el token rechaza firma alterada, secreto incorrecto y expiración', () => {
  const now = 1_800_000_000_000;
  const token = createToken({ id: 'usuario-1', username: 'Miguel', sessionId: 'sesion-1' }, secret, now);
  const [payload, signature] = token.split('.');
  const changed = `${payload}.${signature.slice(0, -2)}aa`;
  assert.equal(verifyToken(changed, secret, now), null);
  assert.equal(verifyToken(token, Buffer.from('otro-secreto-distinto'), now), null);
  assert.equal(verifyToken(token, secret, now + 13 * 60 * 60 * 1000), null);
});
