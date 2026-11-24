#!/usr/bin/env bash
set -euo pipefail

if ! command -v mongodump >/dev/null 2>&1; then
  echo "ERROR: mongodump no está instalado (MongoDB Database Tools)." >&2
  exit 127
fi

MONGO_URI="${MONGO_URI:-mongodb://127.0.0.1:27017/sistemas_distribuidos_3d}"
DESTINO="${1:-./backups/modelado3d-$(date +%Y%m%d-%H%M%S).archive.gz}"
mkdir -p "$(dirname "$DESTINO")"

mongodump --uri="$MONGO_URI" --archive="$DESTINO" --gzip
printf 'Respaldo creado: %s\n' "$DESTINO"
printf 'Guárdalo fuera del equipo y verifica periódicamente su restauración en un entorno de prueba.\n'
