'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const nginx = fs.readFileSync(path.join(root, 'client/nginx.conf'), 'utf8');
const compose = fs.readFileSync(path.join(root, 'compose.yaml'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'server/package.json'), 'utf8'));
const kubernetes = fs.readFileSync(path.join(root, 'k8s/modelado3d.yaml'), 'utf8');
const k8sNginx = fs.readFileSync(path.join(root, 'client/nginx.k8s.conf'), 'utf8');
const serverSource = fs.readFileSync(path.join(root, 'server/server.js'), 'utf8');

test('Nginx refresca DNS y balancea el alias entre réplicas de Compose', () => {
  assert.match(nginx, /resolver 127\.0\.0\.11 valid=5s ipv6=off/);
  assert.match(nginx, /zone modelado3d_backend 64k/);
  assert.match(nginx, /server modelado3d-server:8080 resolve/);
});

test('Compose define tres miembros de MongoDB y dos réplicas backend', () => {
  assert.match(compose, /mongo1:/);
  assert.match(compose, /mongo2:/);
  assert.match(compose, /mongo3:/);
  assert.match(compose, /replicas: 2/);
  assert.match(compose, /replicaSet=rs0/);
});

test('la suite de pruebas se ejecuta secuencialmente de forma reproducible', () => {
  assert.equal(pkg.scripts.test, 'bash tools/run-tests.sh');
});


test('Kubernetes monta un Nginx específico con DNS del Service, no DNS embebido de Docker', () => {
  assert.match(kubernetes, /name: modelado3d-nginx/);
  assert.match(kubernetes, /mountPath: \/etc\/nginx\/conf\.d\/default\.conf/);
  assert.match(kubernetes, /server modelado3d-server:8080;/);
  assert.match(k8sNginx, /server modelado3d-server:8080;/);
  assert.doesNotMatch(k8sNginx, /resolver\s+127\.0\.0\.11/);
});

test('la versión de la API coincide con el paquete y las imágenes Kubernetes', () => {
  assert.equal(pkg.version, '2.8.0');
  assert.match(serverSource, /version: '2\.8\.0'/);
  assert.match(kubernetes, /image: modelado3d-server:2\.8\.0/);
  assert.match(kubernetes, /image: modelado3d-client:2\.8\.0/);
});
