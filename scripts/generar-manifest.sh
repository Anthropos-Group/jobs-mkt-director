#!/bin/sh
# Imprime un JSON con todos los .html bajo el directorio dado (por defecto ./contenido),
# incluyendo su <title> para mostrarlo en el explorador.
set -eu
ROOT="${1:-contenido}"
cd "$ROOT"

esc() { sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/ /g'; }

printf '{"generado":"%s","documentos":[' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
first=1
find . -type f -name '*.html' ! -path '*/.*' | sed 's|^\./||' | LC_ALL=C sort | while IFS= read -r f; do
    title=$(head -c 65536 "$f" | tr '\n\r' '  ' | sed -n 's/.*<title[^>]*>\([^<]*\)<\/title>.*/\1/p' | sed 's/^ *//; s/ *$//' | esc)
    size=$(wc -c < "$f" | tr -d ' ')
    path=$(printf '%s' "$f" | esc)
    [ $first -eq 1 ] && first=0 || printf ','
    printf '\n{"path":"%s","title":"%s","size":%s}' "$path" "$title" "$size"
done
printf '\n]}\n'
