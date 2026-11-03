// MobTV — media proxy (Vercel Node serverless function)
// Resolves http->https (mixed content), adds CORS, and rewrites HLS (.m3u8)
// playlists so every segment/variant/key is fetched back through this proxy.
const { Readable } = require('stream');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

// SSRF guard: block loopback / private / link-local (cloud metadata) targets.
function isBlockedTarget(u) {
  let host;
  try { host = new URL(u).hostname.toLowerCase(); } catch { return true; }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) return true;
  if (host.includes(':')) { // IPv6 loopback / link-local / unique-local
    return host === '::1' || host.startsWith('fe80') || host.startsWith('fc') || host.startsWith('fd');
  }
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = +m[1], b = +m[2];
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 169 && b === 254) return true;            // link-local + 169.254.169.254 metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;  // CGNAT
  }
  return false;
}

function abs(base, ref) {
  try { return new URL(ref, base).href; } catch { return ref; }
}
function prox(u) { return '/api/proxy?url=' + encodeURIComponent(u); }

function rewriteM3U8(text, baseUrl) {
  const out = [];
  for (let line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t === '') { out.push(line); continue; }
    if (t.startsWith('#')) {
      // rewrite URI="..." inside tags (EXT-X-KEY, EXT-X-MEDIA, EXT-X-MAP...)
      line = line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${prox(abs(baseUrl, u))}"`);
      out.push(line);
    } else {
      out.push(prox(abs(baseUrl, t)));
    }
  }
  return out.join('\n');
}

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range,Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length,Content-Range,Accept-Ranges');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }

  const q = req.query || Object.fromEntries(new URL(req.url, 'http://x').searchParams);
  const target = q.url;
  const raw = q.raw === '1';
  if (!target || !/^https?:\/\//i.test(target)) {
    res.statusCode = 400; return res.end('bad url');
  }
  if (isBlockedTarget(target)) { res.statusCode = 403; return res.end('blocked host'); }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const headers = { 'User-Agent': UA, 'Accept': '*/*' };
    if (req.headers.range) headers.Range = req.headers.range;
    const referer = (() => { try { return new URL(target).origin + '/'; } catch { return undefined; } })();
    if (referer) headers.Referer = referer;

    const up = await fetch(target, { headers, redirect: 'follow', signal: ctrl.signal });
    clearTimeout(timer); // headers received; let the body stream without the connect-timeout
    const ct = (up.headers.get('content-type') || '').toLowerCase();
    const isM3U8 = !raw && (/\.m3u8(\?|$)/i.test(target) || ct.includes('mpegurl') || ct.includes('vnd.apple'));

    if (isM3U8) {
      const text = await up.text();
      const body = rewriteM3U8(text, up.url || target);
      clearTimeout(timer);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-store');
      return res.end(body);
    }

    // passthrough (segments, mp4, images…) with range support
    res.statusCode = up.status;
    const pass = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control'];
    pass.forEach(h => { const v = up.headers.get(h); if (v) res.setHeader(h, v); });
    if (!up.headers.get('accept-ranges')) res.setHeader('Accept-Ranges', 'bytes');

    if (!up.body) { clearTimeout(timer); return res.end(); }
    const node = Readable.fromWeb(up.body);
    node.on('error', () => { try { res.destroy(); } catch {} });
    res.on('close', () => { try { ctrl.abort(); } catch {} });
    node.pipe(res);
    node.on('end', () => clearTimeout(timer));
  } catch (e) {
    clearTimeout(timer);
    if (!res.headersSent) { res.statusCode = 502; }
    res.end('proxy error');
  }
};

module.exports.config = { maxDuration: 60 };
