#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_ROOT="$(cd "$SERVER_DIR/.." && pwd)"
cd "$SERVER_DIR"

printf '\n=== Validación local de entrega ===\n'
node -e "const p=require('./package.json'); console.log('Versión:',p.version); if(p.version!=='2.8.0') process.exit(1);"

printf '\n=== Pruebas automatizadas ===\n'
npm test

printf '\n=== Sintaxis JavaScript ===\n'
npm run check

printf '\n=== Sintaxis Bash ===\n'
for script in tools/run-tests.sh tools/backup-mongo.sh tools/restore-mongo.sh tools/validate-release.sh tools/validate-cluster.sh; do
  bash -n "$script"
done

printf '\n=== Configuración YAML ===\n'
if python3 -c 'import yaml' >/dev/null 2>&1; then
  python3 - "$PROJECT_ROOT" <<'PY'
import pathlib, sys, yaml
root = pathlib.Path(sys.argv[1])
for relative in ('compose.yaml', 'k8s/modelado3d.yaml'):
    path = root / relative
    with path.open(encoding='utf-8') as stream:
        documents = list(yaml.safe_load_all(stream))
    if not documents or any(document is None for document in documents):
        raise SystemExit(f'YAML vacío o documento nulo: {relative}')
    print(f'OK: {relative} ({len(documents)} documento(s))')
PY
else
  echo 'OMITIDO: instala PyYAML (python3-yaml) para analizar los manifiestos YAML.'
fi

printf '\n=== Docker Compose ===\n'
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  (cd "$PROJECT_ROOT" && docker compose config --quiet)
  echo 'OK: docker compose config'
else
  echo 'OMITIDO: Docker Compose no está instalado en este equipo.'
fi

printf '\n=== Sintaxis Nginx para Kubernetes ===\n'
if command -v nginx >/dev/null 2>&1; then
  temp_conf="$(mktemp)"
  temp_main="$(mktemp)"
  trap 'rm -f "$temp_conf" "$temp_main"' EXIT
  # El hostname del Service solo existe dentro del clúster. Se sustituye por
  # loopback únicamente durante nginx -t para comprobar sintaxis local.
  sed 's/modelado3d-server/127.0.0.1/g' "$PROJECT_ROOT/client/nginx.k8s.conf" > "$temp_conf"
  printf 'events {}\nhttp { include %s; }\n' "$temp_conf" > "$temp_main"
  nginx -t -c "$temp_main" -p /tmp/nginx-release-check
  rm -f "$temp_conf" "$temp_main"
  trap - EXIT
else
  echo 'OMITIDO: Nginx no está instalado; la configuración será comprobada al construir el contenedor.'
fi

printf '\nVALIDACIÓN LOCAL TERMINADA. Las pruebas de clúster, failover y rendimiento deben ejecutarse aparte.\n'
