#!/bin/sh
# Se ejecuta automáticamente al arrancar el contenedor (docker-entrypoint.d de nginx).
# 1) Configura la contraseña del explorador a partir de variables de entorno.
# 2) Genera el índice de documentos (manifest.json) leyendo /srv/contenido.
set -eu

AUTH_FILE=/etc/nginx/snippets/auth.conf
if [ -n "${EXPLORER_PASSWORD:-}" ]; then
    user="${EXPLORER_USER:-strattos}"
    # nginx admite el esquema {PLAIN}; la contraseña ya vive en texto plano en el entorno.
    printf '%s:{PLAIN}%s\n' "$user" "$EXPLORER_PASSWORD" > /etc/nginx/.htpasswd
    printf 'auth_basic "Strattos";\nauth_basic_user_file /etc/nginx/.htpasswd;\n' > "$AUTH_FILE"
    echo "strattos: explorador protegido (usuario: $user)"
else
    : > "$AUTH_FILE"
    echo "strattos: AVISO - EXPLORER_PASSWORD no definida, el explorador queda abierto"
fi

/usr/local/bin/generar-manifest.sh /srv/contenido > /srv/explorador/manifest.json
echo "strattos: manifest generado ($(grep -c '"path"' /srv/explorador/manifest.json || true) documentos)"
