#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
for archivo in test/*.test.js; do
  printf "\n===== %s =====\n" "$archivo"
  node --test "$archivo"
done
printf '\nSuite completa: todos los archivos de prueba finalizaron correctamente.\n'
