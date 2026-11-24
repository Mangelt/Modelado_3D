# Editor 3D colaborativo — versión 2.8.0

> **Candidata a entrega académica.** El código y las pruebas automatizadas están preparados; el cumplimiento de carga, latencia y tolerancia a fallos solo se puede declarar después de ejecutar las pruebas de integración descritas en `docs/PROTOCOLO_VALIDACION_FINAL.md`.

## Novedades de la versión 2.8.0

- Validador de entrega `npm run validate:release`: ejecuta suite, sintaxis JavaScript/Bash y validación YAML; comprueba Compose cuando Docker está instalado.
- Validador de clúster `npm run validate:cluster`: comprueba readiness, coordinación entre dos backends y carga de 50 WebSockets; genera logs y reporte JSON en `server/reports/`.
- Benchmark configurable con `--threshold-ms=50`; devuelve código distinto de cero si el P95 de propagación de la transformación no es estrictamente menor a 50 ms.
- Matriz de cumplimiento, protocolo reproducible de pruebas y plantilla para registrar resultados reales en `docs/`.
- Configuración Nginx específica para Kubernetes, montada desde un ConfigMap y basada en el DNS estable del Service; no reutiliza el DNS embebido de Docker Compose.
- Dockerfile del cliente copia solamente `index.html` y `app.js` al directorio público.

Proyecto académico de Sistemas Distribuidos: editor 3D colaborativo con autenticación, edición granular por cara/vértice, WebSockets, persistencia MongoDB, Event Sourcing y coordinación compartida entre varias instancias de backend.

## Funcionalidades acumuladas de la rama 2.x

- Botones colaborativos de deshacer/rehacer con Ctrl+Z y Ctrl+Y; las operaciones se guardan como eventos de auditoría y se sincronizan a las demás sesiones.
- El servidor reconstruye las pilas de historial desde el Event Store y verifica que la sala no haya cambiado antes de restaurar una versión.
- La creación y duplicación usan una reserva temporal atómica para respetar el bloqueo global de sala.
- `cluster-smoke` ahora valida bloqueos de objeto/cara, edición geométrica remota y liberación por desconexión entre dos procesos.
- `load-test` abre hasta 100 conexiones WebSocket autenticadas con una cuenta temporal compartida (cada socket recibe un `clienteId` propio), evitando superar el límite anti-fuerza-bruta de registros; mide PING/PONG y propagación de una transformación real.
- El cliente muestra una métrica local de recepción del evento hasta el siguiente ciclo de renderizado, con P95 móvil y una advertencia explícita de que no incluye la red.
- Se añaden comandos para respaldar y restaurar MongoDB.

- **Interfaz de historial:** el botón Historial consulta eventos de la sala usando la API autenticada, muestra secuencia, tipo, autor y fecha, y permite paginar hacia eventos anteriores.
- **Vista de versión histórica:** cada evento puede reconstruirse en modo de consulta; el panel presenta la secuencia, cantidad de eventos aplicados y objetos del snapshot sin alterar la escena activa.
- **Restauración controlada:** permite reemplazar el estado de la sala por una versión reconstruida. La restauración se envía como una nueva importación/evento, por lo que conserva el historial y requiere confirmación y el bloqueo exclusivo de sala existente.

- **Bloqueos distribuidos:** los bloqueos por objeto, cara, vértice y sala se guardan en un documento compartido por sala. La escritura usa compare-and-swap (revisión incremental) sobre MongoDB, de modo que dos procesos no pueden conceder simultáneamente el mismo recurso incompatible.
- **Sincronización entre instancias:** en MongoDB Replica Set, cada instancia usa Change Streams para enterarse de nuevas inserciones del Event Store y actualizar los clientes locales. Si Change Streams se interrumpe, entra un sondeo de respaldo cada 300 ms. Los bloqueos se sincronizan cada 500 ms. Cada evento registra el identificador del proceso que lo originó para evitar retransmitir dos veces los eventos locales.
- **Secuencias globales:** en MongoDB Replica Set, la reserva de secuencia y la inserción del evento se confirman juntas en una transacción. En modo standalone se permite una sola instancia backend y las operaciones de la sala se serializan localmente. La sincronización nunca salta un evento ausente, para evitar divergencias entre snapshots.
- **Protección de operaciones de sala:** la importación obtiene un bloqueo exclusivo de sala, evitando que se inicien ediciones ajenas durante la sustitución del modelo.
- **Prueba de clúster:** `npm run cluster-smoke` conecta dos usuarios a dos procesos diferentes, intenta adquirir el mismo bloqueo y comprueba que un evento creado en un proceso llegue al cliente del otro.
- **MongoDB Replica Set:** Docker Compose y Kubernetes incluyen tres miembros MongoDB y un proceso idempotente de inicialización del replica set `rs0`. El backend utiliza transacciones para confirmar de forma atómica cada secuencia/evento cuando detecta un replica set.
- **Backend con dos réplicas:** la configuración de laboratorio permite iniciar dos procesos backend detrás de un proxy Nginx de mismo origen. Los bloqueos y eventos se comparten a través de MongoDB.
- **Proxy del cliente:** el cliente usa `/api` y `/ws` en despliegues Docker/Kubernetes. El modo de desarrollo local con `python3 -m http.server 5500` sigue conectando directamente al backend en `8080`.

- **Deshacer/rehacer colaborativo:** botones y atajos Ctrl+Z/Ctrl+Y. El servidor calcula el cursor desde el Event Store, verifica la secuencia base bajo un bloqueo exclusivo de sala y registra `DESHACER`/`REHACER` como eventos nuevos; las otras sesiones reciben el modelo restaurado.
- **Creación protegida por bloqueo temporal:** la creación/duplicación reserva atómicamente el identificador como objeto, por lo que no puede atravesar una operación que tenga reservado el bloqueo global de sala.
- **Prueba de clúster reforzada:** crea un objeto de prueba, prueba exclusión de objeto y de cara entre dos procesos, transmite una edición geométrica y verifica liberación explícita y por desconexión.
- **Benchmark de mutación real:** además de PING/PONG, crea un objeto y mide el tiempo desde el envío de una transformación hasta que los clientes observadores reciben el evento.
- **Respaldo y restauración MongoDB:** scripts `npm run backup -- [archivo]` y `npm run restore -- [archivo]`; el modo destructivo requiere `CONFIRM_DROP=YES`.

## Funcionalidades incluidas

- Editor Three.js: cubos, esferas y cilindros.
- Selección y transformaciones de objetos (posición, rotación, escala y color).
- Modos Objeto, Cara y Vértice; desplazamiento de caras/vértices de las primitivas actuales.
- Bloqueos exclusivos por objeto y subelemento, incluyendo conflictos por vértices lógicos compartidos.
- Almacenamiento de bloqueos compartido entre procesos mediante operaciones atómicas en MongoDB.
- Registro/inicio/cierre de sesión; contraseñas derivadas con `scrypt`; tokens HMAC-SHA256 y sesiones revocables en MongoDB.
- Salas colaborativas por WebSocket y difusión local/remota de eventos.
- Eventos persistentes, checkpoints periódicos y reconstrucción del estado tras reiniciar.
- API autenticada de historial y reproducción histórica de solo lectura; restauración, deshacer y rehacer como eventos nuevos.
- Importación/exportación JSON, historial reciente de actividad, línea de tiempo del Event Store, consulta y restauración de versiones, cuadrícula y cámara.
- Validación de entradas, máximo 200 objetos por sala y límite de tamaño de mensaje WebSocket.
- Soporte para aplicación móvil Android (Capacitor) y PWA con interfaz táctil y paneles colapsables.
- Sincronización bidireccional en tiempo real entre clientes de escritorio y móviles.
- Configuración para despliegue del frontend en Vercel y Firebase Hosting (`vercel.json`, `firebase.json`).
- Docker Compose, MongoDB Replica Set de tres miembros, manifiestos Kubernetes y herramientas de prueba de carga/clúster.

## Límites conocidos

- Las primitivas disponibles son cubo, esfera y cilindro. No hay herramientas de armaduras/huesos.
- La edición geométrica está acotada a las caras y vértices de las primitivas actuales; no es un modelador poligonal general.
- La coordinación distribuida usa MongoDB como almacén compartido. En replica set, los eventos se propagan mediante Change Streams; el sondeo de 300 ms es un respaldo. No utiliza Redis ni un broker externo dedicado. La latencia real depende del clúster, la red y la carga.
- Los bloqueos compartidos se guardan en MongoDB. Si MongoDB no está disponible, las operaciones de edición que requieren persistencia o coordinación deben considerarse no disponibles.
- El backend comparte bloqueos y eventos, pero no hay todavía elección automática de líderes de aplicación ni una capa de caché distribuida.
- El replica set de Docker/Kubernetes es una topología académica de laboratorio sin autenticación interna de MongoDB ni cifrado entre nodos. No debe exponerse a Internet ni considerarse producción.
- Los checkpoints, la reproducción histórica, la restauración y el undo/redo explícito están implementados. Aún falta definir y validar una política de retención/archivo del Event Store para despliegues de larga duración.
- `cluster-smoke` verifica dos procesos de backend diferentes y la exclusión mutua/difusión entre ellos. `load-test` abre 50 conexiones concurrentes (una identidad temporal compartida y `clienteId` distinto por socket) y mide una mutación geométrica desde el envío hasta la recepción por los clientes; por sí solo no demuestra la latencia extremo a extremo de renderizado menor a 50 ms.
- Kubernetes/Compose facilitan dos instancias backend y MongoDB replicado, pero todavía faltan pruebas de failover, copias de seguridad/restauración y mediciones reproducibles de carga.

## Requisitos

- Node.js 20.19 o superior.
- MongoDB 7.x. Para el uso local existente se acepta una instancia standalone; para el modo multi-instancia se recomienda Replica Set.
- Docker Engine y Docker Compose v2 para el despliegue Compose.
- Kubernetes y kubectl (Minikube sirve para el laboratorio) para el despliegue K8s.
- Navegador moderno con WebGL.
- Acceso a internet para descargar Three.js desde CDN.

## Instalación local en Ubuntu (sin Docker)

La instalación local mantiene la estructura `client/` y `server/` directamente dentro de `Proyecto_modelado_3D/`. En MongoDB standalone se permite un único backend; al iniciar, el contador se corrige con el último evento/checkpoint confirmado si una caída anterior dejó un incremento huérfano. No cambia ni elimina tu base de datos local.

1. Comprueba MongoDB:

   ```bash
   sudo systemctl status mongod --no-pager
   ```

2. Instala dependencias y ejecuta las pruebas:

   ```bash
   cd ~/Documents/Proyecto_modelado_3D/server
   npm install
   npm test
   npm run check
   ```

3. Inicia el backend (mantén abierta esta terminal):

   ```bash
   npm start
   ```

   Debe indicar MongoDB conectado y WebSocket escuchando en `8080`.

4. En otra terminal sirve el cliente:

   ```bash
   cd ~/Documents/Proyecto_modelado_3D/client
   python3 -m http.server 5500 --bind 127.0.0.1
   ```

5. Abre `http://127.0.0.1:5500/`, crea una cuenta o inicia sesión y entra a una sala.

No abras `index.html` directamente mediante `file://`.

> El modo local con MongoDB standalone admite el backend único que ya utilizas. Las operaciones atómicas de coordinación también pueden ejecutarse contra una instancia MongoDB standalone; para alta disponibilidad de la base de datos se necesita el replica set descrito más abajo.

## Deshacer y rehacer

Los botones `↶ Deshacer` y `↷ Rehacer` aplican cambios a nivel de sala, no solo en la pestaña local. También funcionan con `Ctrl+Z` y `Ctrl+Y` (o `Ctrl+Shift+Z`). El servidor reconstruye el historial persistido, valida la secuencia base y exige el bloqueo exclusivo de sala. Si otro usuario edita mientras se prepara la operación, se rechaza la solicitud para evitar sobrescribir una actualización más reciente. Los cambios nuevos después de deshacer invalidan la pila de rehacer.

El historial mantiene hasta 500 puntos de deshacer/rehacer recientes calculados desde los eventos persistidos. No borra eventos: las operaciones se registran con tipo `DESHACER` o `REHACER`.

## Respaldo y restauración

Desde `server/`, puedes crear un respaldo comprimido:

```bash
npm run backup -- ../backups/modelado3d.archive.gz
```

Restaurar sin eliminar colecciones existentes:

```bash
npm run restore -- ../backups/modelado3d.archive.gz
```

Para reemplazar colecciones coincidentes, debes solicitarlo explícitamente:

```bash
CONFIRM_DROP=YES npm run restore -- ../backups/modelado3d.archive.gz
```

Se requieren MongoDB Database Tools (`mongodump` y `mongorestore`). Prueba siempre la restauración en un entorno separado antes de usarla sobre datos importantes.

## Pruebas automatizadas

Desde `server/`:

```bash
npm test
npm run check
```

La suite cubre autenticación, historial, deshacer/rehacer, reproducción del Event Store, validación geométrica, bloqueos granulares, coordinación compare-and-swap simulada entre dos almacenes y configuración de despliegue. Se ejecuta secuencialmente para evitar que los workers paralelos de Node mantengan el proceso abierto. La suite unitaria no sustituye la prueba de integración contra un replica set real.

Para ejecutar toda la validación local, incluidos scripts Bash y YAML: `npm run validate:release`.
Para probar dos backends y 50 conexiones con el clúster ya encendido: `API_BASE=http://127.0.0.1:5501 WS_BASE=ws://127.0.0.1:5501/ws npm run validate:cluster`. Los informes se guardan en `server/reports/`.

## Docker Compose: dos backends y MongoDB Replica Set

Esta configuración crea tres miembros MongoDB en el replica set `rs0`, inicializa el primario y levanta dos instancias backend detrás del proxy Nginx del cliente.

Desde la raíz del proyecto:

```bash
docker compose up --build --scale server=2 -d
docker compose ps
docker compose logs -f server
```

Abre `http://127.0.0.1:5501/`. El proxy sirve el frontend y reenvía `/api` y `/ws` al servicio backend.

Para comprobar el replica set:

```bash
docker compose exec mongo1 mongosh --quiet --eval 'rs.status().members.map(m => ({name:m.name,state:m.stateStr}))'
```

Para detener los servicios sin borrar los datos:

```bash
docker compose down
```

No uses `docker compose down -v` salvo que también desees borrar las bases de datos y el volumen del secreto de autenticación.

### Prueba real de coordinación entre procesos

Con Compose activo y dos backends:

```bash
cd server
API_BASE=http://127.0.0.1:5501 \
WS_BASE=ws://127.0.0.1:5501/ws \
npm run cluster-smoke
```

La prueba crea dos cuentas temporales, verifica que las conexiones llegaron a dos identificadores de instancia distintos, crea un objeto temporal, comprueba exclusión mutua para el objeto y una cara, transmite una edición geométrica al otro proceso, valida liberación explícita y liberación por desconexión abrupta. Al final cierra las sesiones y elimina el objeto de prueba.


### Prueba manual de failover de MongoDB

Con los tres miembros del replica set activos, identifica el primario:

```bash
docker compose exec mongo1 mongosh --quiet --eval 'rs.status().members.map(m => ({name:m.name,state:m.stateStr}))'
```

Si `mongo1` es el primario, provoca una elección de otro miembro:

```bash
docker compose exec mongo1 mongosh --quiet --eval 'rs.stepDown(60, 5)'
```

La conexión de `mongosh` con `mongo1` puede cerrarse durante el cambio; eso es esperado. Comprueba que otro miembro quedó como primario y que el backend sigue listo:

```bash
docker compose exec mongo2 mongosh --quiet --eval 'db.hello().isWritablePrimary'
curl -fsS http://127.0.0.1:5501/health
```

Repite `rs.status()` contra cualquier miembro si `mongo2` no es el primario elegido. Esta prueba debe realizarse en laboratorio y después de respaldar la información importante.

### Prueba de 50 conexiones

```bash
cd server
API_BASE=http://127.0.0.1:5501 \
WS_BASE=ws://127.0.0.1:5501/ws \
npm run load-test -- --clients=50
```

El resultado incluye promedio, mediana y P95 de conexión más respuesta PING/PONG y de propagación de una transformación real a los clientes observadores. El script crea una sola identidad temporal y la usa en hasta 100 conexiones WebSocket independientes; cada socket recibe un `clienteId` propio. Así se mide concurrencia de conexiones sin superar el límite anti-fuerza-bruta de registros. No equivale a probar 50 cuentas humanas distintas. La interfaz también muestra una estimación local desde la recepción del evento hasta el siguiente ciclo de renderizado (doble requestAnimationFrame); no incluye tiempo de red. Para RNF-01 sigue haciendo falta medir p95 de extremo a extremo en navegadores reales y documentar la red, los equipos y la resolución.

## Kubernetes (manifiesto de laboratorio)

El directorio `k8s/` define:

- ConfigMap Nginx específico para Kubernetes (`modelado3d-nginx`), que usa el nombre DNS estable del Service backend; esto evita depender de `127.0.0.11`, que solo corresponde al DNS embebido de Docker.
- StatefulSet MongoDB con tres miembros y un Job que inicializa `rs0`.
- Deployment backend con dos réplicas, bloqueos y eventos compartidos mediante MongoDB.
- Service del backend y Deployment/Service Nginx del cliente.

Antes de aplicar, crea el namespace y un secreto de autenticación propio:

```bash
kubectl create namespace modelado3d --dry-run=client -o yaml | kubectl apply -f -
kubectl create secret generic modelado3d-secrets \
  --namespace modelado3d \
  --from-literal=auth-secret="$(openssl rand -hex 32)"
```

Construye las imágenes y cárgalas a Minikube:

```bash
docker build -f server/Dockerfile -t modelado3d-server:2.8.0 .
docker build -f client/Dockerfile -t modelado3d-client:2.8.0 .
minikube image load modelado3d-server:2.8.0
minikube image load modelado3d-client:2.8.0
```

Aplica los recursos:

```bash
kubectl apply -f k8s/modelado3d.yaml
kubectl get pods -n modelado3d -w
```

Comprueba el Job del replica set y el estado de los tres miembros:

```bash
kubectl logs -n modelado3d job/mongo-init-replicaset
kubectl exec -n modelado3d mongo-0 -- mongosh --quiet --eval 'rs.status().members.map(m => ({name:m.name,state:m.stateStr}))'
```

Accede al cliente:

```bash
kubectl port-forward -n modelado3d svc/modelado3d-client 5501:80
```

Abre `http://127.0.0.1:5501/`. El proxy Nginx envía API y WebSocket al Service backend, que distribuye conexiones entre las dos réplicas.

Este manifiesto es un punto de partida académico, no producción: MongoDB no tiene autenticación interna ni TLS, el almacenamiento depende del StorageClass del clúster y todavía deben configurarse backups, NetworkPolicies, secretos administrados y pruebas de failover.

## Interfaz de historial y reproducción

En el cliente, el botón **Historial** abre la línea de tiempo de la sala. Usa **Ver versión** para reconstruir un estado de solo lectura y **Restaurar esta versión** para sustituir el modelo activo. La restauración requiere confirmación y se registra como un evento nuevo; no elimina ni reescribe eventos anteriores.

## API de historial y reproducción

Las dos rutas requieren `Authorization: Bearer <token>` de una sesión activa.

- `GET /api/rooms/:sala/history?limit=100&before=120`: consulta eventos en orden ascendente. `limit` acepta 1–200; `before` permite paginar hacia secuencias anteriores.
- `GET /api/rooms/:sala/replay/:secuencia`: devuelve un snapshot reconstruido hasta una secuencia determinada. Es de solo lectura; no cambia la sala activa. La interfaz puede restaurarlo enviando el snapshot como un nuevo evento `IMPORTAR_MODELO`.

Ejemplo:

```bash
TOKEN='PEGA_AQUI_TU_TOKEN'
curl -H "Authorization: Bearer $TOKEN" \
  'http://127.0.0.1:8080/api/rooms/equipo-1/history?limit=50'

curl -H "Authorization: Bearer $TOKEN" \
  'http://127.0.0.1:8080/api/rooms/equipo-1/replay/10'
```

No compartas tokens ni credenciales. Las salas creadas antes del Event Store persistente se migran tomando su snapshot actual como checkpoint base; las modificaciones anteriores que nunca se almacenaron como eventos independientes no se pueden reproducir hacia atrás.

## Variables de entorno

- `PORT`: puerto del backend (predeterminado `8080`).
- `MONGO_URI`: cadena de conexión MongoDB (predeterminada `mongodb://127.0.0.1:27017/sistemas_distribuidos_3d`).
- `AUTH_SECRET`: secreto de firma opcional; si se usa, debe ser el mismo en todas las instancias.
- `AUTH_SECRET_FILE`: ruta del archivo persistente del secreto; por defecto `server/.auth-secret`.
- `CLIENT_ORIGINS`: lista separada por comas de orígenes web permitidos.

Genera un secreto aleatorio con:

```bash
openssl rand -hex 32
```

No compartas `AUTH_SECRET` ni `.auth-secret`. Para despliegues públicos se requiere HTTPS/WSS, autenticación interna de MongoDB, cifrado, secretos administrados y una política de orígenes restringida.

## Relación con el documento del proyecto

- **Frontend / emisor de eventos:** `client/app.js` capta las acciones, mantiene el visor Three.js y transmite eventos.
- **Gateway WebSocket:** `server/server.js` autentica la conexión, valida solicitudes y distribuye eventos de la sala.
- **Gestión de bloqueos:** `server/lock-manager.js` valida conflictos; `server/distributed-lock-store.js` persiste el mapa de bloqueos con compare-and-swap en MongoDB para coordinar múltiples instancias.
- **Persistencia / Event Sourcing:** `server/server.js` escribe eventos en `EventoSalaProyecto`, checkpoints en `SnapshotSalaProyecto` y estado de sala en `SalaProyecto`; `server/event-store.js` reconstruye el estado.
- **Sincronización entre instancias:** cada proceso usa Change Streams en Replica Set para reaccionar a inserciones del Event Store y difunde a sus clientes los eventos remotos; mantiene el sondeo como respaldo o modo standalone.
- **Contenedores:** Dockerfile y Compose empaquetan backend, frontend y tres miembros MongoDB. Nginx usa resolución DNS dinámica del servicio backend (requiere Nginx OSS 1.27.3 o posterior) para repartir conexiones entre las réplicas de Compose.
- **Kubernetes:** StatefulSet MongoDB de tres nodos, backend de dos réplicas y cliente Nginx con proxy de API/WebSocket.

## Estado de requisitos del documento (candidata 2.8.0)

La matriz actualizada y los pasos de evidencia están en `docs/MATRIZ_CUMPLIMIENTO.md`. No marcar los requisitos no funcionales como cumplidos hasta ejecutar las pruebas reales.

| Requisito | Estado en v2.8.0 | Pendiente para cerrar/demostrar |
|---|---|---|
| RF-01 Autenticación por usuario | Implementada; ya se probó en dos sesiones | Pruebas negativas de expiración/revocación en integración |
| RF-02 Bloqueos por vértice/cara | Bloqueos compartidos y edición de primitivas implementados | Ejecutar prueba geométrica multi-instancia; no hay aún herramienta de armaduras/huesos |
| RF-03 Transformaciones en tiempo real | Probado con dos usuarios en una instancia; benchmark y propagación multi-instancia preparados | Ejecutar `cluster-smoke` y `load-test` contra el clúster real; guardar resultados |
| RF-04 Liberación por fin de edición/desconexión/TTL | Implementada con almacenamiento compartido | Ejecutar `cluster-smoke` para comprobarlo en dos procesos reales |
| RF-05 Snapshots/persistencia | Eventos persistentes, checkpoints, replay API, línea de tiempo y undo/redo como eventos nuevos | Prueba de recuperación tras reinicio y política de retención/archivo del log |
| RNF-01 Latencia menor a 50 ms | Benchmark de 50 sockets y propagación de una transformación; la interfaz muestra recepción→siguiente frame | Medir p95 de punta a punta incluyendo red y render en navegador real; documentar el entorno |
| RNF-02 Escalabilidad horizontal | Dos instancias backend y coordinación Mongo compartida | Pruebas de carga, balanceo y recuperación al escalar en el clúster |
| RNF-03 Tolerancia a fallos | MongoDB Replica Set de tres miembros preparado; scripts de respaldo/restauración | Ejecutar failover real, recuperación de backend y restauración de backup en laboratorio |

## Verificación de la versión 2.8.0

En el entorno de preparación se ejecutó `npm test` (**51 pruebas correctas**), `npm run check`, validación de sintaxis Bash y análisis YAML de `compose.yaml` y `k8s/modelado3d.yaml`. La validación detectó que Docker Compose no estaba instalado, por lo que se omitió `docker compose config`. No se ejecutó un clúster Docker/Kubernetes, un failover real ni una prueba real de 50 clientes. Esas comprobaciones deben ejecutarse en Ubuntu antes de afirmar cumplimiento de RNF-01/RNF-02/RNF-03.

## Estructura

```text
Proyecto_modelado_3D/
├── README.md
├── compose.yaml
├── .dockerignore
├── docs/
│   ├── MATRIZ_CUMPLIMIENTO.md
│   ├── PROTOCOLO_VALIDACION_FINAL.md
│   └── PLANTILLA_RESULTADOS.md
├── client/
│   ├── Dockerfile
│   ├── nginx.conf
│   ├── nginx.k8s.conf
│   ├── index.html
│   └── app.js
├── server/
│   ├── Dockerfile
│   ├── auth.js
│   ├── distributed-lock-store.js
│   ├── event-store.js
│   ├── geometry-edits.js
│   ├── history-stack.js
│   ├── lock-manager.js
│   ├── server.js
│   ├── package.json
│   ├── package-lock.json
│   ├── tools/
│   │   ├── backup-mongo.sh
│   │   ├── restore-mongo.sh
│   │   ├── run-tests.sh
│   │   ├── benchmark.js
│   │   └── cluster-smoke.js
│   └── test/
│       ├── auth.test.js
│       ├── client-history-ui.test.js
│       ├── client-latency-ui.test.js
│       ├── deployment-config.test.js
│       ├── distributed-lock-store.test.js
│       ├── event-store.test.js
│       ├── geometry-edits.test.js
│       ├── history-stack.test.js
│       └── lock-manager.test.js
└── k8s/
    └── modelado3d.yaml
```
