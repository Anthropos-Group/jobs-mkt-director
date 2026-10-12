# Strattos · Biblioteca de documentos

Servidor de renderizado (nginx) para propuestas, informes y dashboards en HTML.
Sin base de datos: **el repositorio es la fuente de verdad**.

## Cómo funciona

| URL | Qué es | Acceso |
|---|---|---|
| `/` | Explorador de carpetas con buscador y botón "Copiar enlace" | Usuario + contraseña (`EXPLORER_USER` / `EXPLORER_PASSWORD`) |
| `/<carpeta>/<archivo>` | El documento renderizado (con o sin `.html`) | Público por enlace directo, para compartir con clientes |
| `/robots.txt` | `Disallow: /` para todos los rastreadores | Público |

Todas las respuestas llevan `X-Robots-Tag: noindex, nofollow, noarchive`, que impide la
indexación aunque alguien publique el enlace en otro sitio (robots.txt por sí solo no lo
garantiza). También `Referrer-Policy: no-referrer`, para que las URLs no se filtren al
hacer clic en enlaces externos.

## Estructura

```
contenido/
  clientes/<cliente>/       Propuestas e informes por cliente
  propuestas/               Propuestas comerciales genéricas
  interno/                  Dashboards e ideas internas
  historico/                Material pasado (ej. la oferta de Director de Marketing)
explorador/                 La página del explorador y el 404
docker/                     Configuración de nginx y script de arranque
scripts/generar-manifest.sh Indexa los .html (título, ruta, tamaño)
```

Convención de nombres: minúsculas, sin tildes, con guiones
(`clientes/jaboneria-wilson/informe-gestion-cx-4-0.html` →
`https://<dominio>/clientes/jaboneria-wilson/informe-gestion-cx-4-0`).
Una carpeta puede tener su propio `index.html` si el documento lleva imágenes o CSS aparte.

## Publicar un documento nuevo

1. Agrega el `.html` en la carpeta correspondiente de `contenido/`:
   - pídeselo a Claude, o
   - desde GitHub web: *Add file → Upload files*, arrastrar y hacer commit a `main`.
2. Portainer revisa el repositorio cada 5 minutos (GitOps updates → Polling) y, si hay
   cambios, reconstruye el stack. Para verlo al instante: *Pull and redeploy* en el stack.
   El explorador se actualiza solo (el índice se genera al arrancar).
3. Abre `/`, busca el documento y usa **Copiar enlace**.

## Despliegue en Portainer (una sola vez)

1. Stack desde repositorio Git (este repo, rama `main`, `docker-compose.yml`).
2. *Environment variables*: `EXPLORER_PASSWORD` (obligatoria en la práctica) y, opcional, `EXPLORER_USER` (por defecto `strattos`).
   Si `EXPLORER_PASSWORD` no está definida, el explorador queda abierto (lo avisa en los logs).
3. *GitOps updates* activado con *Polling* (intervalo `5m`).

## Probar en local

```sh
docker build -t strattos-biblioteca .
docker run --rm -p 8080:80 -e EXPLORER_PASSWORD=prueba strattos-biblioteca
# http://localhost:8080  (usuario: strattos / contraseña: prueba)
```
