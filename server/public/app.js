(() => {
  'use strict';

  const $ = (sel, el = document) => el.querySelector(sel);
  const state = { docs: [], carpetas: [], escritura: false, github: false, maxMB: 50 };
  const prefs = { view: 'grid', sort: 'recientes' };
  try { Object.assign(prefs, JSON.parse(localStorage.getItem('biblioteca') || '{}')); } catch { /* sin almacenamiento */ }
  const savePrefs = () => { try { localStorage.setItem('biblioteca', JSON.stringify(prefs)); } catch { /* sin almacenamiento */ } };

  // ------------------------------------------------------------------ util
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const slugify = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  const pretty = (s) => s.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  const extOf = (n) => (/\.[a-z0-9]+$/i.exec(n) || [''])[0].toLowerCase();
  const joinRel = (a, b) => (a ? `${a}/${b}` : b);
  const dirOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
  const baseOf = (rel) => rel.slice(rel.lastIndexOf('/') + 1);
  const cleanUrl = (rel) => (/(^|\/)index\.html?$/i.test(rel) ? '/' + rel.replace(/index\.html?$/i, '') : '/' + rel.replace(/\.html?$/i, ''));
  const absUrl = (url) => location.origin + url.split('/').map(encodeURIComponent).join('/');
  const kb = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
  const folderName = (rel) => (rel ? (state.carpetas.find((c) => c.ruta === rel) || {}).nombre || pretty(baseOf(rel)) : 'Inicio');
  const typeLabel = (d) => (d.tipo === 'html' ? 'HTML' : d.tipo === 'pdf' ? 'PDF' : extOf(d.ruta).slice(1).toUpperCase());

  const rtf = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });
  function ago(iso) {
    const s = (new Date(iso) - Date.now()) / 1000;
    const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
    for (const [u, sec] of units) if (Math.abs(s) >= sec) return rtf.format(Math.round(s / sec), u);
    return 'ahora';
  }

  // ------------------------------------------------------------------ carga / API
  let loading = 0;
  const busy = (d) => { loading += d; $('#loadbar').hidden = loading <= 0; };

  async function api(method, url, body) {
    busy(1);
    try {
      const res = await fetch(url, {
        method,
        headers: { 'X-Biblioteca': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        credentials: 'same-origin',
        cache: 'no-store',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { const e = new Error(data.error || `Error ${res.status}`); e.status = res.status; e.data = data; throw e; }
      return data;
    } finally { busy(-1); }
  }

  function toast(msg, type = 'ok') {
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.textContent = msg;
    $('#toasts').append(t);
    setTimeout(() => t.remove(), type === 'err' ? 6000 : 3000);
  }

  async function copy(url) {
    const full = absUrl(url);
    try { await navigator.clipboard.writeText(full); toast('Enlace copiado'); }
    catch { window.prompt('Copia el enlace:', full); }
  }

  async function load() {
    try {
      Object.assign(state, await api('GET', '/api/estado'));
      document.body.classList.toggle('readonly', !state.escritura);
      document.querySelectorAll('[data-write]').forEach((el) => { el.hidden = !state.escritura; });
      $('#status').innerHTML = `
        <span class="pill">${state.docs.length} documento${state.docs.length === 1 ? '' : 's'}</span>
        ${state.github ? `<span class="pill ok" title="${esc(state.repo)}">Sincronizado con GitHub</span>`
          : state.escritura ? '<span class="pill warn" title="Los cambios se perderán al redesplegar">Modo local (sin GitHub)</span>'
            : '<span class="pill warn" title="Define GITHUB_TOKEN para habilitar subidas">Solo lectura</span>'}`;
      render();
    } catch (e) {
      $('#main').innerHTML = `<div class="empty">No se pudo cargar la biblioteca: ${esc(e.message)}</div>`;
    }
  }

  // ------------------------------------------------------------------ render
  const cwd = () => {
    const d = decodeURIComponent(location.hash.replace(/^#\/?/, '')).replace(/\/+$/, '');
    return d && state.carpetas.some((c) => c.ruta === d) ? d : '';
  };

  const sortDocs = (list) => list.sort(prefs.sort === 'nombre'
    ? (a, b) => a.nombre.localeCompare(b.nombre, 'es')
    : (a, b) => b.actualizado.localeCompare(a.actualizado));

  function countIn(rel) {
    const p = rel + '/';
    return state.docs.filter((d) => d.ruta.startsWith(p)).length;
  }

  function folderCard(c) {
    const n = countIn(c.ruta);
    return `<a class="folder" href="#/${esc(c.ruta)}" data-folder="${esc(c.ruta)}">
      <span class="fi"><svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg></span>
      <span class="t"><div class="n">${esc(c.nombre)}</div><div class="c">${n ? `${n} documento${n === 1 ? '' : 's'}` : 'Vacía'}</div></span>
      ${state.escritura ? `<button class="kebab" data-menu-folder="${esc(c.ruta)}" aria-label="Opciones"><svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg></button>` : ''}
    </a>`;
  }

  const kebab = (d) => `<button class="kebab" data-menu-doc="${esc(d.ruta)}" aria-label="Opciones"><svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg></button>`;

  function docCard(d, showFolder) {
    const where = showFolder ? `${esc(folderName(d.carpeta))} · ` : '';
    const thumb = d.tipo === 'imagen'
      ? `<img src="${esc(d.url)}" alt="" loading="lazy">`
      : d.tipo === 'html'
        ? `<div class="ph shimmer"></div>`
        : `<div class="ph">PDF</div>`;
    return `<article class="card">
      <a class="thumb" href="${esc(d.url)}" target="_blank" rel="noopener" ${d.tipo === 'html' ? `data-thumb="${esc(d.url)}?v=${d.sha256.slice(0, 8)}"` : ''} tabindex="-1" aria-hidden="true">
        ${thumb}<span class="badge">${typeLabel(d)}</span>
      </a>
      <div class="body">
        <div class="t">
          <a class="n" href="${esc(d.url)}" target="_blank" rel="noopener" title="${esc(d.nombre)}">${esc(d.nombre)}</a>
          <div class="m">${where}${ago(d.actualizado)} · ${kb(d.size)}</div>
        </div>
        ${kebab(d)}
      </div>
      <div class="acts">
        <button class="btn sm" data-copy="${esc(d.url)}">Copiar enlace</button>
        <a class="btn sm" href="${esc(d.url)}" target="_blank" rel="noopener">Abrir</a>
      </div>
    </article>`;
  }

  function docRow(d, showFolder) {
    return `<div class="row">
      <span class="di">${typeLabel(d)}</span>
      <div class="t">
        <a class="n" href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.nombre)}</a>
        <div class="m">${esc(showFolder ? d.ruta : d.url)} · ${ago(d.actualizado)} · ${kb(d.size)}</div>
      </div>
      <button class="btn sm copy-txt" data-copy="${esc(d.url)}">Copiar enlace</button>
      ${kebab(d)}
    </div>`;
  }

  function renderDocs(list, showFolder) {
    if (!list.length) return '';
    sortDocs(list);
    return prefs.view === 'grid'
      ? `<div class="docs grid">${list.map((d) => docCard(d, showFolder)).join('')}</div>`
      : `<div class="docs list">${list.map((d) => docRow(d, showFolder)).join('')}</div>`;
  }

  function render() {
    const q = $('#q').value.trim().toLowerCase();
    $('#v-grid').classList.toggle('on', prefs.view === 'grid');
    $('#v-list').classList.toggle('on', prefs.view === 'list');
    $('#sort').value = prefs.sort;
    let html = '';

    if (q) {
      $('#crumbs').innerHTML = `<a href="#/">Inicio</a><span>/</span><span>Resultados para “${esc(q)}”</span>`;
      const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
      const nq = norm(q);
      const folders = state.carpetas.filter((c) => norm(c.nombre + ' ' + c.ruta).includes(nq));
      const docs = state.docs.filter((d) => norm(`${d.nombre} ${d.titulo} ${d.ruta}`).includes(nq));
      if (folders.length) html += `<h3 class="section">Carpetas</h3><div class="folders">${folders.map(folderCard).join('')}</div>`;
      if (docs.length) html += `<h3 class="section">Documentos</h3>${renderDocs(docs, true)}`;
      if (!html) html = '<div class="empty">Sin resultados.</div>';
    } else {
      const dir = cwd();
      const parts = dir ? dir.split('/') : [];
      $('#crumbs').innerHTML = ['<a href="#/">Inicio</a>']
        .concat(parts.map((p, i) => {
          const rel = parts.slice(0, i + 1).join('/');
          return `<span>/</span><a href="#/${esc(rel)}" data-folder="${esc(rel)}">${esc(folderName(rel))}</a>`;
        })).join('');
      const folders = state.carpetas.filter((c) => dirOf(c.ruta) === dir).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
      const docs = state.docs.filter((d) => d.carpeta === dir);
      if (folders.length) html += `<h3 class="section">Carpetas</h3><div class="folders">${folders.map(folderCard).join('')}</div>`;
      if (docs.length) html += `<h3 class="section">Documentos</h3>${renderDocs(docs, false)}`;
      if (!html) {
        html = `<div class="empty">Esta carpeta está vacía.${state.escritura ? '<br>Arrastra aquí tus archivos HTML o<br><button class="btn primary" data-act="upload">Subir documentos</button>' : ''}</div>`;
      }
    }
    $('#main').innerHTML = html;
    setupThumbs();
  }

  // ------------------------------------------------------------------ miniaturas (iframes escalados, carga diferida)
  const THUMB_W = 1440;
  const resizeObs = new ResizeObserver((entries) => {
    for (const e of entries) e.target.style.setProperty('--s', (e.contentRect.width / THUMB_W).toFixed(4));
  });
  let active = 0;
  const pending = [];
  function pump() {
    while (active < 4 && pending.length) {
      const el = pending.shift();
      if (!el.isConnected) continue;
      active++;
      const f = document.createElement('iframe');
      f.setAttribute('sandbox', 'allow-scripts');
      f.setAttribute('scrolling', 'no');
      f.setAttribute('tabindex', '-1');
      f.setAttribute('title', '');
      let done = false;
      const finish = () => {
        if (done) return;
        done = true; active--; f.classList.add('ready');
        el.querySelector('.ph')?.remove();
        pump();
      };
      f.addEventListener('load', () => setTimeout(finish, 350));
      setTimeout(finish, 15000);
      f.src = el.dataset.thumb;
      el.prepend(f);
    }
  }
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      pending.push(e.target);
    }
    pump();
  }, { rootMargin: '200px' });
  function setupThumbs() {
    pending.length = 0;
    document.querySelectorAll('.thumb').forEach((el) => {
      resizeObs.observe(el);
      if (el.dataset.thumb) io.observe(el);
    });
  }

  // ------------------------------------------------------------------ menú contextual
  const menu = $('#menu');
  function openMenu(anchor, items) {
    menu.innerHTML = items.map((it, i) => (it === '-' ? '<hr>' : `<button data-i="${i}" class="${it.danger ? 'danger' : ''}">${esc(it.label)}</button>`)).join('');
    menu.hidden = false;
    const r = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth; const mh = menu.offsetHeight;
    menu.style.left = `${Math.max(8, Math.min(r.right - mw, innerWidth - mw - 8))}px`;
    menu.style.top = `${r.bottom + mh + 8 > innerHeight ? Math.max(8, r.top - mh - 4) : r.bottom + 4}px`;
    menu.onclick = (e) => {
      const b = e.target.closest('button[data-i]');
      if (!b) return;
      menu.hidden = true;
      items[Number(b.dataset.i)].run();
    };
  }
  document.addEventListener('click', (e) => { if (!e.target.closest('#menu') && !e.target.closest('.kebab')) menu.hidden = true; });
  addEventListener('scroll', () => { menu.hidden = true; }, { passive: true });

  function docMenu(anchor, d) {
    const items = [
      { label: 'Abrir en pestaña nueva', run: () => window.open(d.url, '_blank', 'noopener') },
      { label: 'Copiar enlace', run: () => copy(d.url) },
      { label: 'Descargar', run: () => { const a = document.createElement('a'); a.href = `/${d.ruta}`; a.download = baseOf(d.ruta); a.click(); } },
    ];
    if (state.escritura) {
      items.push('-',
        { label: 'Renombrar o mover…', run: () => renameDoc(d) },
        { label: 'Reemplazar archivo…', run: () => replaceDoc(d) },
        '-',
        { label: 'Eliminar…', danger: true, run: () => deleteDoc(d) });
    }
    openMenu(anchor, items);
  }

  function folderMenu(anchor, rel) {
    openMenu(anchor, [
      { label: 'Abrir', run: () => { location.hash = `#/${rel}`; } },
      { label: 'Subir aquí…', run: () => pickFiles(rel) },
      { label: 'Nueva subcarpeta…', run: () => newFolder(rel) },
      '-',
      { label: 'Renombrar o mover…', run: () => renameFolder(rel) },
      { label: 'Eliminar…', danger: true, run: () => deleteFolder(rel) },
    ]);
  }

  // ------------------------------------------------------------------ formularios
  const dlgForm = $('#dlg-form');
  function folderOptions(selected, exclude) {
    const opts = [{ ruta: '', nombre: 'Inicio (raíz)' }]
      .concat(state.carpetas.filter((c) => !exclude || (c.ruta !== exclude && !c.ruta.startsWith(exclude + '/')))
        .sort((a, b) => a.ruta.localeCompare(b.ruta)));
    return opts.map((c) => {
      const depth = c.ruta ? c.ruta.split('/').length : 0;
      return `<option value="${esc(c.ruta)}" ${c.ruta === selected ? 'selected' : ''}>${'  '.repeat(depth)}${esc(c.ruta ? c.nombre : c.nombre)}</option>`;
    }).join('');
  }

  // fields: [{name, label, type, value, options(html), hint, attrs}]
  function openForm({ title, ok, danger, fields, html, onInput, onSubmit }) {
    $('#form-title').textContent = title;
    $('#form-ok').textContent = ok;
    $('#form-ok').className = `btn ${danger ? 'danger' : 'primary'}`;
    $('#form-error').hidden = true;
    $('#form-fields').innerHTML = (html || '') + (fields || []).map((f) => {
      if (f.type === 'check') {
        return `<label class="check" data-wrap="${f.name}"><input type="checkbox" name="${f.name}" ${f.value ? 'checked' : ''}><span>${esc(f.label)}</span></label>`;
      }
      const input = f.type === 'select'
        ? `<select name="${f.name}">${f.options}</select>`
        : `<input name="${f.name}" value="${esc(f.value ?? '')}" ${f.attrs || ''} autocomplete="off">`;
      return `<label class="field" data-wrap="${f.name}"><span>${esc(f.label)}</span>${input}${f.hint !== undefined ? `<small data-hint="${f.name}">${esc(f.hint)}</small>` : ''}</label>`;
    }).join('');
    const form = $('#form');
    const values = () => Object.fromEntries([...form.elements].filter((e) => e.name).map((e) => [e.name, e.type === 'checkbox' ? e.checked : e.value]));
    const update = (e) => onInput && onInput(values(), form, e);
    form.oninput = update;
    update();
    form.onsubmit = async (e) => {
      if (e.submitter && e.submitter.value === 'cancel') return;
      e.preventDefault();
      const btn = $('#form-ok');
      btn.disabled = true;
      try {
        await onSubmit(values());
        dlgForm.close();
      } catch (err) {
        $('#form-error').textContent = err.message;
        $('#form-error').hidden = false;
      } finally { btn.disabled = false; }
    };
    dlgForm.showModal();
    const first = form.querySelector('input:not([type=checkbox]),select');
    if (first) { first.focus(); if (first.select) first.select(); }
  }
  const setHint = (form, name, text) => { const h = form.querySelector(`[data-hint="${name}"]`); if (h) h.textContent = text; };
  const showWrap = (form, name, show) => { const w = form.querySelector(`[data-wrap="${name}"]`); if (w) w.hidden = !show; };

  function newFolder(parent = cwd()) {
    openForm({
      title: 'Nueva carpeta', ok: 'Crear',
      fields: [
        { name: 'nombre', label: 'Nombre', value: '', hint: '', attrs: 'required maxlength="120" placeholder="Ej. Jabonería Wilson"' },
        { name: 'padre', label: 'Dentro de', type: 'select', options: folderOptions(parent) },
      ],
      onInput: (v, form) => setHint(form, 'nombre', v.nombre ? `URL: ${cleanUrl(joinRel(v.padre, slugify(v.nombre)))}/…` : 'Se usará para la URL (sin tildes ni espacios).'),
      onSubmit: async (v) => {
        const r = await api('POST', '/api/carpeta/crear', { padre: v.padre, nombre: v.nombre });
        toast('Carpeta creada');
        location.hash = `#/${r.ruta}`;
        await load();
      },
    });
  }

  function renameFolder(rel) {
    const c = state.carpetas.find((x) => x.ruta === rel);
    const n = countIn(rel);
    openForm({
      title: 'Renombrar o mover carpeta', ok: 'Guardar',
      fields: [
        { name: 'nombre', label: 'Nombre visible', value: c.nombre, attrs: 'required maxlength="120"' },
        { name: 'slug', label: 'Nombre en la URL', value: baseOf(rel), hint: '', attrs: 'required pattern="[a-z0-9](?:[a-z0-9]|-)*"' },
        { name: 'padre', label: 'Dentro de', type: 'select', options: folderOptions(dirOf(rel), rel) },
      ],
      onInput: (v, form, e) => {
        if (e && e.target && e.target.name === 'nombre') { form.elements.slug.value = slugify(v.nombre); v.slug = form.elements.slug.value; }
        const to = joinRel(v.padre, slugify(v.slug));
        setHint(form, 'slug', to === rel ? `URL: /${rel}/…`
          : `Nueva URL: /${to}/… · ${n} enlace${n === 1 ? '' : 's'} antiguo${n === 1 ? '' : 's'} se redirigirá${n === 1 ? '' : 'n'} automáticamente.`);
      },
      onSubmit: async (v) => {
        const r = await api('POST', '/api/carpeta/mover', { de: rel, nombre: v.nombre, slug: slugify(v.slug), padre: v.padre });
        toast('Carpeta actualizada');
        if (cwd() === rel || cwd().startsWith(rel + '/')) location.hash = `#/${r.ruta}`;
        await load();
      },
    });
  }

  function deleteFolder(rel) {
    const n = countIn(rel);
    openForm({
      title: 'Eliminar carpeta', ok: 'Eliminar', danger: true,
      html: `<p style="margin:0">Se eliminará <b>${esc(folderName(rel))}</b>${n ? ` y sus <b>${n} documento${n === 1 ? '' : 's'}</b>. Los enlaces compartidos dejarán de funcionar` : ''}.</p>
             <p style="margin:0;color:var(--muted);font-size:12px">Todo queda en el historial de GitHub y se puede recuperar desde ahí.</p>`,
      fields: n ? [{ name: 'confirm', label: `Escribe “${baseOf(rel)}” para confirmar`, value: '', attrs: 'required' }] : [],
      onSubmit: async (v) => {
        if (n && v.confirm.trim() !== baseOf(rel)) throw new Error('El texto de confirmación no coincide.');
        await api('POST', '/api/carpeta/eliminar', { ruta: rel });
        toast('Carpeta eliminada');
        if (cwd() === rel || cwd().startsWith(rel + '/')) location.hash = `#/${dirOf(rel)}`;
        await load();
      },
    });
  }

  function renameDoc(d) {
    const ext = extOf(d.ruta);
    const base = baseOf(d.ruta).slice(0, -ext.length);
    openForm({
      title: 'Renombrar o mover documento', ok: 'Guardar',
      fields: [
        { name: 'nombre', label: 'Nombre visible', value: d.nombre, attrs: 'required maxlength="160"' },
        { name: 'slug', label: 'Nombre en la URL', value: base, hint: '', attrs: 'required pattern="[a-z0-9](?:[a-z0-9]|-)*"' },
        { name: 'carpeta', label: 'Carpeta', type: 'select', options: folderOptions(d.carpeta) },
        { name: 'redirigir', label: 'Redirigir el enlace antiguo al nuevo (recomendado si ya lo compartiste)', type: 'check', value: true },
      ],
      onInput: (v, form, e) => {
        if (e && e.target && e.target.name === 'nombre' && form.elements.slug.dataset.touched !== '1') {
          form.elements.slug.value = slugify(v.nombre); v.slug = form.elements.slug.value;
        }
        if (e && e.target && e.target.name === 'slug') form.elements.slug.dataset.touched = '1';
        const to = joinRel(v.carpeta, slugify(v.slug) + ext);
        const changed = to !== d.ruta;
        setHint(form, 'slug', changed ? `Nueva URL: ${cleanUrl(to)}` : `URL: ${d.url} (sin cambios)`);
        showWrap(form, 'redirigir', changed);
      },
      onSubmit: async (v) => {
        try {
          await api('POST', '/api/documento/mover', { de: d.ruta, nombre: v.nombre, carpeta: v.carpeta, archivo: slugify(v.slug) + ext, redirigir: v.redirigir });
        } catch (e) {
          if (e.status === 409 && e.data.sugerencia) throw new Error(`${e.message} Prueba con “${e.data.sugerencia.replace(/\.[a-z0-9]+$/, '')}”.`);
          throw e;
        }
        toast('Documento actualizado');
        await load();
      },
    });
  }

  function deleteDoc(d) {
    openForm({
      title: 'Eliminar documento', ok: 'Eliminar', danger: true,
      html: `<p style="margin:0">Se eliminará <b>${esc(d.nombre)}</b>. El enlace <code>${esc(d.url)}</code> dejará de funcionar.</p>
             <p style="margin:0;color:var(--muted);font-size:12px">Queda en el historial de GitHub y se puede recuperar desde ahí.</p>`,
      onSubmit: async () => {
        await api('POST', '/api/documento/eliminar', { ruta: d.ruta });
        toast('Documento eliminado');
        await load();
      },
    });
  }

  // ------------------------------------------------------------------ subida
  const dlgUp = $('#dlg-upload');
  let queue = [];
  let uploading = false;
  let replaceTarget = null;

  async function fileSha(file) {
    if (!(crypto && crypto.subtle)) return '';
    const h = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function addFiles(files, folder, fixed) {
    const allowed = /\.(html?|pdf|png|jpe?g|webp|gif|svg)$/i;
    for (const file of files) {
      const ext0 = extOf(file.name);
      const it = {
        id: Math.random().toString(36).slice(2),
        file, carpeta: folder, state: 'checking', progress: 0, slugTouched: false,
        ext: ext0 === '.htm' ? '.html' : ext0 === '.jpeg' ? '.jpg' : ext0,
        reemplazar: false, check: null, error: '',
      };
      if (!allowed.test(file.name)) { it.state = 'error'; it.error = 'Tipo de archivo no admitido. Usa .html, .pdf o imágenes.'; }
      else if (file.size > state.maxMB * 1048576) { it.state = 'error'; it.error = `Supera el máximo de ${state.maxMB} MB.`; }
      let title = '';
      if (it.ext === '.html' && !it.error) {
        const head = await file.slice(0, 65536).text();
        const m = /<title[^>]*>([^<]*)<\/title>/i.exec(head);
        if (m) title = m[1].replace(/\s+/g, ' ').trim().replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
      }
      it.nombre = title || pretty(file.name);
      it.slug = slugify(title || file.name.replace(/\.[a-z0-9]+$/i, '')) || 'documento';
      if (fixed) {
        Object.assign(it, { carpeta: fixed.carpeta, slug: baseOf(fixed.ruta).replace(/\.[a-z0-9]+$/i, ''), nombre: fixed.nombre, reemplazar: true, fixed: true, slugTouched: true });
        if (extOf(fixed.ruta) !== it.ext) { it.state = 'error'; it.error = `El archivo de reemplazo debe ser ${extOf(fixed.ruta)}.`; }
      }
      queue.push(it);
      renderQueue();
      if (!it.error) {
        it.sha = await fileSha(file).catch(() => '');
        await checkItem(it);
      }
    }
  }

  const itemRel = (it) => joinRel(it.carpeta, `${slugify(it.slug)}${it.ext}`);

  let checkSeq = 0;
  async function checkItem(it) {
    if (['uploading', 'saving', 'done'].includes(it.state)) return;
    const seq = ++checkSeq; it.seq = seq;
    it.state = 'checking'; renderQueue();
    try {
      const qs = new URLSearchParams({ carpeta: it.carpeta, archivo: `${slugify(it.slug)}${it.ext}`, sha256: it.sha || '' });
      const r = await api('GET', `/api/verificar?${qs}`);
      if (it.seq !== seq) return;
      it.check = r;
      it.state = r.existe && !it.reemplazar ? 'conflict'
        : r.duplicados.length && !it.dupOk ? 'duplicate' : 'ready';
    } catch (e) { it.state = 'error'; it.error = e.message; }
    renderQueue();
  }

  const STATUS = { checking: 'Verificando…', ready: 'Listo para subir', conflict: 'Ya existe', duplicate: 'Duplicado', uploading: 'Subiendo…', saving: 'Guardando en GitHub…', done: 'Publicado', error: 'Error' };

  function renderQueue() {
    const box = $('#queue');
    if (!queue.length) {
      box.innerHTML = '<div class="empty">Arrastra archivos aquí o usa “Añadir más”.</div>';
    }
    // Conservamos foco y cursor de los inputs mientras se re-renderiza.
    const act = document.activeElement;
    const focus = act && act.dataset && act.dataset.qid ? { id: act.dataset.qid, f: act.dataset.f, s: act.selectionStart } : null;
    if (queue.length) box.innerHTML = queue.map((it) => {
      const rel = itemRel(it);
      const notes = [];
      if (it.error) notes.push(`<div class="note err">${esc(it.error)}</div>`);
      if (it.state === 'conflict') {
        notes.push(`<div class="note warn">Ya existe un documento en <b>${esc(cleanUrl(rel))}</b>.
          <button type="button" class="btn sm" data-q="replace" data-id="${it.id}">Reemplazarlo</button>
          ${it.check && it.check.sugerencia ? `<button type="button" class="btn sm" data-q="suggest" data-id="${it.id}">Guardar como “${esc(it.check.sugerencia.replace(/\.[a-z0-9]+$/, ''))}”</button>` : ''}</div>`);
      } else if (it.reemplazar && it.check && it.check.existe && it.state !== 'done') {
        notes.push(`<div class="note warn">Se reemplazará el documento existente en <b>${esc(cleanUrl(rel))}</b> (el enlace no cambia).${it.fixed ? '' : ` <button type="button" class="btn sm" data-q="unreplace" data-id="${it.id}">No reemplazar</button>`}</div>`);
      }
      if (it.check && it.check.duplicados && it.check.duplicados.length && it.state !== 'done') {
        notes.push(`<div class="note warn">Este mismo archivo ya está publicado: ${it.check.duplicados.map((d) => `<a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.nombre)}</a>`).join(', ')}.
          <button type="button" class="btn sm" data-q="remove" data-id="${it.id}">No subir</button>
          ${it.state === 'duplicate' ? `<button type="button" class="btn sm" data-q="dupok" data-id="${it.id}">Subir de todas formas</button>` : ''}</div>`);
      }
      if (it.state === 'done') {
        notes.push(`<div class="note ok">Publicado en <a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(absUrl(it.url))}</a>
          <button type="button" class="btn sm" data-q="copy" data-id="${it.id}">Copiar enlace</button></div>`);
      }
      const bar = it.state === 'uploading' ? `<div class="bar"><span style="width:${it.progress}%"></span></div>`
        : it.state === 'saving' ? '<div class="bar indet"><span></span></div>'
          : it.state === 'done' ? '<div class="bar done"><span></span></div>' : '';
      const cls = it.state === 'done' ? 'done' : (it.state === 'uploading' || it.state === 'saving') ? 'busy' : '';
      return `<div class="qi ${cls}">
        <div class="qi-head">
          <span class="di">${esc(it.ext.slice(1).toUpperCase())}</span>
          <div class="t"><div>${esc(it.nombre)}</div><div class="f">${esc(it.file.name)} · ${kb(it.file.size)}</div></div>
          <span class="st">${it.state === 'uploading' ? `${it.progress}%` : STATUS[it.state]}</span>
          ${['uploading', 'saving'].includes(it.state) ? '' : `<button type="button" class="kebab" data-q="remove" data-id="${it.id}" aria-label="Quitar">×</button>`}
        </div>
        ${it.error && !it.file ? '' : `<div class="qi-grid">
          <label class="field"><span>Nombre visible</span><input data-qid="${it.id}" data-f="nombre" value="${esc(it.nombre)}" maxlength="160"></label>
          <label class="field"><span>Carpeta</span><select data-qid="${it.id}" data-f="carpeta" ${it.fixed ? 'disabled' : ''}>${folderOptions(it.carpeta)}</select></label>
          <label class="field" style="grid-column:1/-1"><span>Nombre en la URL</span><input data-qid="${it.id}" data-f="slug" value="${esc(it.slug)}" ${it.fixed ? 'disabled' : ''} pattern="[a-z0-9](?:[a-z0-9]|-)*"></label>
        </div>
        <div class="url">Enlace: <b>${esc(location.host + cleanUrl(rel))}</b></div>`}
        ${bar}${notes.join('')}
      </div>`;
    }).join('');
    if (focus) {
      const el = box.querySelector(`[data-qid="${focus.id}"][data-f="${focus.f}"]`);
      if (el) { el.focus(); try { el.setSelectionRange(focus.s, focus.s); } catch { /* select */ } }
    }
    const ready = queue.filter((it) => it.state === 'ready');
    const go = $('#up-go');
    go.disabled = uploading || !ready.length;
    go.textContent = uploading ? 'Subiendo…' : ready.length ? `Subir ${ready.length} documento${ready.length === 1 ? '' : 's'}` : 'Subir';
    $('#up-cancel').textContent = queue.length && queue.every((it) => it.state === 'done' || it.state === 'error') ? 'Cerrar' : 'Cancelar';
  }

  let checkTimer;
  $('#queue').addEventListener('input', (e) => {
    const el = e.target;
    const it = queue.find((x) => x.id === el.dataset.qid);
    if (!it) return;
    if (el.dataset.f === 'nombre') {
      it.nombre = el.value;
      if (!it.slugTouched) it.slug = slugify(el.value) || it.slug;
    } else if (el.dataset.f === 'slug') {
      it.slugTouched = true;
      it.slug = el.value.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    } else if (el.dataset.f === 'carpeta') {
      it.carpeta = el.value;
    }
    if (el.dataset.f !== 'nombre' || !it.slugTouched) {
      it.reemplazar = it.fixed ? true : false;
      renderQueue();
      clearTimeout(checkTimer);
      checkTimer = setTimeout(() => checkItem(it), 350);
    } else renderQueue();
  });

  $('#queue').addEventListener('click', (e) => {
    const b = e.target.closest('[data-q]');
    if (!b) return;
    const it = queue.find((x) => x.id === b.dataset.id);
    if (!it) return;
    const a = b.dataset.q;
    if (a === 'remove') { queue = queue.filter((x) => x !== it); renderQueue(); }
    if (a === 'replace') { it.reemplazar = true; checkItem(it); }
    if (a === 'dupok') { it.dupOk = true; it.state = 'ready'; renderQueue(); }
    if (a === 'unreplace') { it.reemplazar = false; it.state = 'conflict'; renderQueue(); }
    if (a === 'suggest') { it.slug = it.check.sugerencia.replace(/\.[a-z0-9]+$/, ''); it.slugTouched = true; checkItem(it); }
    if (a === 'copy') copy(it.url);
  });

  function uploadOne(it) {
    return new Promise((resolve) => {
      const qs = new URLSearchParams({ carpeta: it.carpeta, archivo: `${slugify(it.slug)}${it.ext}`, nombre: it.nombre.trim(), reemplazar: it.reemplazar ? '1' : '0' });
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/subir?${qs}`);
      xhr.setRequestHeader('X-Biblioteca', '1');
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      it.state = 'uploading'; it.progress = 0; it.error = ''; renderQueue();
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        it.progress = Math.round((e.loaded / e.total) * 100);
        updateTotal();
        renderQueue();
      };
      xhr.upload.onload = () => { it.progress = 100; it.state = 'saving'; updateTotal(); renderQueue(); };
      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch { /* sin cuerpo */ }
        if (xhr.status === 200) { it.state = 'done'; it.url = data.url; }
        else if (xhr.status === 409) { it.state = 'conflict'; it.check = { ...(it.check || {}), existe: true, sugerencia: data.sugerencia }; }
        else { it.state = 'error'; it.error = data.error || `Error ${xhr.status}`; }
        renderQueue(); resolve();
      };
      xhr.onerror = () => { it.state = 'error'; it.error = 'Error de red. Revisa tu conexión e inténtalo de nuevo.'; renderQueue(); resolve(); };
      xhr.send(it.file);
    });
  }

  let batch = [];
  function updateTotal() {
    const tot = $('#total');
    if (!batch.length) { tot.hidden = true; return; }
    tot.hidden = false;
    const bytes = batch.reduce((s, it) => s + it.file.size, 0) || 1;
    const sent = batch.reduce((s, it) => s + it.file.size * ((it.state === 'done' || it.state === 'saving') ? 1 : it.state === 'uploading' ? it.progress / 100 : 0), 0);
    const doneN = batch.filter((it) => it.state === 'done').length;
    const pct = Math.round((sent / bytes) * 100);
    tot.querySelector('.bar span').style.width = `${pct}%`;
    tot.querySelector('small').textContent = `${doneN} de ${batch.length} publicados · ${pct}% enviado`;
  }

  $('#up-go').addEventListener('click', async () => {
    batch = queue.filter((it) => it.state === 'ready');
    if (!batch.length) return;
    uploading = true; renderQueue(); updateTotal();
    for (const it of batch) { await uploadOne(it); updateTotal(); }
    uploading = false;
    const ok = batch.filter((it) => it.state === 'done').length;
    if (ok) toast(`${ok} documento${ok === 1 ? '' : 's'} publicado${ok === 1 ? '' : 's'}`);
    renderQueue();
    await load();
  });

  dlgUp.addEventListener('cancel', (e) => { if (uploading) e.preventDefault(); });
  dlgUp.addEventListener('close', () => {
    if (uploading) return;
    queue = []; batch = []; $('#total').hidden = true;
  });
  $('#up-cancel').addEventListener('click', (e) => { if (uploading) e.preventDefault(); });

  function openUpload() { if (!dlgUp.open) dlgUp.showModal(); renderQueue(); }

  let pickFolder = null;
  function pickFiles(folder = cwd()) { pickFolder = folder; $('#file-input').value = ''; $('#file-input').click(); }
  $('#file-input').addEventListener('change', (e) => {
    if (!e.target.files.length) return;
    const folder = pickFolder ?? cwd();
    pickFolder = null;
    openUpload();
    addFiles([...e.target.files], folder);
  });
  $('#add-more').addEventListener('click', () => pickFiles(queue.length ? queue[queue.length - 1].carpeta : cwd()));

  function replaceDoc(d) { replaceTarget = d; $('#replace-input').value = ''; $('#replace-input').click(); }
  $('#replace-input').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f || !replaceTarget) return;
    queue = queue.filter((it) => it.state !== 'done');
    openUpload();
    addFiles([f], replaceTarget.carpeta, replaceTarget);
  });

  // Arrastrar y soltar (sobre la página o sobre una carpeta concreta).
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  addEventListener('dragenter', (e) => {
    if (!hasFiles(e) || !state.escritura) return;
    e.preventDefault(); dragDepth++;
    $('#drop-target').textContent = folderName(cwd());
    if (!dlgUp.open) $('#drop').hidden = false;
  });
  addEventListener('dragover', (e) => {
    if (!hasFiles(e) || !state.escritura) return;
    e.preventDefault();
    document.querySelectorAll('.folder.drop-ok').forEach((f) => f.classList.remove('drop-ok'));
    const f = e.target.closest && e.target.closest('[data-folder]');
    if (f) f.classList.add('drop-ok');
    $('#drop-target').textContent = folderName(f ? f.dataset.folder : cwd());
  });
  addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    if (--dragDepth <= 0) { dragDepth = 0; $('#drop').hidden = true; }
  });
  addEventListener('drop', (e) => {
    if (!hasFiles(e) || !state.escritura) return;
    e.preventDefault(); dragDepth = 0; $('#drop').hidden = true;
    document.querySelectorAll('.folder.drop-ok').forEach((f) => f.classList.remove('drop-ok'));
    const f = e.target.closest && e.target.closest('[data-folder]');
    const folder = f ? f.dataset.folder : (dlgUp.open && queue.length ? queue[queue.length - 1].carpeta : cwd());
    openUpload();
    addFiles([...e.dataTransfer.files], folder);
  });
  // El overlay no recibe eventos; la página entera es la zona de soltar.
  $('#drop').style.pointerEvents = 'none';

  // ------------------------------------------------------------------ eventos generales
  $('#main').addEventListener('click', (e) => {
    const c = e.target.closest('[data-copy]');
    if (c) { e.preventDefault(); copy(c.dataset.copy); return; }
    const md = e.target.closest('[data-menu-doc]');
    if (md) { e.preventDefault(); e.stopPropagation(); docMenu(md, state.docs.find((d) => d.ruta === md.dataset.menuDoc)); return; }
    const mf = e.target.closest('[data-menu-folder]');
    if (mf) { e.preventDefault(); e.stopPropagation(); folderMenu(mf, mf.dataset.menuFolder); return; }
    const act = e.target.closest('[data-act="upload"]');
    if (act) pickFiles();
  });
  $('#upload').addEventListener('click', () => pickFiles());
  $('#new-folder').addEventListener('click', () => newFolder());
  $('#q').addEventListener('input', render);
  $('#sort').addEventListener('change', (e) => { prefs.sort = e.target.value; savePrefs(); render(); });
  $('#v-grid').addEventListener('click', () => { prefs.view = 'grid'; savePrefs(); render(); });
  $('#v-list').addEventListener('click', () => { prefs.view = 'list'; savePrefs(); render(); });
  addEventListener('hashchange', () => { $('#q').value = ''; render(); scrollTo(0, 0); });
  addEventListener('keydown', (e) => {
    if (e.key === '/' && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) && !document.querySelector('dialog[open]')) {
      e.preventDefault(); $('#q').focus();
    }
    if (e.key === 'Escape') menu.hidden = true;
  });
  addEventListener('beforeunload', (e) => { if (uploading) { e.preventDefault(); e.returnValue = ''; } });

  load();
})();
