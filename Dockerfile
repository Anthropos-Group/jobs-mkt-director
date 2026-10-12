FROM nginx:alpine

RUN mkdir -p /etc/nginx/snippets /srv/explorador /srv/contenido \
    && rm -f /etc/nginx/conf.d/default.conf

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/headers.conf /etc/nginx/snippets/headers.conf
COPY docker/40-strattos-setup.sh /docker-entrypoint.d/40-strattos-setup.sh
COPY scripts/generar-manifest.sh /usr/local/bin/generar-manifest.sh
COPY explorador/ /srv/explorador/
COPY contenido/ /srv/contenido/

# Permisos de lectura para el worker de nginx (los archivos subidos pueden venir con 600).
RUN chmod +x /docker-entrypoint.d/40-strattos-setup.sh /usr/local/bin/generar-manifest.sh \
    && chmod -R a+rX /srv

EXPOSE 80
