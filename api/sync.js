// Sync da "Minha Lista" e do "Continuar assistindo" entre dispositivos.
// Conta = um código aleatório (sem senha). Tudo passa por aqui: o cliente nunca
// vê o token nem a URL do banco. Armazena em KV (Vercel KV / Upstash Redis) via
// REST — sem dependências, só built-ins + fetch, igual aos outros endpoints.
//
//   GET  /api/sync?code=XXXX            -> devolve o blob salvo (merge pronto)
//   POST /api/sync   {code, favs, favRm, cont}  -> faz merge e devolve o resultado
//
// Enquanto o banco não estiver conectado (env vars ausentes), responde 503 e o
// cliente mostra "sync indisponível" sem quebrar o resto do app.

const BASE =
  process.env.KV_REST_API_URL ||
  process.env.UPSTASH_REDIS_REST_URL ||
  process.env.STORAGE_KV_REST_API_URL ||
  '';
const TOKEN =
  process.env.KV_REST_API_TOKEN ||
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  process.env.STORAGE_KV_REST_API_TOKEN ||
  '';

const TTL = 60 * 60 * 24 * 365;     // 1 ano sem uso -> expira sozinho
const MAX_BODY = 512 * 1024;        // teto do corpo do POST
const MAX_FAVS = 1000;              // tetos de sanidade
const MAX_CONT = 40;
const CODE_RE = /^[A-Z0-9]{6,32}$/;

// chama o endpoint REST do Redis com um comando ["SET", k, v, ...]
async function kv(cmd) {
  const r = await fetch(BASE, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  if (!r.ok) throw new Error(`kv ${r.status}`);
  const j = await r.json();
  if (j && j.error) throw new Error(`kv ${j.error}`);
  return j ? j.result : null;
}

const keyFor = code => `mobtv:sync:${code}`;
const now = () => Date.now();

// blob vazio
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

  // remoções: maior timestamp vence
  const rm = {};
  for (const m of [a.favRm, b.favRm]) for (const k in m) rm[k] = Math.max(rm[k] || 0, m[k]);

  // adições: por chave, pega a entrada com _ts maior
  const adds = {};
  for (const m of [a.favs, b.favs]) for (const k in m) {
    if (!adds[k] || (m[k]._ts || 0) >= (adds[k]._ts || 0)) adds[k] = m[k];
  }

  // efetivo: add vence remove?
  for (const k in adds) {
    const at = adds[k]._ts || 0, rt = rm[k] || 0;
    if (at > rt) out.favs[k] = adds[k];       // favorito ativo
  }
  for (const k in rm) {
    const at = adds[k] ? (adds[k]._ts || 0) : 0;
    if (rm[k] >= at) out.favRm[k] = rm[k];     // tombstone ainda relevante
  }

  // continuar assistindo: união por chave, maior ts vence, mais recentes primeiro
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

  if (!BASE || !TOKEN) {
    res.statusCode = 503;
    res.end(JSON.stringify({ error: 'sync_unavailable' }));
    return;
  }

  try {
    const host = req.headers.host;
    const url = new URL(req.url, `https://${host}`);
    const method = (req.method || 'GET').toUpperCase();

    // valida o código
    let code = (url.searchParams.get('code') || '').toUpperCase().trim();

    if (method === 'GET') {
      if (!CODE_RE.test(code)) { res.statusCode = 400; res.end(JSON.stringify({ error: 'bad_code' })); return; }
      const raw = await kv(['GET', keyFor(code)]);
      const blob = raw ? clean(JSON.parse(raw)) : empty();
      res.end(JSON.stringify(blob));
      return;
    }

    if (method === 'POST') {
      const body = await readBody(req);
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch { res.statusCode = 400; res.end(JSON.stringify({ error: 'bad_json' })); return; }
      code = String(payload.code || code).toUpperCase().trim();
      if (!CODE_RE.test(code)) { res.statusCode = 400; res.end(JSON.stringify({ error: 'bad_code' })); return; }

      const raw = await kv(['GET', keyFor(code)]);
      const stored = raw ? JSON.parse(raw) : empty();
      const merged = merge(stored, payload);
      await kv(['SET', keyFor(code), JSON.stringify(merged), 'EX', String(TTL)]);
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
