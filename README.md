# Strattos · Biblioteca de documentos

Panel para publicar propuestas, informes y dashboards en HTML (también PDF e imágenes)
y compartirlos con clientes mediante un enlace. Sin base de datos: **el repositorio es la
fuente de verdad**. Cada subida, cambio de nombre o borrado desde el panel se guarda como
commit en GitHub y se aplica en el servidor al instante.

## Qué hace

- **Subir arrastrando** uno o varios archivos, con barra de progreso. El nombre se toma del
  `<title>` del HTML y se puede editar; la URL se genera sola (sin tildes ni espacios).
- **Control de duplicados**: avisa si ya existe un documento con esa URL (reemplazar o guardar
  como `-2`) y si el mismo archivo ya está publicado en otra parte (por huella SHA-256).
- **Miniaturas en vivo** de cada documento (vista cuadrícula) o vista de lista.
- **Renombrar, mover, reemplazar y eliminar** documentos y carpetas. Al mover, el enlace
  antiguo redirige al nuevo, así que los enlaces ya compartidos no se rompen.
- Buscador global (atajo `/`), orden por fecha o nombre, diseño responsive.
- **No indexable**: `robots.txt` con `Disallow: /` y cabecera `X-Robots-Tag: noindex` en todo.

## Acceso

| URL | Qué es | Acceso |
|---|---|---|
| `/` | Panel de la biblioteca | Usuario + contraseña |
| `/<carpeta>/<documento>` | El documento (con o sin `.html`) | Público por enlace directo |

## Configuración en Portainer (Environment variables del stack)

| Variable | Obligatoria | Descripción |
|---|---|---|
| `EXPLORER_PASSWORD` | Sí | Contraseña del panel. Sin ella el panel queda abierto. |
| `EXPLORER_USER` | No | Usuario del panel (por defecto `strattos`). |
| `GITHUB_TOKEN` | Para editar | Token *fine-grained* con acceso solo a este repositorio y permiso **Contents: Read and write**. Sin él, el panel funciona en solo lectura. |
| `GITHUB_REPO` | No | Por defecto `Anthropos-Group/jobs-mkt-director`. |
| `GITHUB_BRANCH` | No | Por defecto `main`. |
| `MAX_UPLOAD_MB` | No | Tamaño máximo por archivo (por defecto 50). |

Crear el token: GitHub → Settings → Developer settings → Personal access tokens →
Fine-grained tokens → *Generate new token* → Repository access: *Only select repositories*
(este repo) → Permissions → Contents: *Read and write*.

GitOps updates con *Polling* (5m) sigue funcionando igual: los commits que hace el panel
reconstruyen el contenedor con el mismo contenido que ya estaba publicado.

## Estructura

```
contenido/         Los documentos (lo que se publica)
biblioteca.json    Nombres visibles, fechas y redirecciones (lo mantiene el panel)
server/server.js   Servidor Node sin dependencias (estáticos + API)
server/public/     Interfaz del panel
```

También se puede publicar con git directamente: añadir el archivo en `contenido/` y hacer
push a `main`. El panel lo mostrará tras el siguiente redeploy.

## Probar en local

```sh
docker build -t strattos-biblioteca .
docker run --rm -p 8080:80 -e EXPLORER_PASSWORD=prueba strattos-biblioteca
# http://localhost:8080  (usuario: strattos / contraseña: prueba) — solo lectura sin GITHUB_TOKEN
```

Sin Docker: `EXPLORER_PASSWORD=prueba PORT=8080 ALLOW_LOCAL_WRITES=1 node server/server.js`
(`ALLOW_LOCAL_WRITES=1` permite editar sin GitHub; los cambios no se guardan en el repo).
