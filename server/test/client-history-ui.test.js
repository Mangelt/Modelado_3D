'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../../client/index.html'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '../../client/app.js'), 'utf8');

test('la interfaz incluye los controles accesibles del historial', () => {
  for (const id of [
    'btn-history', 'history-dialog', 'history-events', 'history-status',
    'history-load-more', 'history-preview', 'btn-history-restore',
    'btn-history-refresh', 'btn-history-close'
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `Falta el elemento #${id}`);
  }
});

test('el cliente consulta replay autenticado y restaura como importación nueva', () => {
  assert.match(app, /\/api\/rooms\/\$\{encodeURIComponent\(salaActual\(\)\)\}\/history/);
  assert.match(app, /\/api\/rooms\/\$\{encodeURIComponent\(salaActual\(\)\)\}\/replay\/\$\{secuencia\}/);
  assert.match(app, /tipo:\s*'IMPORTAR_MODELO'/);
  assert.match(app, /La restauración se guardará como un evento nuevo/);
});

test('la interfaz ofrece deshacer y rehacer con accesos de teclado', () => {
  assert.match(html, /id=["']btn-undo["']/);
  assert.match(html, /id=["']btn-redo["']/);
  assert.match(app, /ejecutarDeshacerRehacer\('deshacer'\)/);
  assert.match(app, /ejecutarDeshacerRehacer\('rehacer'\)/);
  assert.match(app, /secuenciaBase/);
});
