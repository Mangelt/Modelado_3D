'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const html = fs.readFileSync(path.join(root, 'client/index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'client/app.js'), 'utf8');
const benchmark = fs.readFileSync(path.join(root, 'server/tools/benchmark.js'), 'utf8');

test('la interfaz muestra la métrica local de recepción al siguiente frame', () => {
  assert.match(html, /id="latency-status"/);
  assert.match(html, /no incluye la red/i);
  assert.match(app, /function medirRecepcionHastaFrame\(msg, recibidoEn\)/);
  assert.match(app, /requestAnimationFrame\(\(\) => requestAnimationFrame/);
  assert.match(app, /P95 móvil/);
});

test('la prueba de carga abre sockets independientes sin desactivar el límite de registros', () => {
  assert.match(benchmark, /async function autenticarUsuarioTemporal\(\)/);
  assert.match(benchmark, /Array\.from\(\{ length: CLIENTS \}/);
  assert.match(benchmark, /clienteId distinto del servidor/);
  assert.match(benchmark, /if \(usuarioTemporal\) await cerrarSesion\(usuarioTemporal\.token\)/);
});


test('el benchmark aplica un umbral P95 explícito y puede guardar un informe', () => {
  assert.match(benchmark, /--threshold-ms=/);
  assert.match(benchmark, /Objetivo RNF-01/);
  assert.match(benchmark, /p95Ms/);
  assert.match(benchmark, /--report=/);
  assert.match(benchmark, /writeFileSync/);
});
