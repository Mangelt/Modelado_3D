#!/usr/bin/env bash
set -euo pipefail

if ! command -v mongorestore >/dev/null 2>&1; then
  echo "ERROR: mongorestore no está instalado (MongoDB Database Tools)." >&2
  exit 127
fi

ARCHIVO="${1:-}"
if [[ -z "$ARCHIVO" || ! -f "$ARCHIVO" ]]; then
  echo "Uso: $0 /ruta/al/respaldo.archive.gz" >&2
  exit 2
fi
MONGO_URI="${MONGO_URI:-mongodb://127.0.0.1:27017/sistemas_distribuidos_3d}"
ARGS=(--uri="$MONGO_URI" --archive="$ARCHIVO" --gzip)

if [[ "${CONFIRM_DROP:-NO}" == "YES" ]]; then
  echo "ATENCIÓN: se reemplazarán las colecciones que coincidan con el respaldo."
  ARGS+=(--drop)
else
  echo "Modo seguro: no se eliminarán colecciones existentes."
  echo "Para reemplazarlas explícitamente, repite con CONFIRM_DROP=YES."
fi

mongorestore "${ARGS[@]}"
echo "Restauración finalizada. Comprueba el estado de las salas antes de permitir nuevas sesiones."
