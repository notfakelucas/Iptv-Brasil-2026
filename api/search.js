// Busca server-side: carrega o índice uma vez (cache em memória entre invocações
// quentes), filtra pela query e devolve até 60 hits. Evita baixar o search.json
// (~2MB) no cliente.
let IDX = null;
let LOADING = null;

function norm(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

async function loadIndex(host) {
  if (IDX) return IDX;
  if (!LOADING) {
    const proto = host && host.startsWith('localhost') ? 'http' : 'https';
    LOADING = fetch(`${proto}://${host}/data/search.json`)
      .then(r => r.json())
      .then(j => { IDX = j; LOADING = null; return j; })
      .catch(e => { LOADING = null; throw e; });
  }
  return LOADING;
}

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  try {
    const host = req.headers.host;
    const url = new URL(req.url, `https://${host}`);
    const q = (url.searchParams.get('q') || '').trim();
    if (q.length < 2) { res.end('[]'); return; }

    const idx = await loadIndex(host);
    const qq = norm(q);
    const starts = [];
    const contains = [];
    for (let i = 0; i < idx.length; i++) {
      const n = norm(idx[i][0]);
      if (n.startsWith(qq)) starts.push(idx[i]);
      else if (n.includes(qq)) contains.push(idx[i]);
      if (starts.length >= 60) break;
    }
    const hits = starts.concat(contains).slice(0, 60);
    res.setHeader('cache-control', 'public, max-age=300, s-maxage=600');
    res.end(JSON.stringify(hits));
  } catch (e) {
    res.statusCode = 200; // cliente cai no fallback estático
    res.end('[]');
  }
};
