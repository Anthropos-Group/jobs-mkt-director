FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=80 \
    CONTENT_DIR=/app/contenido \
    META_FILE=/app/biblioteca.json

WORKDIR /app
COPY server/ ./server/
COPY contenido/ ./contenido/
COPY biblioteca.json ./

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1/__salud >/dev/null || exit 1
CMD ["node", "server/server.js"]
