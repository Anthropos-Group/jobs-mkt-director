'use strict';
// Biblioteca Strattos: sirve documentos HTML/PDF/imágenes y un panel para
// subirlos, renombrarlos y borrarlos. Sin base de datos ni dependencias:
// cada cambio se guarda como commit en GitHub y se aplica en el disco local.

const http = require('node:http');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const CFG = {
  port: Number(process.env.PORT) || 80,
  root: path.resolve(process.env.CONTENT_DIR || path.join(__dirname, '..', 'contenido')),
  metaFile: path.resolve(process.env.META_FILE || path.join(__dirname, '..', 'biblioteca.json')),
  appDir: path.join(__dirname, 'public'),
  user: process.env.EXPLORER_USER || 'strattos',
  pass: process.env.EXPLORER_PASSWORD || '',
  ghToken: process.env.GITHUB_TOKEN || '',
  ghRepo: process.env.GITHUB_REPO || 'Anthropos-Group/jobs-mkt-director',
  ghBranch: process.env.GITHUB_BRANCH || 'main',
  ghApi: (process.env.GITHUB_API || 'https://api.github.com').replace(/\/+$/, ''),
  localWrites: process.env.ALLOW_LOCAL_WRITES === '1',
  maxMB: Number(process.env.MAX_UPLOAD_MB) || 50,
};
const REPO_CONTENT = 'contenido/';
const REPO_META = 'biblioteca.json';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};
const DOC_EXT = new Set(['.html', '.htm', '.pdf', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);
const UPLOAD_EXT = /^[a-z0-9][a-z0-9-]{0,79}\.(html|pdf|png|jpg|jpeg|webp|gif|svg)$/;
const FOLDER_SEG = /^[a-z0-9][a-z0-9-]{0,79}$/;
const COMPRESSIBLE = /^(text\/|application\/(json|javascript)|image\/svg)/;

const COMMON_HEADERS = {
  'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet, noimageindex',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

// ---------------------------------------------------------------------------
// Utilidades

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

const slugify = (s) => String(s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const safeEq = (a, b) => crypto.timingSafeEqual(
  crypto.createHash('sha256').update(String(a)).digest(),
  crypto.createHash('sha256').update(String(b)).digest());

const now = () => new Date().toISOString();

// Ruta relativa segura para LEER (admite nombres subidos a mano por git).
function safeRel(rel) {
  if (typeof rel !== 'string') return null;
  rel = rel.replace(/^\/+|\/+$/g, '');
  if (rel === '') return '';
  const segs = rel.split('/');
  if (segs.some((s) => !s || s.startsWith('.') || s.includes('\\') || s.includes('\0'))) return null;
  return segs.join('/');
}

function validFolder(rel) {
  if (rel === '') return true;
  const segs = rel.split('/');
  return segs.length <= 6 && segs.every((s) => FOLDER_SEG.test(s));
}

const abs = (rel) => path.join(CFG.root, rel);
const joinRel = (a, b) => (a ? `${a}/${b}` : b);
const dirOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
const baseOf = (rel) => rel.slice(rel.lastIndexOf('/') + 1);
const extOf = (rel) => path.extname(rel).toLowerCase();

function cleanUrl(rel) {
  if (/(^|\/)index\.html?$/i.test(rel)) return '/' + rel.replace(/index\.html?$/i, '');
  return '/' + rel.replace(/\.html?$/i, '');
}
const normUrl = (u) => {
  u = u.replace(/\.html?$/i, '');
  return u.length > 1 ? u.replace(/\/+$/, '') : u;
};

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

function decodeEntities(s) {
  return s.replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m, e) => (
    { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' }[e]))
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)));
}

function titleOf(buf) {
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(buf.subarray(0, 65536).toString('utf8'));
  return m ? decodeEntities(m[1].replace(/\s+/g, ' ').trim()) : '';
}

const prettify = (slug) => slug.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ')
  .replace(/^\w/, (c) => c.toUpperCase());

// ---------------------------------------------------------------------------
// Metadatos (biblioteca.json): nombres visibles, fechas y redirecciones.

let meta = { documentos: {}, carpetas: {}, redirecciones: {} };

async function loadMeta() {
  try {
    const m = JSON.parse(await fsp.readFile(CFG.metaFile, 'utf8'));
    meta = { documentos: m.documentos || {}, carpetas: m.carpetas || {}, redirecciones: m.redirecciones || {} };
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('biblioteca: no se pudo leer', CFG.metaFile, e.message);
  }
}

const cloneMeta = () => JSON.parse(JSON.stringify(meta));

// ---------------------------------------------------------------------------
// Índice del disco (con caché por mtime+tamaño).

const fileCache = new Map();

async function walk(dirRel, out) {
  let entries;
  try { entries = await fsp.readdir(abs(dirRel), { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const rel = joinRel(dirRel, e.name);
    if (e.isDirectory()) {
      if (e.name.startsWith('.')) continue;
      out.dirs.push(rel);
      await walk(rel, out);
    } else if (e.isFile()) {
      out.files.push(rel);
    }
  }
}

async function scan() {
  const out = { dirs: [], files: [] };
  await walk('', out);
  const docs = [];
  for (const rel of out.files) {
    if (baseOf(rel).startsWith('.') || !DOC_EXT.has(extOf(rel))) continue;
    const st = await fsp.stat(abs(rel));
    const key = `${st.mtimeMs}:${st.size}`;
    let info = fileCache.get(rel);
    if (!info || info.key !== key) {
      const buf = await fsp.readFile(abs(rel));
      info = { key, sha256: sha256(buf), titulo: /\.html?$/i.test(rel) ? titleOf(buf) : '', size: st.size, mtime: st.mtime.toISOString() };
      fileCache.set(rel, info);
    }
    const m = meta.documentos[rel] || {};
    const ext = extOf(rel);
    docs.push({
      ruta: rel,
      url: cleanUrl(rel),
      carpeta: dirOf(rel),
      nombre: m.nombre || info.titulo || prettify(baseOf(rel)),
      titulo: info.titulo,
      tipo: ext === '.pdf' ? 'pdf' : /\.html?$/.test(ext) ? 'html' : 'imagen',
      size: info.size,
      sha256: info.sha256,
      creado: m.creado || info.mtime,
      actualizado: m.actualizado || m.creado || info.mtime,
    });
  }
  const carpetas = out.dirs.map((rel) => ({
    ruta: rel,
    nombre: (meta.carpetas[rel] && meta.carpetas[rel].nombre) || prettify(baseOf(rel)),
  }));
  return { docs, carpetas, files: out.files, dirs: out.dirs };
}

async function nextFree(folder, file) {
  const ext = extOf(file);
  const base = file.slice(0, -ext.length).replace(/-\d+$/, '');
  for (let i = 2; i < 1000; i++) {
    const cand = `${base}-${i}${ext}`;
    if (!(await exists(abs(joinRel(folder, cand))))) return cand;
  }
  return `${base}-${Date.now()}${ext}`;
}

// ---------------------------------------------------------------------------
// GitHub: un commit por operación usando la API de Git Data.

async function gh(method, p, body) {
  const res = await fetch(`${CFG.ghApi}/repos/${CFG.ghRepo}${p}`, {
    method,
    headers: {
      Authorization: `Bearer ${CFG.ghToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'strattos-biblioteca',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* respuesta no JSON */ }
  if (!res.ok) {
    const err = new Error(`GitHub ${res.status}: ${(json && json.message) || text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

async function githubCommit(message, changes) {
  const tree = [];
  for (const ch of changes) {
    if (ch.content == null) {
      tree.push({ path: ch.path, mode: '100644', type: 'blob', sha: null });
    } else {
      const blob = await gh('POST', '/git/blobs', { content: ch.content.toString('base64'), encoding: 'base64' });
      tree.push({ path: ch.path, mode: '100644', type: 'blob', sha: blob.sha });
    }
  }
  for (let attempt = 1; ; attempt++) {
    const ref = await gh('GET', `/git/ref/heads/${encodeURIComponent(CFG.ghBranch)}`);
    const head = ref.object.sha;
    const parent = await gh('GET', `/git/commits/${head}`);
    const t = await gh('POST', '/git/trees', { base_tree: parent.tree.sha, tree });
    const c = await gh('POST', '/git/commits', { message, tree: t.sha, parents: [head] });
    try {
      await gh('PATCH', `/git/refs/heads/${encodeURIComponent(CFG.ghBranch)}`, { sha: c.sha });
      return c.sha;
    } catch (e) {
      // 422 = alguien empujó entre medio; reintentamos sobre la nueva cabeza.
      if (e.status !== 422 || attempt >= 3) throw e;
    }
  }
}

// Las operaciones de escritura se serializan para no pisarse entre sí.
let queue = Promise.resolve();
function exclusive(fn) {
  const p = queue.then(fn, fn);
  queue = p.catch(() => {});
  return p;
}

async function pruneEmpty(dirRel) {
  while (dirRel) {
    try {
      if ((await fsp.readdir(abs(dirRel))).length) return;
      await fsp.rmdir(abs(dirRel));
    } catch { return; }
    dirRel = dirOf(dirRel);
  }
}

// Primero GitHub, después el disco: si el commit falla no se toca nada local.
async function apply(message, { write = [], remove = [], meta: newMeta }) {
  const metaBuf = Buffer.from(JSON.stringify(newMeta, null, 2) + '\n');
  const changes = [
    ...remove.map((rel) => ({ path: REPO_CONTENT + rel, content: null })),
    ...write.map((w) => ({ path: REPO_CONTENT + w.rel, content: w.buf })),
    { path: REPO_META, content: metaBuf },
  ];
  let commit = null;
  if (CFG.ghToken) {
    try { commit = await githubCommit(message, changes); } catch (e) {
      const hint = [401, 403, 404].includes(e.status) ? ' Revisa GITHUB_TOKEN y GITHUB_REPO.' : '';
      throw new HttpError(502, `No se pudo guardar en GitHub (${e.message}).${hint} No se cambió nada.`);
    }
  }
  else if (!CFG.localWrites) {
    throw new HttpError(503, 'Falta GITHUB_TOKEN: los cambios no se pueden guardar en el repositorio.');
  }
  for (const rel of remove) {
    await fsp.rm(abs(rel), { force: true });
    fileCache.delete(rel);
  }
  for (const w of write) {
    await fsp.mkdir(path.dirname(abs(w.rel)), { recursive: true });
    await fsp.writeFile(abs(w.rel), w.buf);
  }
  for (const d of new Set(remove.map(dirOf))) await pruneEmpty(d);
  await fsp.writeFile(CFG.metaFile, metaBuf);
  meta = newMeta;
  console.log(`${message}${commit ? ` (${commit.slice(0, 7)})` : ' (solo local)'}`);
  return commit;
}

// Al mover una URL, las redirecciones que apuntaban a ella siguen al destino.
function redirect(m, fromUrl, toUrl) {
  fromUrl = normUrl(fromUrl); toUrl = normUrl(toUrl);
  if (fromUrl === toUrl) return;
  for (const k of Object.keys(m.redirecciones)) if (m.redirecciones[k] === fromUrl) m.redirecciones[k] = toUrl;
  m.redirecciones[fromUrl] = toUrl;
  delete m.redirecciones[toUrl];
}
function dropRedirectsTo(m, url) {
  url = normUrl(url);
  for (const k of Object.keys(m.redirecciones)) if (m.redirecciones[k] === url) delete m.redirecciones[k];
}

// ---------------------------------------------------------------------------
// Operaciones

async function opUpload(q, buf) {
  const folder = safeRel(q.carpeta || '');
  const file = String(q.archivo || '');
  if (folder == null || !validFolder(folder)) throw new HttpError(400, 'Carpeta no válida.');
  if (!UPLOAD_EXT.test(file)) throw new HttpError(400, 'Nombre de archivo no válido (minúsculas, números y guiones; .html, .pdf o imagen).');
  if (!buf.length) throw new HttpError(400, 'El archivo está vacío.');
  const rel = joinRel(folder, file);
  const replace = q.reemplazar === '1';
  const already = await exists(abs(rel));
  if (already && !replace) {
    throw new HttpError(409, `Ya existe un documento en ${cleanUrl(rel)}.`, { sugerencia: await nextFree(folder, file) });
  }
  const m = cloneMeta();
  const prev = m.documentos[rel] || {};
  const nombre = String(q.nombre || '').trim().slice(0, 160);
  m.documentos[rel] = {
    nombre: nombre || prev.nombre || titleOf(buf) || prettify(file),
    creado: (already && prev.creado) || now(),
    actualizado: now(),
  };
  delete m.redirecciones[normUrl(cleanUrl(rel))];
  await apply(`biblioteca: ${already ? 'actualizar' : 'subir'} ${rel}`, { write: [{ rel, buf }], meta: m });
  return { ruta: rel, url: cleanUrl(rel), reemplazado: already };
}

async function opMoveDoc(body) {
  const from = safeRel(body.de);
  if (!from || !(await exists(abs(from)))) throw new HttpError(404, 'El documento no existe.');
  const folder = safeRel(body.carpeta ?? dirOf(from));
  if (folder == null || !validFolder(folder)) throw new HttpError(400, 'Carpeta no válida.');
  const file = String(body.archivo || baseOf(from));
  const to = joinRel(folder, file);
  const m = cloneMeta();
  const entry = { ...(m.documentos[from] || {}) };
  const nombre = String(body.nombre ?? '').trim().slice(0, 160);
  if (nombre) entry.nombre = nombre;
  entry.actualizado = now();

  if (to === from) {
    m.documentos[from] = entry;
    await apply(`biblioteca: renombrar ${from}`, { meta: m });
    return { ruta: from, url: cleanUrl(from) };
  }
  if (!UPLOAD_EXT.test(file) || extOf(file) !== extOf(from)) throw new HttpError(400, 'Nombre de archivo no válido.');
  if (await exists(abs(to))) {
    throw new HttpError(409, `Ya existe un documento en ${cleanUrl(to)}.`, { sugerencia: await nextFree(folder, file) });
  }
  const buf = await fsp.readFile(abs(from));
  delete m.documentos[from];
  m.documentos[to] = entry;
  if (body.redirigir !== false) redirect(m, cleanUrl(from), cleanUrl(to));
  else dropRedirectsTo(m, cleanUrl(from));
  await apply(`biblioteca: mover ${from} -> ${to}`, { write: [{ rel: to, buf }], remove: [from], meta: m });
  return { ruta: to, url: cleanUrl(to) };
}

async function opDeleteDoc(body) {
  const rel = safeRel(body.ruta);
  if (!rel || !(await exists(abs(rel)))) throw new HttpError(404, 'El documento no existe.');
  const m = cloneMeta();
  delete m.documentos[rel];
  dropRedirectsTo(m, cleanUrl(rel));
  await apply(`biblioteca: eliminar ${rel}`, { remove: [rel], meta: m });
  return { ok: true };
}

async function opCreateFolder(body) {
  const parent = safeRel(body.padre || '');
  const nombre = String(body.nombre || '').trim().slice(0, 120);
  const slug = slugify(body.slug || nombre);
  if (parent == null || !validFolder(parent) || !slug) throw new HttpError(400, 'Nombre de carpeta no válido.');
  const rel = joinRel(parent, slug);
  if (!validFolder(rel)) throw new HttpError(400, 'Demasiados niveles de carpetas.');
  if (await exists(abs(rel))) throw new HttpError(409, 'Ya existe una carpeta con ese nombre.');
  const m = cloneMeta();
  m.carpetas[rel] = { nombre: nombre || prettify(slug) };
  await apply(`biblioteca: crear carpeta ${rel}`, { write: [{ rel: `${rel}/.gitkeep`, buf: Buffer.alloc(0) }], meta: m });
  return { ruta: rel };
}

async function filesUnder(rel) {
  const out = { dirs: [], files: [] };
  await walk(rel, out);
  return out;
}

async function opMoveFolder(body) {
  const from = safeRel(body.de);
  if (!from || !(await exists(abs(from)))) throw new HttpError(404, 'La carpeta no existe.');
  const parent = safeRel(body.padre ?? dirOf(from));
  const nombre = String(body.nombre || '').trim().slice(0, 120);
  const slug = slugify(body.slug || nombre) || baseOf(from);
  if (parent == null || !validFolder(parent)) throw new HttpError(400, 'Carpeta destino no válida.');
  const to = joinRel(parent, slug);
  if (!validFolder(to)) throw new HttpError(400, 'Nombre de carpeta no válido.');
  if (parent === from || parent.startsWith(from + '/')) throw new HttpError(400, 'No se puede mover una carpeta dentro de sí misma.');

  const m = cloneMeta();
  if (to === from) {
    m.carpetas[from] = { ...(m.carpetas[from] || {}), nombre: nombre || prettify(slug) };
    await apply(`biblioteca: renombrar carpeta ${from}`, { meta: m });
    return { ruta: from };
  }
  if (await exists(abs(to))) throw new HttpError(409, 'Ya existe una carpeta con ese nombre en el destino.');

  const { files, dirs } = await filesUnder(from);
  const write = [];
  for (const f of files) {
    const nf = to + f.slice(from.length);
    write.push({ rel: nf, buf: await fsp.readFile(abs(f)) });
    if (m.documentos[f]) { m.documentos[nf] = m.documentos[f]; delete m.documentos[f]; }
    if (!baseOf(f).startsWith('.') && DOC_EXT.has(extOf(f))) redirect(m, cleanUrl(f), cleanUrl(nf));
  }
  for (const d of [from, ...dirs]) {
    const nd = to + d.slice(from.length);
    if (m.carpetas[d]) { m.carpetas[nd] = m.carpetas[d]; delete m.carpetas[d]; }
  }
  m.carpetas[to] = { ...(m.carpetas[to] || {}), nombre: nombre || (m.carpetas[to] && m.carpetas[to].nombre) || prettify(slug) };
  if (!files.length) write.push({ rel: `${to}/.gitkeep`, buf: Buffer.alloc(0) });
  await apply(`biblioteca: mover carpeta ${from} -> ${to}`, { write, remove: files, meta: m });
  await fsp.rm(abs(from), { recursive: true, force: true });
  return { ruta: to };
}

async function opDeleteFolder(body) {
  const rel = safeRel(body.ruta);
  if (!rel || !(await exists(abs(rel)))) throw new HttpError(404, 'La carpeta no existe.');
  const { files, dirs } = await filesUnder(rel);
  const m = cloneMeta();
  for (const f of files) { delete m.documentos[f]; dropRedirectsTo(m, cleanUrl(f)); }
  for (const d of [rel, ...dirs]) delete m.carpetas[d];
  await apply(`biblioteca: eliminar carpeta ${rel}`, { remove: files, meta: m });
  await fsp.rm(abs(rel), { recursive: true, force: true });
  return { ok: true, eliminados: files.length };
}

// ---------------------------------------------------------------------------
// HTTP

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...COMMON_HEADERS, ...headers });
  res.end(body);
}
function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
}

function isAuthed(req) {
  if (!CFG.pass) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const raw = Buffer.from(h.slice(6), 'base64').toString('utf8');
  const i = raw.indexOf(':');
  return i > -1 && safeEq(raw.slice(0, i), CFG.user) & safeEq(raw.slice(i + 1), CFG.pass);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers['content-length'] || 0);
    if (len > limit) return reject(new HttpError(413, `El archivo supera el máximo de ${CFG.maxMB} MB.`));
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, `El archivo supera el máximo de ${CFG.maxMB} MB.`)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req, 1024 * 1024);
  try { return JSON.parse(buf.toString('utf8') || '{}'); } catch { throw new HttpError(400, 'JSON no válido.'); }
}

async function serveFile(req, res, file, extraHeaders = {}) {
  const st = await fsp.stat(file);
  const type = MIME[extOf(file)] || 'application/octet-stream';
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const headers = {
    'Content-Type': type,
    ETag: etag,
    'Last-Modified': st.mtime.toUTCString(),
    'Cache-Control': type.startsWith('text/html') ? 'no-cache' : 'public, max-age=3600',
    ...extraHeaders,
  };
  if (req.headers['if-none-match'] === etag) return send(res, 304, null, headers);
  const gzip = COMPRESSIBLE.test(type) && st.size > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  if (gzip) { headers['Content-Encoding'] = 'gzip'; headers.Vary = 'Accept-Encoding'; } else headers['Content-Length'] = st.size;
  res.writeHead(200, { ...COMMON_HEADERS, ...headers });
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(file);
  (gzip ? stream.pipe(zlib.createGzip()) : stream).pipe(res);
}

const NOT_FOUND = `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>Strattos — No encontrado</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#151312;color:#F6F3EF;font:16px/1.5 Poppins,system-ui,sans-serif;text-align:center;padding:16px}h1{font-size:64px;margin:0;color:#F92828}a{color:#FFC47E}</style></head><body><div><h1>404</h1><p>Este documento no existe o fue movido.</p><p><a href="https://strattos.io">strattos.io</a></p></div></body></html>`;

async function serveDocument(req, res, pathname) {
  let rel;
  try { rel = safeRel(decodeURIComponent(pathname)); } catch { rel = null; }
  if (rel) {
    const candidates = extOf(rel) ? [rel] : [];
    candidates.push(`${rel}.html`, `${rel}/index.html`);
    for (const c of candidates) {
      try {
        if ((await fsp.stat(abs(c))).isFile()) return await serveFile(req, res, abs(c));
      } catch { /* siguiente candidato */ }
    }
  }
  const target = meta.redirecciones[normUrl(pathname)];
  if (target) return send(res, 301, null, { Location: target.split('/').map(encodeURIComponent).join('/') });
  send(res, 404, NOT_FOUND, { 'Content-Type': 'text/html; charset=utf-8' });
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  if (req.method !== 'GET') {
    // Protección CSRF: el navegador reenvía la autenticación básica, así que
    // exigimos una cabecera propia (fuerza preflight) y el mismo origen.
    if (req.headers['x-biblioteca'] !== '1') throw new HttpError(403, 'Petición no permitida.');
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Origen no permitido.');
  }
  if (req.method === 'GET' && p === '/api/estado') {
    const { docs, carpetas } = await scan();
    return sendJson(res, 200, {
      docs, carpetas,
      github: Boolean(CFG.ghToken), repo: CFG.ghRepo, escritura: Boolean(CFG.ghToken) || CFG.localWrites,
      maxMB: CFG.maxMB,
    });
  }
  if (req.method === 'GET' && p === '/api/verificar') {
    const folder = safeRel(url.searchParams.get('carpeta') || '');
    const file = url.searchParams.get('archivo') || '';
    const hash = url.searchParams.get('sha256') || '';
    if (folder == null) throw new HttpError(400, 'Carpeta no válida.');
    const rel = joinRel(folder, file);
    const existe = UPLOAD_EXT.test(file) && (await exists(abs(rel)));
    const { docs } = await scan();
    return sendJson(res, 200, {
      existe,
      sugerencia: existe ? await nextFree(folder, file) : null,
      duplicados: hash ? docs.filter((d) => d.sha256 === hash && d.ruta !== rel).map((d) => ({ ruta: d.ruta, nombre: d.nombre, url: d.url })) : [],
    });
  }
  if (req.method === 'POST' && p === '/api/subir') {
    const buf = await readBody(req, CFG.maxMB * 1024 * 1024);
    const q = Object.fromEntries(url.searchParams);
    return sendJson(res, 200, await exclusive(() => opUpload(q, buf)));
  }
  const ops = {
    '/api/documento/mover': opMoveDoc,
    '/api/documento/eliminar': opDeleteDoc,
    '/api/carpeta/crear': opCreateFolder,
    '/api/carpeta/mover': opMoveFolder,
    '/api/carpeta/eliminar': opDeleteFolder,
  };
  if (req.method === 'POST' && ops[p]) {
    const body = await readJson(req);
    return sendJson(res, 200, await exclusive(() => ops[p](body)));
  }
  throw new HttpError(404, 'Ruta no encontrada.');
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://local');
  const p = url.pathname;

  if (p === '/robots.txt') return send(res, 200, 'User-agent: *\nDisallow: /\n', { 'Content-Type': 'text/plain; charset=utf-8' });
  if (p === '/__salud') return send(res, 200, 'ok', { 'Content-Type': 'text/plain' });

  const isAdmin = p === '/' || p.startsWith('/__app/') || p.startsWith('/api/');
  if (isAdmin) {
    if (!isAuthed(req)) {
      return send(res, 401, 'Autenticación requerida', { 'WWW-Authenticate': 'Basic realm="Strattos", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8' });
    }
    if (p.startsWith('/api/')) return handleApi(req, res, url);
    const appHeaders = { 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-cache' };
    if (p === '/') return serveFile(req, res, path.join(CFG.appDir, 'index.html'), appHeaders);
    const name = p.slice('/__app/'.length);
    if (!/^[a-z0-9-]+\.(js|css|svg)$/.test(name)) return send(res, 404, NOT_FOUND, { 'Content-Type': 'text/html; charset=utf-8' });
    return serveFile(req, res, path.join(CFG.appDir, name), appHeaders);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Método no permitido', { Allow: 'GET, HEAD' });
  return serveDocument(req, res, p);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error('biblioteca:', err);
    if (res.headersSent) return res.destroy();
    sendJson(res, status, { error: status === 500 ? `Error interno: ${err.message}` : err.message, ...(err.extra || {}) });
  });
});
server.requestTimeout = 10 * 60 * 1000;

(async () => {
  await fsp.mkdir(CFG.root, { recursive: true });
  await loadMeta();
  server.listen(CFG.port, () => {
    console.log(`biblioteca: escuchando en :${CFG.port} · contenido ${CFG.root}`);
    console.log(CFG.pass ? `biblioteca: panel protegido (usuario ${CFG.user})` : 'biblioteca: AVISO - EXPLORER_PASSWORD no definida, el panel queda abierto');
    console.log(CFG.ghToken ? `biblioteca: cambios -> GitHub ${CFG.ghRepo}@${CFG.ghBranch}`
      : CFG.localWrites ? 'biblioteca: AVISO - sin GITHUB_TOKEN, los cambios solo se guardan en este contenedor'
        : 'biblioteca: AVISO - sin GITHUB_TOKEN, el panel funciona en solo lectura');
  });
})();
