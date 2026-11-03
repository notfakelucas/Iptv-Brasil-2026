// Servidor de desenvolvimento do MobTV (site estático + funções /api).
// A Vercel serve isto em produção; localmente este arquivo replica o mínimo:
// arquivos estáticos + /api/proxy + /api/search + /api/sync, com um KV em
// memória (/__kv) para testar a sincronização sem banco real.
//
//   node scripts/devserver.mjs [root] [port]
//   root  = pasta do projeto (padrão: a pasta acima deste script)
//   port  = porta HTTP (padrão: 8787)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.argv[2] || path.join(HERE, '..'));
const PORT = +(process.argv[3] || 8787);

// aponta o api/sync.js para o KV mock ANTES de carregá-lo (ele lê env no load)
process.env.KV_REST_API_URL = `http://localhost:${PORT}/__kv`;
process.env.KV_REST_API_TOKEN = 'devtoken';

const require = createRequire(import.meta.url);
const load = n => { try { return require(path.join(ROOT, 'api', n)); } catch { return null; } };
const proxy = load('proxy.js');
const search = load('search.js');
const sync = load('sync.js');

const MIME = { '.html':'text/html;charset=utf-8', '.js':'text/javascript;charset=utf-8',
  '.css':'text/css;charset=utf-8', '.json':'application/json;charset=utf-8', '.svg':'image/svg+xml',
  '.png':'image/png', '.jpg':'image/jpeg', '.webp':'image/webp', '.ico':'image/x-icon',
  '.gz':'application/gzip', '.woff2':'font/woff2' };

const KV = new Map();  // mock do banco (só em memória, some ao reiniciar)
const body = req => new Promise(res => { let d = ''; req.on('data', c => d += c); req.on('end', () => res(d)); });

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');

  // KV REST mock: ["GET",k] ou ["SET",k,v,"EX",n]
  if (u.pathname === '/__kv') {
    const cmd = JSON.parse(await body(req) || '[]');
    res.setHeader('content-type', 'application/json');
    if (cmd[0] === 'GET') return res.end(JSON.stringify({ result: KV.has(cmd[1]) ? KV.get(cmd[1]) : null }));
    if (cmd[0] === 'SET') { KV.set(cmd[1], cmd[2]); return res.end(JSON.stringify({ result: 'OK' })); }
    return res.end(JSON.stringify({ result: null }));
  }

  if (u.pathname === '/api/proxy' && proxy) { req.query = Object.fromEntries(u.searchParams); return proxy(req, res); }
  if (u.pathname === '/api/search' && search) { req.headers.host = 'localhost:' + PORT; return search(req, res); }
  if (u.pathname === '/api/sync' && sync) { req.headers.host = 'localhost:' + PORT; return sync(req, res); }

  // cleanUrls (igual ao vercel.json): /rota -> /rota.html se existir
  let p = decodeURIComponent(u.pathname);
  if (p === '/') p = '/index.html';
  let fp = path.join(ROOT, p);
  if (!fp.startsWith(ROOT)) { res.statusCode = 403; return res.end('no'); }
  fs.stat(fp, (err, st) => {
    if ((err || !st.isFile()) && fs.existsSync(fp + '.html')) fp += '.html';
    fs.stat(fp, (e2, s2) => {
      if (e2 || !s2.isFile()) { res.statusCode = 404; return res.end('404'); }
      res.setHeader('Content-Type', MIME[path.extname(fp)] || 'application/octet-stream');
      fs.createReadStream(fp).pipe(res);
    });
  });
}).listen(PORT, () => console.log(`MobTV dev em http://localhost:${PORT}  (root: ${ROOT})`));
