# Matriz de cumplimiento — Proyecto de modelado 3D colaborativo

Esta matriz sigue los requisitos del documento **Definición del proyecto** (05-sep-2026). Distingue implementación en código de validación ejecutada en un entorno real.

## Requisitos funcionales

| ID | Requisito del documento | Implementación | Estado verificable | Evidencia que falta |
|---|---|---|---|---|
| RF-01 | Sesión bidireccional WebSocket autenticada por usuario | Registro, inicio/cierre de sesión, hash scrypt, token HMAC, sesión revocable y validación del token en handshake WS. | Implementado; dos sesiones de navegador se observaron conectadas. | Prueba integrada de token expirado/revocado y rechazo de conexión no autenticada. |
| RF-02 | Bloqueo exclusivo de subelementos 3D (vértice, cara, hueso) al iniciar edición | Bloqueos granulares por objeto, cara y vértice; conflictos por vértices lógicos compartidos; edición de las primitivas soportadas. | Parcial: objeto/cara/vértice están implementados; pruebas unitarias cubren conflictos. | `cluster-smoke` debe probar exclusión y edición en dos procesos reales. No hay armaduras/huesos en el modelador actual. |
| RF-03 | Transmitir transformación matemática al resto de clientes en tiempo real | Gateway WebSocket, Event Store persistente, Change Streams en Replica Set y difusión entre instancias. | Sincronización básica verificada previamente con dos clientes en una instancia. | Ejecutar `npm run validate:cluster` y conservar el informe de integración. |
| RF-04 | Liberar bloqueo al terminar interacción o por timeout de conexión | Liberación explícita, desconexión y TTL de los bloqueos, persistidos en almacén compartido. | Cubierto por pruebas unitarias. | Verificar liberación remota entre dos backends mediante `cluster-smoke`. |
| RF-05 | Snapshot asíncrono del estado para persistencia de largo plazo | Event Sourcing, checkpoints, reconstrucción, historial, reproducción, restauración, undo/redo y scripts de backup/restore. | Implementado en código y pruebas unitarias. | Reiniciar backend y Replica Set en laboratorio; probar restauración de un respaldo en base aislada; definir retención/archivo del log. |

## Requisitos no funcionales e infraestructura

| ID | Requisito del documento | Implementación | Estado verificable | Evidencia que falta |
|---|---|---|---|---|
| RNF-01 | Latencia de propagación menor a 50 ms | Benchmark de hasta 100 WebSockets, medición de propagación de una transformación real, P95 y umbral configurable; métrica local recepción→siguiente frame en UI. | Herramienta preparada; no hay medición real del entorno de entrega. | Ejecutar 50 clientes contra el clúster, obtener P95 menor a 50 ms y medir también recepción/renderizado en navegador. Adjuntar JSON y condiciones de prueba. |
| RNF-02 | Escalabilidad horizontal por salas aisladas con contenedores/Kubernetes | Compose con tres miembros MongoDB y dos backends; manifiestos Kubernetes con StatefulSet MongoDB, dos réplicas backend y proxy frontend. | Configuración estática revisada; el modo Compose/Kubernetes no se ha ejecutado aquí. | `docker compose config`, despliegue, comprobar dos pods backend y ejecutar `cluster-smoke`. |
| RNF-03 | Tolerancia a fallos al caer el nodo que gestiona bloqueos | MongoDB Replica Set de tres miembros, estado de bloqueos compartido, secuencias/eventos transaccionales en Replica Set y procedimientos de backup. | Diseño y pruebas unitarias; failover no demostrado. | Ejecutar elección de nuevo primario, comprobar continuidad del backend, comparar secuencias/modelos y probar restore. |

## Alcance actual de la geometría

El editor ofrece cubos, esferas y cilindros, con edición de caras y vértices. El documento menciona vértices, caras y huesos como ejemplos de subelementos. La implementación cubre caras y vértices, pero no incluye rigging ni armaduras. No presentar soporte de huesos como terminado.

## Evidencias ya disponibles

- Captura compartida por el equipo donde dos navegadores aparecen conectados a `equipo-1` y se observa un bloqueo de objeto y actividad de sala.
- Pruebas automatizadas del paquete (consultar el número exacto que imprime `npm test` en la versión instalada).
- Pruebas de integración y rendimiento pendientes de ejecutar desde el entorno de laboratorio; guardar archivos de `server/reports/`.

## Criterio para declarar 100 %

No marcar RNF-01, RNF-02 o RNF-03 como cumplidos solo porque existen scripts o manifiestos. Se requiere evidencia reproducible: resultados de carga, despliegue con dos backends, failover del Replica Set, recuperación tras reinicio y restauración de respaldo. Registrar fecha, versiones, hardware, topología, muestras y resultados.
