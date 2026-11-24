# Plantilla de resultados — pruebas del proyecto

> Completar con mediciones reales. No copiar cifras de pruebas simuladas ni declarar un requisito cumplido sin evidencia.

## Entorno

| Dato | Resultado |
|---|---|
| Fecha y hora | Por completar |
| Versión | 2.8.0 |
| Ubuntu/kernel | Por completar |
| CPU / RAM | Por completar |
| Node.js | Por completar |
| MongoDB | Por completar |
| Docker / Compose | Por completar |
| Kubernetes / Minikube | Por completar / No aplica |
| Topología backend | 1 o 2 instancias; completar |
| Topología MongoDB | Standalone o Replica Set; completar |

## Rendimiento

| Métrica | Resultado medido | Objetivo | ¿Cumple? |
|---|---:|---:|---|
| Conexiones WebSocket simultáneas | Por completar | 50 | Por determinar |
| PING/PONG P95 | Por completar | Informativo | Por determinar |
| Propagación de transformación P95 | Por completar | Menor de 50 ms | Por determinar |
| Recepción→siguiente frame P95 | Por completar | Informativo / complementario | Por determinar |
| Errores/desconexiones | Por completar | Sin errores no recuperados | Por determinar |

## Integración y tolerancia a fallos

| Prueba | Resultado | Evidencia |
|---|---|---|
| Dos backend con IDs de instancia diferentes | Por completar | cluster-smoke log |
| Bloqueo exclusivo de mismo objeto | Por completar | cluster-smoke log |
| Bloqueo exclusivo de cara/vértice | Por completar | cluster-smoke log |
| Difusión geométrica entre backend | Por completar | cluster-smoke log |
| Liberación por desconexión abrupta | Por completar | cluster-smoke log |
| Elección de nuevo primario MongoDB | Por completar | rs.status / captura |
| Backend sigue listo tras failover | Por completar | /health y captura |
| Recuperación tras reinicio | Por completar | modelo antes/después |
| Restauración de respaldo | Por completar | log mongorestore |

## Conclusión

Redactar la conclusión únicamente después de completar las tablas. Indicar requisitos cumplidos, parciales y no demostrados, junto con las condiciones exactas de la prueba.
