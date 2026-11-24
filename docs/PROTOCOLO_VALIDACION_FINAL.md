# Protocolo de validación final

## A. Validación local (Ubuntu)

Desde `server/`:

```bash
npm install
npm run validate:release
```

Resultado esperado: suite unitaria completa, sintaxis JavaScript/Bash válida, YAML analizado cuando PyYAML esté instalado y configuración Compose validada cuando Docker Compose esté disponible.

## B. Validación de colaboración entre instancias

Desde la raíz del proyecto:

```bash
docker compose up --build --scale server=2 -d
docker compose ps
```

Espera a que `mongo-init`, los tres miembros MongoDB y ambos backends estén saludables. Después:

```bash
cd server
API_BASE=http://127.0.0.1:5501 WS_BASE=ws://127.0.0.1:5501/ws npm run cluster-smoke
```

La prueba debe identificar dos `instanceId` distintos, conceder solo uno de los dos bloqueos competitivos, propagar una edición geométrica y comprobar liberación explícita y por desconexión.

## C. Prueba de carga de 50 conexiones

Con Compose activo:

```bash
cd server
API_BASE=http://127.0.0.1:5501 \
WS_BASE=ws://127.0.0.1:5501/ws \
node tools/benchmark.js --clients=50 --threshold-ms=50 --report=reports/load-test-50.json
```

El proceso devuelve código de salida distinto de cero cuando el P95 de propagación de la transformación no es estrictamente menor que 50 ms. El JSON guarda número de conexiones, PING/PONG y propagación geométrica. El benchmark mide WebSocket hasta recepción, no la pintura de píxeles; añade una observación de la métrica local en los navegadores y documenta la topología/red.

También puedes ejecutar ambos escenarios con:

```bash
API_BASE=http://127.0.0.1:5501 WS_BASE=ws://127.0.0.1:5501/ws npm run validate:cluster
```

## D. Failover de MongoDB (laboratorio)

Haz un respaldo antes de simular fallos:

```bash
cd server
npm run backup -- ../backups/pre-failover.archive.gz
```

Identifica el primario:

```bash
docker compose exec mongo1 mongosh --quiet --eval 'rs.status().members.map(m => ({name:m.name,state:m.stateStr}))'
```

Ejecuta el step-down únicamente en el contenedor que sea primario (por ejemplo, si el primario es `mongo1`):

```bash
docker compose exec mongo1 mongosh --quiet --eval 'rs.stepDown(60, 5)'
```

Es esperado que esa conexión se cierre. Comprueba que un nuevo miembro es PRIMARY y que el servidor responde:

```bash
docker compose exec mongo2 mongosh --quiet --eval 'rs.status().members.map(m => ({name:m.name,state:m.stateStr}))'
curl -fsS http://127.0.0.1:5501/health
```

Consulta `rs.status()` desde cualquier miembro si el nuevo primario no es `mongo2`. Comprueba también que una transformación posterior se persiste y se replica a los dos clientes.

## E. Recuperación y restauración

1. Crea varios objetos y realiza transformaciones.
2. Espera un checkpoint o genera suficientes eventos para alcanzarlo.
3. Detén solamente los backends (`docker compose stop server`).
4. Inícialos (`docker compose start server`).
5. Comprueba que el snapshot reconstruido coincide con el último modelo.
6. Para backup/restore, usa una base de datos de laboratorio separada antes de probar restauración con `CONFIRM_DROP=YES`.

## F. Kubernetes (Minikube o clúster académico)

Crear namespace y secreto:

```bash
kubectl create namespace modelado3d --dry-run=client -o yaml | kubectl apply -f -
kubectl create secret generic modelado3d-secrets -n modelado3d \
  --from-literal=auth-secret="$(openssl rand -hex 32)"
```

Construir y cargar las imágenes:

```bash
docker build -f server/Dockerfile -t modelado3d-server:2.8.0 .
docker build -f client/Dockerfile -t modelado3d-client:2.8.0 .
minikube image load modelado3d-server:2.8.0
minikube image load modelado3d-client:2.8.0
```

Aplicar y observar:

```bash
kubectl apply -f k8s/modelado3d.yaml
kubectl get pods -n modelado3d -w
kubectl logs -n modelado3d job/mongo-init-replicaset
kubectl port-forward -n modelado3d svc/modelado3d-client 5501:80
```

Verifica que haya tres pods MongoDB, dos pods backend, el Job de inicialización completado y el cliente accesible. Ejecuta `cluster-smoke` y el benchmark usando el port-forward, según el acceso permitido por el entorno.

## G. Qué registrar en el informe

- Fecha/hora y commit/versión.
- CPU/RAM de la máquina y sistema operativo.
- Versión Node.js, Docker, Compose, Kubernetes y MongoDB.
- Cantidad real de procesos backend y nodos MongoDB.
- Número de clientes, número de cuentas y método de carga.
- Promedio, mediana, P95 y máximo de PING/PONG y propagación.
- Métrica de recepción→siguiente frame en navegadores.
- Errores, reconexiones y resultado de failover/restauración.
- Capturas y JSON/logs generados en `server/reports/`.
