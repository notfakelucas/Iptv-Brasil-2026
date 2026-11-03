// Sync da "Minha Lista" e do "Continuar assistindo" entre dispositivos.
// Conta = um código aleatório (sem senha). Tudo passa por aqui: o cliente nunca
// vê a senha nem o host do banco. Fala o protocolo Redis nativo (RESP) direto
// por TCP — sem dependências, só built-ins. Serve Redis Cloud (redis://) e
// Vercel KV / Upstash (rediss://, com TLS).
//
//   GET  /api/sync?code=XXXX                     -> blob salvo (merge pronto)
//   POST /api/sync {code, favs, favRm, cont}     -> faz merge e devolve
//
// Sem REDIS_URL configurada, responde 503 e o cliente degrada sem quebrar.

const net = require('node:net');
const tls = require('node:tls');

const REDIS_URL =
  process.env.REDIS_URL ||
  process.env.KV_URL ||
  process.env.STORAGE_REDIS_URL ||
  '';

const TTL = 60 * 60 * 24 * 365;     // 1 ano sem uso -> expira sozinho
const MAX_BODY = 512 * 1024;        // teto do corpo do POST
const MAX_FAVS = 1000;              // tetos de sanidade
const MAX_CONT = 40;
const CODE_RE = /^[A-Z0-9]{6,32}$/;

/* ---------- cliente Redis mínimo (RESP sobre TCP) ---------- */
function encodeCmd(args) {
  const parts = [Buffer.from(`*${args.length}\r\n`)];
  for (const a of args) {
    const b = Buffer.isBuffer(a) ? a : Buffer.from(String(a));
    parts.push(Buffer.from(`$${b.length}\r\n`), b, Buffer.from('\r\n'));
  }
  return Buffer.concat(parts);
}
// parseia UMA resposta a partir de buf[off]; null se ainda incompleta
function parseReply(buf, off) {
  if (off >= buf.length) return null;
  const type = buf[off];
  const nl = buf.indexOf('\r\n', off);
  if (nl === -1) return null;
  const line = buf.toString('utf8', off + 1, nl);
  const next = nl + 2;
  if (type === 0x2b) return { val: line, off: next };               // +simple
  if (type === 0x2d) return { val: new Error(line), off: next };    // -error
  if (type === 0x3a) return { val: parseInt(line, 10), off: next }; // :int
  if (type === 0x24) {                                             // $bulk
    const len = parseInt(line, 10);
    if (len === -1) return { val: null, off: next };
    if (next + len + 2 > buf.length) return null;
    return { val: buf.toString('utf8', next, next + len), off: next + len + 2 };
  }
  if (type === 0x2a) {                                             // *array
    const n = parseInt(line, 10);
    if (n === -1) return { val: null, off: next };
    let o = next; const arr = [];
    for (let i = 0; i < n; i++) { const r = parseReply(buf, o); if (!r) return null; arr.push(r.val); o = r.off; }
    return { val: arr, off: o };
  }
  return null;
}
// abre conexão, autentica, manda os comandos, devolve as respostas (sem a do AUTH)
function redis(cmds) {
  const u = new URL(REDIS_URL);
  const useTls = u.protocol === 'rediss:';
  const pass = decodeURIComponent(u.password || '');
  const user = decodeURIComponent(u.username || '');
  const pre = pass ? [user && user !== 'default' ? ['AUTH', user, pass] : ['AUTH', pass]] : [];
  const all = pre.concat(cmds);

  return new Promise((resolve, reject) => {
    const opts = { host: u.hostname, port: +(u.port || 6379) };
    const sock = useTls ? tls.connect({ ...opts, servername: u.hostname }) : net.connect(opts);
    let buf = Buffer.alloc(0);
    const replies = [];
    let done = false;
    const finish = (err) => { if (done) return; done = true; try { sock.destroy(); } catch {} err ? reject(err) : resolve(replies.slice(pre.length)); };
    sock.setTimeout(8000, () => finish(new Error('redis timeout')));
    sock.once(useTls ? 'secureConnect' : 'connect', () => sock.write(Buffer.concat(all.map(encodeCmd))));
    sock.on('error', finish);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      let off = 0, r;
      while ((r = parseReply(buf, off))) {
        replies.push(r.val); off = r.off;
        if (replies.length >= all.length) {
          if (pre.length && replies[0] instanceof Error) return finish(replies[0]); // AUTH falhou
          return finish();
        }
      }
      buf = buf.subarray(off);
    });
  });
}
async function kvGet(key) { const [r] = await redis([['GET', key]]); if (r instanceof Error) throw r; return r; }
async function kvSet(key, val) { const [r] = await redis([['SET', key, val, 'EX', String(TTL)]]); if (r instanceof Error) throw r; return r; }

const keyFor = code => `mobtv:sync:${code}`;
const now = () => Date.now();

/* ---------- modelo + merge ---------- */
function empty() { return { v: 1, favs: {}, favRm: {}, cont: [], updated: 0 }; }

// normaliza um blob vindo do cliente/banco para a forma canônica (defensivo)
function clean(x) {
  const o = empty();
  if (!x || typeof x !== 'object') return o;
  if (x.favs && typeof x.favs === 'object') {
    for (const k of Object.keys(x.favs).slice(0, MAX_FAVS)) {
      const it = x.favs[k];
      if (it && typeof it === 'object') o.favs[k] = { ...it, _ts: +it._ts || 0 };
    }
  }
  if (x.favRm && typeof x.favRm === 'object') {
    for (const k of Object.keys(x.favRm).slice(0, MAX_FAVS)) {
      const ts = +x.favRm[k] || 0;
      if (ts) o.favRm[k] = ts;
    }
  }
  if (Array.isArray(x.cont)) {
    o.cont = x.cont
      .filter(it => it && typeof it === 'object' && it.key)
      .map(it => ({ ...it, ts: +it.ts || 0 }))
      .slice(0, MAX_CONT);
  }
  return o;
}

// merge last-write-wins: favorito existe sse o add mais recente vence o remove
function merge(a, b) {
  a = clean(a); b = clean(b);
  const out = empty();

  const rm = {};
  for (const m of [a.favRm, b.favRm]) for (const k in m) rm[k] = Math.max(rm[k] || 0, m[k]);

  const adds = {};
  for (const m of [a.favs, b.favs]) for (const k in m) {
    if (!adds[k] || (m[k]._ts || 0) >= (adds[k]._ts || 0)) adds[k] = m[k];
  }

  for (const k in adds) {
    const at = adds[k]._ts || 0, rt = rm[k] || 0;
    if (at > rt) out.favs[k] = adds[k];
  }
  for (const k in rm) {
    const at = adds[k] ? (adds[k]._ts || 0) : 0;
    if (rm[k] >= at) out.favRm[k] = rm[k];
  }

  const cm = {};
  for (const it of a.cont.concat(b.cont)) {
    const cur = cm[it.key];
    if (!cur || it.ts >= cur.ts) cm[it.key] = it;
  }
  out.cont = Object.values(cm).sort((x, y) => y.ts - x.ts).slice(0, MAX_CONT);

  out.updated = now();
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '', over = false;
    req.on('data', c => {
      if (over) return;
      data += c;
      if (data.length > MAX_BODY) { over = true; reject(new Error('body too large')); }
    });
    req.on('end', () => { if (!over) resolve(data); });
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');

  if (!REDIS_URL) {
    res.statusCode = 503;
    res.end(JSON.stringify({ error: 'sync_unavailable' }));
    return;
  }

  try {
    const host = req.headers.host;
    const url = new URL(req.url, `https://${host}`);
    const method = (req.method || 'GET').toUpperCase();
    let code = (url.searchParams.get('code') || '').toUpperCase().trim();

    if (method === 'GET') {
      if (!CODE_RE.test(code)) { res.statusCode = 400; res.end(JSON.stringify({ error: 'bad_code' })); return; }
      const raw = await kvGet(keyFor(code));
      res.end(JSON.stringify(raw ? clean(JSON.parse(raw)) : empty()));
      return;
    }

    if (method === 'POST') {
      const body = await readBody(req);
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch { res.statusCode = 400; res.end(JSON.stringify({ error: 'bad_json' })); return; }
      code = String(payload.code || code).toUpperCase().trim();
      if (!CODE_RE.test(code)) { res.statusCode = 400; res.end(JSON.stringify({ error: 'bad_code' })); return; }

      const raw = await kvGet(keyFor(code));
      const stored = raw ? JSON.parse(raw) : empty();
      const merged = merge(stored, payload);
      await kvSet(keyFor(code), JSON.stringify(merged));
      res.end(JSON.stringify(merged));
      return;
    }

    res.statusCode = 405;
    res.end(JSON.stringify({ error: 'method' }));
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'server' }));
  }
};
