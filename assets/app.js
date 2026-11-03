/* ===================== MobTV ===================== */
(() => {
'use strict';

const DATA = 'data/';
const PROXY = '/api/proxy?url=';           // Vercel serverless proxy
const PLACE = 'assets/logo.png';           // logo / poster fallback

/* ---------- helpers ---------- */
const $  = (s, r = document) => r.querySelector(s);
const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };
const enc = encodeURIComponent;
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const yearOf = s => { const m = String(s).match(/\b(19|20)\d{2}\b/); return m ? m[0] : ''; };
const cleanTitle = s => String(s).replace(/\b(19|20)\d{2}\b/g, '').replace(/\[[^\]]*\]|\((?:\s*\))?/g, '').replace(/\s{2,}/g, ' ').trim() || String(s);
const cache = new Map();
async function getJSON(path) {
  if (cache.has(path)) return cache.get(path);
  const p = fetch(DATA + path).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .catch(e => { cache.delete(path); throw e; });
  cache.set(path, p);
  return p;
}
function proxify(url, forceHls) {
  if (!url) return url;
  const isHls = forceHls || /\.m3u8(\?|$)/i.test(url);
  if (isHls) return PROXY + enc(url);              // HLS always via proxy (CORS + rewrite + http→https)
  if (/^http:\/\//i.test(url)) return PROXY + enc(url); // mixed content → proxy
  return url;                                       // https direct media
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2600);
}
/* localStorage safe */
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
/* http images (ex.: logos de canais) quebram numa página https (mixed content);
   roteia pelo proxy. Imagens https (ex.: pôsteres TMDB) vão direto. */
function imgSrc(src) { return /^http:\/\//i.test(src) ? PROXY + enc(src) : src; }
/* image with graceful fallback */
function poster(src, title, cls) {
  const wrap = el('div', 'poster');
  if (src) {
    const img = el('img'); img.loading = 'lazy'; img.decoding = 'async'; img.alt = title || '';
    img.src = imgSrc(src);
    img.onerror = () => { img.remove(); wrap.appendChild(el('div', 'ph', escapeHtml(cleanTitle(title)))); };
    wrap.appendChild(img);
  } else {
    wrap.appendChild(el('div', 'ph', escapeHtml(cleanTitle(title))));
  }
  return wrap;
}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}

/* ---------- icons ---------- */
const I = {
  play:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  info:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5v.5" stroke-linecap="round"/></svg>',
  search:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4" stroke-linecap="round"/></svg>',
  heart:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21s-7-4.6-9.5-9C1 9 2.5 5 6 5c2 0 3.2 1.3 4 2.5C10.8 6.3 12 5 14 5c3.5 0 5 4 3.5 7-2.5 4.4-9.5 9-9.5 9z"/></svg>',
  chevL:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M15 6l-6 6 6 6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  chevR:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M9 6l6 6-6 6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  x:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 6l12 12M18 6L6 18" stroke-linecap="round"/></svg>',
  home:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 11l9-8 9 8M5 10v10h14V10" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  tv:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 3l4 4 4-4" stroke-linecap="round"/></svg>',
};

/* ---------- favorites & continue ---------- */
const FAV = 'mobtv-fav', CONT = 'mobtv-continue';
function favs() { return LS.get(FAV, {}); }
function isFav(k) { return !!favs()[k]; }
function toggleFav(item) {
  const m = favs(); if (m[item.key]) { delete m[item.key]; toast('Removido dos favoritos'); }
  else { m[item.key] = item; toast('Adicionado aos favoritos'); }
  LS.set(FAV, m); return !!m[item.key];
}
function conts() { return LS.get(CONT, []); }
function pushCont(item, pos, dur) {
  if (!dur || dur < 60 || pos < 10) return;
  let list = conts().filter(x => x.key !== item.key);
  if (pos / dur < 0.95) list.unshift({ ...item, pos, dur, ts: Date.now() });
  LS.set(CONT, list.slice(0, 20));
}
function contPos(key) { const c = conts().find(x => x.key === key); return c ? c.pos : 0; }

/* ===================== Router ===================== */
window.addEventListener('hashchange', render);
// single persistent scroll handler (avoids leaking one per navigation)
function updateNavScroll() { const n = document.querySelector('.nav'); if (n) n.classList.toggle('scrolled', window.scrollY > 10); }
window.addEventListener('scroll', updateNavScroll, { passive: true });
// lazy-mount: run cb when element nears the viewport (falls back to immediate)
function whenVisible(elm, cb) {
  if (!('IntersectionObserver' in window)) { cb(); return; }
  const o = new IntersectionObserver(ents => {
    ents.forEach(en => { if (en.isIntersecting) { o.unobserve(en.target); cb(); } });
  }, { rootMargin: '500px' });
  o.observe(elm);
}

/* ===================== App shell ===================== */
let CATALOG = null, HOME = null, SEARCH_IDX = null;

function buildNav() {
  const nav = el('nav', 'nav');
  nav.innerHTML = `
    <a class="brand" href="#/" aria-label="MobTV início">
      <img src="${PLACE}" alt="" style="width:30px;height:30px;border-radius:8px" onerror="this.style.display='none'">
      <span><b>Mob</b>TV</span>
    </a>
    <div class="nav-links">
      <a href="#/" data-r="#/">Início</a>
      <a href="#/live" data-r="#/live">Ao Vivo</a>
      <a href="#/movies" data-r="#/movies">Filmes</a>
      <a href="#/series" data-r="#/series">Séries</a>
      <a href="#/favorites" data-r="#/favorites">Minha Lista</a>
    </div>
    <div class="nav-spacer"></div>
    <button class="nav-btn" id="btn-search" aria-label="Buscar">${I.search}</button>`;
  // active link
  const h = location.hash || '#/';
  nav.querySelectorAll('.nav-links a').forEach(a => {
    if (a.dataset.r === (h.startsWith('#/cat') ? '' : h)) a.classList.add('active');
  });
  nav.querySelector('#btn-search').onclick = openSearch;
  nav.classList.toggle('scrolled', window.scrollY > 10);
  return nav;
}

/* ---------- Card ---------- */
function card(item, kind) {
  // kind: 'movie' | 'serie' | 'channel'
  const c = el('div', 'card' + (kind === 'channel' ? ' chan' : ''));
  const title = item.t || item.name || '';
  const key = (kind[0]) + ':' + (item.slug || '') + ':' + title;
  const p = poster(item.l, title);
  if (kind === 'channel') p.insertAdjacentHTML('beforeend', `<span class="live-tag"><i></i>AO VIVO</span>`);
  else {
    const y = yearOf(title);
    if (y) p.insertAdjacentHTML('beforeend', `<span class="badge-tl">${y}</span>`);
    if (item.r) p.insertAdjacentHTML('beforeend', `<span class="rating-pill">★ ${item.r}</span>`);
  }
  p.insertAdjacentHTML('beforeend', `<div class="ov"></div><div class="play">${I.play}</div>`);
  const fav = el('button', 'fav-dot' + (isFav(key) ? ' on' : ''), I.heart);
  fav.onclick = e => { e.stopPropagation(); const on = toggleFav({ ...item, kind, key, t: title }); fav.classList.toggle('on', on); };
  p.appendChild(fav);
  c.appendChild(p);
  if (kind !== 'channel') {
    c.appendChild(el('div', 'card-t', escapeHtml(cleanTitle(title))));
  } else {
    c.appendChild(el('div', 'card-t', escapeHtml(title)));
  }
  c.onclick = () => {
    if (kind === 'channel') playNow({ title, sub: item.group || 'Ao vivo', url: item.u, type: 'live', key, poster: item.l });
    else if (kind === 'movie') openMovie(item);
    else openSerie(item);
  };
  return c;
}

/* ---------- Rail ---------- */
function rail(items, kind) {
  const wrap = el('div', 'rail-wrap');
  const r = el('div', 'rail');
  items.forEach(it => r.appendChild(card(it, kind)));
  const la = el('button', 'rail-arrow l', `<span>${I.chevL}</span>`);
  const ra = el('button', 'rail-arrow r', `<span>${I.chevR}</span>`);
  const upd = () => {
    la.toggleAttribute('disabled', r.scrollLeft < 8);
    ra.toggleAttribute('disabled', r.scrollLeft + r.clientWidth > r.scrollWidth - 8);
  };
  la.onclick = () => r.scrollBy({ left: -r.clientWidth * .8, behavior: 'smooth' });
  ra.onclick = () => r.scrollBy({ left: r.clientWidth * .8, behavior: 'smooth' });
  r.addEventListener('scroll', debounce(upd, 80), { passive: true });
  wrap.append(la, r, ra); setTimeout(upd, 60);
  return wrap;
}
function rowBlock(label, items, kind, moreHash) {
  const row = el('div', 'row');
  const head = el('div', 'row-head');
  head.innerHTML = `<h2>${escapeHtml(label)}</h2>`;
  if (moreHash) {
    const a = el('a', 'more', `Ver tudo ${I.chevR}`); a.href = moreHash; head.appendChild(a);
  }
  row.appendChild(head); row.appendChild(rail(items, kind));
  return row;
}

/* ---------- Hero ---------- */
function hero(items) {
  const h = el('section', 'hero');
  let idx = 0;
  const bg = el('div', 'hero-art');
  const bgWrap = el('div', 'hero-bg'); bgWrap.appendChild(bg);
  const c = el('div', 'hero-c');
  const dots = el('div', 'hero-dots');
  h.append(bgWrap, c, dots);
  function show(i) {
    idx = (i + items.length) % items.length;
    const it = items[idx];
    const bgUrl = it.b || it.l;
    const img = bgUrl ? `<img src="${imgSrc(bgUrl)}" alt="" onerror="this.style.visibility='hidden'">` : '';
    bg.innerHTML = img;
    const y = yearOf(it.t);
    const synopsis = it.o ? escapeHtml(it.o)
      : 'Assista agora em alta qualidade, direto no seu navegador. Milhares de filmes, séries e canais ao vivo no MobTV.';
    c.innerHTML = `
      <div class="hero-badge"><i></i> Em destaque no MobTV</div>
      <h1>${escapeHtml(cleanTitle(it.t))}</h1>
      <div class="hero-meta">
        ${it.r ? `<span class="chip star">★ ${it.r}</span>` : `<span class="chip star">★ Destaque</span>`}
        ${y ? `<span class="chip">${y}</span>` : ''}
        <span class="chip">Filme</span><span class="chip">HD</span>
      </div>
      <p>${synopsis}</p>
      <div class="hero-actions">
        <button class="btn btn-primary" id="h-play">${I.play} Assistir</button>
        <button class="btn btn-ghost" id="h-info">${I.info} Detalhes</button>
      </div>`;
    c.querySelector('#h-play').onclick = () => playNow({ title: it.t, sub: 'Filme', url: it.u, type: 'movie', key: 'm::' + it.t, poster: it.l });
    c.querySelector('#h-info').onclick = () => openMovie(it);
    dots.querySelectorAll('button').forEach((b, bi) => b.classList.toggle('on', bi === idx));
  }
  items.forEach((_, i) => { const b = el('button'); b.onclick = () => { show(i); rearm(); }; dots.appendChild(b); });
  let timer; const rearm = () => { clearTimeout(timer); timer = setTimeout(() => show(idx + 1), 8000); };
  show(0); rearm();
  h._stop = () => clearTimeout(timer);
  return h;
}

/* ===================== Pages ===================== */
function skRail() {
  const w = el('div', 'rail-wrap'); const r = el('div', 'rail');
  for (let i = 0; i < 7; i++) { const s = el('div', 'sk-card'); s.innerHTML = `<div class="poster sk"></div><div class="sk sk-line" style="width:80%"></div>`; r.appendChild(s); }
  w.appendChild(r); return w;
}

async function viewHome(app) {
  const wrap = el('div');
  const rows = el('div', 'rows');
  // placeholder while home loads
  const skHero = el('section', 'hero'); skHero.innerHTML = `<div class="hero-bg"><div class="hero-art sk" style="width:100%;height:100%"></div></div>`;
  wrap.append(skHero, rows); app.appendChild(wrap);
  for (let i = 0; i < 3; i++) rows.appendChild((() => { const row = el('div', 'row'); row.innerHTML = `<div class="row-head"><div class="sk sk-line" style="width:180px;height:18px"></div></div>`; row.appendChild(skRail()); return row; })());

  let H;
  try { H = HOME || (HOME = await getJSON('home.json')); }
  catch { rows.innerHTML = ''; rows.appendChild(errorBox('Não foi possível carregar o catálogo.')); return; }

  wrap.innerHTML = '';
  if (H.hero?.length) wrap.appendChild(hero(H.hero));
  const rs = el('div', 'rows'); wrap.appendChild(rs);

  // Ao vivo agora (primeiro trilho de canais)
  if (H.rails_live?.[0]) rs.appendChild(rowBlock('Ao vivo agora', H.rails_live[0].items, 'channel', '#/live'));
  // Filmes
  (H.rails_movies || []).forEach(r => rs.appendChild(rowBlock(prettyLabel(r.label), r.items, 'movie', '#/cat/movies/' + r.slug)));
  // Séries
  (H.rails_series || []).forEach(r => rs.appendChild(rowBlock('Séries · ' + prettyLabel(r.label), r.items, 'serie', '#/cat/series/' + r.slug)));
  // Mais canais
  (H.rails_live || []).slice(1).forEach(r => rs.appendChild(rowBlock(prettyLabel(r.label), r.items, 'channel', '#/cat/live/' + r.slug)));

  wrap.appendChild(footer());
}

function prettyLabel(l) {
  return String(l).replace(/[⭐✨⚽|=:]/g, ' ').replace(/\s{2,}/g, ' ').trim()
    .toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

/* ----- browse (list of categories of a type) ----- */
async function viewBrowse(app, type) {
  const titles = { live: 'Ao Vivo', movies: 'Filmes', series: 'Séries' };
  const page = el('div', 'page');
  page.innerHTML = `<h1 class="page-h">${titles[type]}</h1><p class="page-sub">Carregando categorias…</p>`;
  app.appendChild(page);
  try { CATALOG = CATALOG || await getJSON('catalog.json'); } catch { page.appendChild(errorBox('Falha ao carregar.')); return; }
  const cats = CATALOG[type] || [];
  page.querySelector('.page-sub').textContent = `${cats.length} categorias · ${cats.reduce((a, c) => a + c.count, 0).toLocaleString('pt-BR')} títulos`;
  for (const cat of cats) {
    const row = el('div', 'row');
    row.innerHTML = `<div class="row-head"><h2>${escapeHtml(prettyLabel(cat.label))}</h2><a class="more" href="#/cat/${type}/${cat.slug}">Ver tudo (${cat.count}) ${I.chevR}</a></div>`;
    const holder = el('div'); holder.appendChild(skRail()); row.appendChild(holder); page.appendChild(row);
    whenVisible(row, () => loadCat(type, cat.slug).then(items => {
      holder.innerHTML = '';
      holder.appendChild(rail(items.slice(0, 18), kindOf(type)));
    }).catch(() => holder.remove()));
  }
  app.appendChild(footer());
}
const kindOf = t => t === 'movies' ? 'movie' : t === 'series' ? 'serie' : 'channel';
async function loadCat(type, slug) {
  const items = await getJSON(type + '/' + slug + '.json');
  if (type === 'series') items.forEach(s => s.slug = slug);
  if (type === 'movies') items.forEach(m => m.slug = slug);
  return items;
}

/* ----- category grid (all items, paginated) ----- */
async function viewCat(app, type, slug) {
  CATALOG = CATALOG || await getJSON('catalog.json').catch(() => null);
  const meta = CATALOG?.[type]?.find(c => c.slug === slug);
  const page = el('div', 'page');
  page.innerHTML = `<h1 class="page-h">${escapeHtml(prettyLabel(meta?.label || slug))}</h1><p class="page-sub">Carregando…</p>`;
  app.appendChild(page);
  let items;
  try { items = await loadCat(type, slug); } catch { page.appendChild(errorBox('Categoria indisponível.')); return; }
  page.querySelector('.page-sub').textContent = `${items.length.toLocaleString('pt-BR')} títulos`;
  const grid = el('div', 'grid' + (type === 'live' ? ' chan' : ''));
  page.appendChild(grid);
  const kind = kindOf(type);
  let shown = 0; const STEP = 60;
  const more = el('button', 'load-more', 'Carregar mais');
  function paint() {
    items.slice(shown, shown + STEP).forEach(it => grid.appendChild(card(it, kind)));
    shown += STEP;
    more.style.display = shown >= items.length ? 'none' : 'block';
  }
  page.appendChild(more); more.onclick = paint; paint();
  app.appendChild(footer());
}

/* ----- favorites ----- */
function viewFavorites(app) {
  const page = el('div', 'page');
  const list = Object.values(favs());
  const contList = conts();
  page.innerHTML = `<h1 class="page-h">Minha Lista</h1><p class="page-sub">${list.length} favoritos</p>`;
  app.appendChild(page);
  if (contList.length) {
    const row = el('div', 'row');
    row.innerHTML = `<div class="row-head"><h2>Continuar assistindo</h2></div>`;
    const r = el('div', 'rail');
    contList.forEach(it => {
      const kind = it.type === 'live' ? 'channel' : it.type === 'serie' ? 'serie' : 'movie';
      const c = card({ t: it.title, l: it.poster, u: it.url, slug: it.slug }, kind === 'channel' ? 'channel' : 'movie');
      c.onclick = () => playNow({ ...it, key: it.key });
      r.appendChild(c);
    });
    const w = el('div', 'rail-wrap'); w.appendChild(r); row.appendChild(w); page.appendChild(row);
  }
  if (!list.length) {
    page.appendChild(emptyBox('Sua lista está vazia', 'Toque no ♥ nos títulos para salvá-los aqui.'));
  } else {
    const grid = el('div', 'grid');
    list.forEach(it => grid.appendChild(card(it, it.kind === 'channel' ? 'channel' : it.kind === 'serie' ? 'serie' : 'movie')));
    page.appendChild(grid);
  }
  app.appendChild(footer());
}

/* ===================== Modals ===================== */
function openMovie(item) {
  const title = item.t || item.name;
  const key = 'm:' + (item.slug || '') + ':' + title;
  const m = modalShell();
  const artUrl = item.b || item.l;
  const art = artUrl ? `<img src="${imgSrc(artUrl)}" alt="" onerror="this.style.visibility='hidden'">` : '';
  const y = yearOf(title);
  const synopsis = item.o ? escapeHtml(item.o)
    : 'Reprodução online em alta qualidade. Se um link estiver fora do ar, tente outro título — o catálogo vem das suas listas.';
  m.body.innerHTML = `
    <div class="sheet-hero">${art}<button class="sheet-x">${I.x}</button></div>
    <div class="sheet-body">
      <h2>${escapeHtml(cleanTitle(title))}</h2>
      <div class="sheet-meta">
        ${item.r ? `<span class="chip star">★ ${item.r}</span>` : ''}
        ${y ? `<span class="chip">${y}</span>` : ''}<span class="chip">Filme</span><span class="chip">HD</span>
      </div>
      <div class="sheet-actions">
        <button class="btn btn-primary" id="m-play">${I.play} Assistir</button>
        <button class="btn btn-ghost" id="m-fav">${I.heart} ${isFav(key) ? 'Na minha lista' : 'Minha lista'}</button>
      </div>
      <p style="color:var(--muted);line-height:1.6;max-width:620px">${synopsis}</p>
    </div>`;
  m.body.querySelector('.sheet-x').onclick = m.close;
  m.body.querySelector('#m-play').onclick = () => { m.close(); playNow({ title, sub: 'Filme', url: item.u, type: 'movie', key, poster: item.l }); };
  const fb = m.body.querySelector('#m-fav');
  fb.onclick = () => { const on = toggleFav({ ...item, kind: 'movie', key, t: title }); fb.innerHTML = `${I.heart} ${on ? 'Na minha lista' : 'Minha lista'}`; };
}

function openSerie(serie) {
  const title = serie.t;
  const key = 's:' + (serie.slug || '') + ':' + title;
  const m = modalShell();
  const artUrl = serie.b || serie.l;
  const art = artUrl ? `<img src="${imgSrc(artUrl)}" alt="" onerror="this.style.visibility='hidden'">` : '';
  // group eps by season
  const seasons = {};
  (serie.eps || []).forEach(e => { (seasons[e.s] = seasons[e.s] || []).push(e); });
  const snums = Object.keys(seasons).map(Number).sort((a, b) => a - b);
  const synopsis = serie.o ? `<p style="color:var(--muted);line-height:1.6;max-width:620px;margin:0 0 4px">${escapeHtml(serie.o)}</p>` : '';
  m.body.innerHTML = `
    <div class="sheet-hero">${art}<button class="sheet-x">${I.x}</button></div>
    <div class="sheet-body">
      <h2>${escapeHtml(cleanTitle(title))}</h2>
      <div class="sheet-meta">${serie.r ? `<span class="chip star">★ ${serie.r}</span>` : ''}<span class="chip">Série</span><span class="chip">${snums.length} temporada(s)</span><span class="chip">${(serie.eps || []).length} ep.</span></div>
      <div class="sheet-actions">
        <button class="btn btn-primary" id="s-play">${I.play} Assistir T${snums[0]}:E${seasons[snums[0]][0].e}</button>
        <button class="btn btn-ghost" id="s-fav">${I.heart} ${isFav(key) ? 'Na minha lista' : 'Minha lista'}</button>
      </div>
      ${synopsis}
      <div class="seasons"></div>
      <div class="eps"></div>
    </div>`;
  m.body.querySelector('.sheet-x').onclick = m.close;
  const seasBar = m.body.querySelector('.seasons'); const epsBox = m.body.querySelector('.eps');
  function renderSeason(s) {
    seasBar.querySelectorAll('button').forEach(b => b.classList.toggle('on', +b.dataset.s === s));
    epsBox.innerHTML = '';
    seasons[s].sort((a, b) => a.e - b.e).forEach(e => {
      const row = el('div', 'ep', `<div class="n">${e.e}</div><div><div style="font-weight:600">Episódio ${e.e}</div><div style="color:var(--muted2);font-size:12px">Temporada ${s}</div></div><div class="pl">${I.play}</div>`);
      row.onclick = () => { m.close(); playNow({ title: `${cleanTitle(title)} · T${s}E${e.e}`, sub: 'Série', url: e.u, type: 'serie', key: key + ':' + s + 'x' + e.e, poster: serie.l }); };
      epsBox.appendChild(row);
    });
  }
  snums.forEach(s => { const b = el('button', '', 'T' + s); b.dataset.s = s; b.onclick = () => renderSeason(s); seasBar.appendChild(b); });
  renderSeason(snums[0]);
  m.body.querySelector('#s-play').onclick = () => { m.close(); const e = seasons[snums[0]][0]; playNow({ title: `${cleanTitle(title)} · T${snums[0]}E${e.e}`, sub: 'Série', url: e.u, type: 'serie', key: key + ':' + snums[0] + 'x' + e.e, poster: serie.l }); };
  const fb = m.body.querySelector('#s-fav');
  fb.onclick = () => { const on = toggleFav({ ...serie, kind: 'serie', key, t: title }); fb.innerHTML = `${I.heart} ${on ? 'Na minha lista' : 'Minha lista'}`; };
}

function modalShell() {
  const back = el('div', 'modal');
  const sheet = el('div', 'sheet'); back.appendChild(sheet);
  document.body.appendChild(back); document.body.classList.add('no-scroll');
  requestAnimationFrame(() => back.classList.add('open'));
  const close = () => { back.classList.remove('open'); document.body.classList.remove('no-scroll'); setTimeout(() => back.remove(), 300); document.removeEventListener('keydown', esc); };
  const esc = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', esc);
  back.onclick = e => { if (e.target === back) close(); };
  return { back, body: sheet, close };
}

/* ===================== Player ===================== */
let curHls = null;
function playNow(info) {
  const layer = $('#player'); layer.hidden = false; document.body.classList.add('no-scroll');
  layer.innerHTML = `
    <video playsinline controls autoplay></video>
    <div class="pl-top">
      <button class="pl-back" aria-label="Voltar">${I.chevL}</button>
      <div><h3>${escapeHtml(info.title || '')}</h3><div class="sub">${escapeHtml(info.sub || '')}</div></div>
    </div>
    <div class="pl-spin"></div>
    <div class="pl-err"><div><h3>Não foi possível reproduzir</h3><p>O link pode estar fora do ar ou exigir o proxy.<br>Tente outro título.</p><button class="btn btn-ghost" id="pl-retry" style="margin-top:14px">Tentar de novo</button></div></div>`;
  const v = layer.querySelector('video');
  const spin = layer.querySelector('.pl-spin'), err = layer.querySelector('.pl-err');
  const close = () => {
    try { pushCont(info, v.currentTime, v.duration); } catch {}
    if (curHls) { curHls.destroy(); curHls = null; }
    v.pause(); v.removeAttribute('src'); v.load();
    layer.hidden = true; layer.innerHTML = ''; document.body.classList.remove('no-scroll');
    document.removeEventListener('keydown', keys);
  };
  layer.querySelector('.pl-back').onclick = close;
  const showErr = () => { spin.style.display = 'none'; err.classList.add('show'); };
  layer.querySelector('#pl-retry')?.addEventListener('click', () => { err.classList.remove('show'); start(); });

  // volume persistence
  v.volume = LS.get('mobtv-vol', 1);
  v.addEventListener('volumechange', () => LS.set('mobtv-vol', v.volume));
  v.addEventListener('playing', () => { spin.style.display = 'none'; });
  v.addEventListener('waiting', () => { if (!err.classList.contains('show')) spin.style.display = 'block'; });
  v.addEventListener('loadedmetadata', () => { const p = contPos(info.key); if (p && p < v.duration - 15) v.currentTime = p; });
  // idle UI
  let idleT; const idle = () => { layer.classList.remove('idle'); clearTimeout(idleT); idleT = setTimeout(() => layer.classList.add('idle'), 3200); };
  layer.onmousemove = idle; idle();

  function start() {
    spin.style.display = 'block'; err.classList.remove('show');
    const isHls = /\.m3u8(\?|$)/i.test(info.url) || info.type === 'live';
    const src = proxify(info.url, isHls);
    if (isHls && window.Hls && Hls.isSupported()) {
      if (curHls) curHls.destroy();
      curHls = new Hls({ maxBufferLength: 30, manifestLoadingTimeOut: 15000, fragLoadingTimeOut: 25000 });
      curHls.loadSource(src); curHls.attachMedia(v);
      curHls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) { if (d.type === Hls.ErrorTypes.NETWORK_ERROR) curHls.startLoad(); else showErr(); } });
    } else {
      v.src = src;
    }
    v.play().catch(() => {});
  }
  v.addEventListener('error', showErr);
  const keys = e => {
    if (e.key === 'Escape') close();
    else if (e.key === ' ') { e.preventDefault(); v.paused ? v.play() : v.pause(); }
    else if (e.key === 'ArrowRight') v.currentTime += 10;
    else if (e.key === 'ArrowLeft') v.currentTime -= 10;
    else if (e.key.toLowerCase() === 'f') { if (document.fullscreenElement) document.exitFullscreen(); else layer.requestFullscreen?.(); }
    else if (e.key.toLowerCase() === 'm') v.muted = !v.muted;
  };
  document.addEventListener('keydown', keys);
  start();
}

/* ===================== Search ===================== */
let searchBox;
function openSearch() {
  if (!searchBox) buildSearch();
  searchBox.classList.add('open'); document.body.classList.add('no-scroll');
  setTimeout(() => searchBox.querySelector('input').focus(), 60);
}
function buildSearch() {
  searchBox = el('div', 'search');
  searchBox.innerHTML = `
    <div class="search-top">${I.search.replace('<svg','<svg class="ic"')}
      <input type="search" placeholder="Buscar filmes, séries, canais…" autocomplete="off" spellcheck="false">
      <button class="search-close">${I.x}</button>
    </div>
    <div class="search-body"><div class="search-hint">Digite para buscar em todo o catálogo do MobTV.</div></div>`;
  document.body.appendChild(searchBox);
  const input = searchBox.querySelector('input');
  const body = searchBox.querySelector('.search-body');
  const hint = `<div class="search-hint">Digite para buscar em todo o catálogo do MobTV.</div>`;
  const close = () => {
    searchBox.classList.remove('open'); document.body.classList.remove('no-scroll');
    input.value = ''; body.innerHTML = hint;
  };
  searchBox.querySelector('.search-close').onclick = close;
  searchBox.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  const run = debounce(async q => {
    q = q.trim().toLowerCase();
    if (q.length < 2) { body.innerHTML = `<div class="search-hint">Digite para buscar em todo o catálogo do MobTV.</div>`; return; }
    body.innerHTML = `<div class="search-hint">Buscando…</div>`;
    try { SEARCH_IDX = SEARCH_IDX || await getJSON('search.json'); }
    catch { body.innerHTML = `<div class="search-hint">Índice de busca indisponível.</div>`; return; }
    const norm = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const qq = norm(q);
    const hits = [];
    for (let i = 0; i < SEARCH_IDX.length && hits.length < 60; i++) {
      if (norm(SEARCH_IDX[i][0]).includes(qq)) hits.push(SEARCH_IDX[i]);
    }
    if (!hits.length) { body.innerHTML = `<div class="search-hint">Nada encontrado para “${escapeHtml(q)}”.</div>`; return; }
    const grid = el('div', 'grid'); body.innerHTML = ''; body.appendChild(grid);
    hits.forEach(([t, type, slug]) => {
      const kind = type === 'm' ? 'movie' : type === 's' ? 'serie' : 'channel';
      const c = card({ t, l: '', slug }, kind);
      c.onclick = async () => {
        close();
        const tdir = type === 'm' ? 'movies' : type === 's' ? 'series' : 'live';
        try {
          const items = await loadCat(tdir, slug);
          const found = items.find(x => (x.t || x.name) === t) || items[0];
          if (kind === 'channel') playNow({ title: t, sub: 'Ao vivo', url: found.u, type: 'live', key: 'l:' + slug + ':' + t, poster: found.l });
          else if (kind === 'movie') openMovie(found);
          else openSerie(found);
        } catch { toast('Não foi possível abrir este título.'); }
      };
      grid.appendChild(c);
    });
  }, 220);
  input.addEventListener('input', e => run(e.target.value));
}

/* ===================== misc ui ===================== */
function errorBox(msg) { return emptyBox('Ops', msg); }
function emptyBox(t, s) {
  const e = el('div', 'empty');
  e.innerHTML = `${I.tv}<h3 style="font-family:Sora,sans-serif;margin:0 0 6px">${escapeHtml(t)}</h3><p>${escapeHtml(s || '')}</p>`;
  return e;
}
function footer() {
  const f = el('footer', 'foot');
  f.innerHTML = `<div><b>MobTV</b> · seu cinema e TV ao vivo</div><div>Conteúdo das suas listas · ${new Date().getFullYear()}</div>`;
  return f;
}

/* ===================== Render ===================== */
async function render() {
  const app = $('#app');
  // stop any running hero timer
  app.querySelectorAll('.hero').forEach(h => h._stop?.());
  app.innerHTML = ''; window.scrollTo(0, 0);
  app.appendChild(buildNav());
  const h = location.hash || '#/';
  const mcat = h.match(/^#\/cat\/(movies|series|live)\/(.+)$/);
  if (mcat) return viewCat(app, mcat[1], decodeURIComponent(mcat[2]));
  if (h === '#/live') return viewBrowse(app, 'live');
  if (h === '#/movies') return viewBrowse(app, 'movies');
  if (h === '#/series') return viewBrowse(app, 'series');
  if (h === '#/favorites') return viewFavorites(app);
  return viewHome(app);
}

/* ===================== Boot ===================== */
async function boot() {
  try { await getJSON('home.json').then(d => HOME = d); } catch {}
  $('#app').hidden = false;
  await render();
  // hide splash
  const sp = $('#splash');
  setTimeout(() => { sp.classList.add('hide'); setTimeout(() => sp.remove(), 650); }, 900);
}
document.addEventListener('DOMContentLoaded', boot);
})();
