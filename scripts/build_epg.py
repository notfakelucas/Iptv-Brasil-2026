#!/usr/bin/env python3
"""Gera data/epg.json (guia ao vivo) a partir de fontes XMLTV abertas (epgshare01 BR).

- Baixa os feeds BR, casa os canais do nosso catálogo por nome normalizado
  (match exato, sem-espaços e aliases), e guarda só a janela [agora-1h, agora+30h]
  dos canais que temos. Tempos em epoch UTC (o cliente converte pro fuso local).
- Pensado pra rodar no GitHub Actions a cada ~6h, mantendo o guia atual com um
  arquivo pequeno (sem precisar parsear 6 MB de XMLTV no cliente).

Uso: python3 -I scripts/build_epg.py <data_dir> [out.json]
"""
import json, glob, re, sys, gzip, unicodedata, time, io
import urllib.request
import xml.etree.ElementTree as ET
from collections import defaultdict

DATA = sys.argv[1] if len(sys.argv) > 1 else 'data'
OUT = sys.argv[2] if len(sys.argv) > 2 else f'{DATA}/epg.json'

# Feeds XMLTV abertos com programação BR (atualizados de hora em hora).
FEEDS = [
    'https://epgshare01.online/epgshare01/epg_ripper_BR1.xml.gz',
    'https://epgshare01.online/epgshare01/epg_ripper_BR2.xml.gz',
]
UA = 'Mozilla/5.0 (MobTV EPG builder)'

WINDOW_BACK = 1 * 3600       # 1h atrás (pra pegar o programa em andamento)
WINDOW_FWD = 30 * 3600       # 30h à frente
MAX_PER_CH = 40              # no máx. N programas por canal

_ACC = lambda s: ''.join(c for c in unicodedata.normalize('NFD', s) if unicodedata.category(c) != 'Mn')
_QUAL = re.compile(r'\b(fhd|uhd|hd|sd|4k|h\.?265|h\.?264|hevc|alt|backup|²|³|¹|tv|canal)\b')

def norm(name):
    s = _ACC(name or '').lower()
    s = re.sub(r'^[a-z]{2}:\s*', '', s)                # prefixo 'br: '
    s = re.sub(r'^[a-z0-9 ]+/[a-z]{2}\b', '', s)       # prefixo 'cidade/uf' (epgshare)
    s = s.replace('.', ' ')
    s = re.sub(r'[^a-z0-9 ]', ' ', s)
    s = _QUAL.sub(' ', s)
    s = re.sub(r'\s+', ' ', s).strip()
    return s

# aliases: chave normalizada do nosso catálogo -> chave normalizada no EPG
ALIASES = {
    'globo news': 'globonews', 'nat geo': 'national geographic',
    'nat geo wild': 'national geographic wild', 'rede tv': 'redetv',
    'tnt series': 'tnt series', 'fox sports': 'fox sports',
}

def match_keys(k):
    """candidatos de chave p/ casar (ordem de preferência)."""
    out = [k, k.replace(' ', '')]
    if k in ALIASES:
        a = ALIASES[k]; out += [a, a.replace(' ', '')]
    return out

def parse_xmltv_time(s):
    # formato: 20261103060000 +0000  (ou sem offset)
    s = s.strip()
    m = re.match(r'(\d{14})\s*([+-]\d{4})?', s)
    if not m: return None
    t = time.strptime(m.group(1), '%Y%m%d%H%M%S')
    epoch = calendar_timegm(t)
    if m.group(2):
        sign = 1 if m.group(2)[0] == '+' else -1
        off = sign * (int(m.group(2)[1:3]) * 3600 + int(m.group(2)[3:5]) * 60)
        epoch -= off
    return epoch

import calendar
def calendar_timegm(t):
    return calendar.timegm(t)

def load_my_channels():
    """chaves normalizadas dos nossos canais ao vivo."""
    keys = set()
    for f in glob.glob(f'{DATA}/live/*.json'):
        try: items = json.load(open(f))
        except Exception: continue
        for it in items:
            k = norm(it.get('t'))
            if k: keys.add(k)
    return keys

def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    raw = urllib.request.urlopen(req, timeout=90).read()
    if url.endswith('.gz'):
        raw = gzip.decompress(raw)
    return raw

def main():
    mine = load_my_channels()
    print(f'canais no catálogo (chaves): {len(mine)}', flush=True)
    now = int(time.time())
    lo, hi = now - WINDOW_BACK, now + WINDOW_FWD

    # epg_key -> lista (start, stop, title)
    progs = defaultdict(list)
    # id do canal no XMLTV -> epg_key (nome normalizado)
    for url in FEEDS:
        try:
            data = fetch(url)
        except Exception as e:
            print(f'FALHA baixando {url}: {e}', flush=True); continue
        root = ET.parse(io.BytesIO(data)).getroot()
        id2key = {}
        for ch in root.findall('channel'):
            dn = ch.findtext('display-name') or ''
            id2key[ch.get('id')] = norm(dn)
        kept = 0
        for pr in root.findall('programme'):
            key = id2key.get(pr.get('channel'))
            if not key: continue
            st = parse_xmltv_time(pr.get('start') or '')
            sp = parse_xmltv_time(pr.get('stop') or '')
            if st is None: continue
            if sp is not None and sp < lo: continue
            if st > hi: continue
            title = (pr.findtext('title') or '').strip()
            if not title: continue
            progs[key].append((st, sp or st + 1800, title))
            kept += 1
        print(f'{url.split("/")[-1]}: canais={len(id2key)} programas_na_janela={kept}', flush=True)

    # monta saída só pros canais que temos, casando por chave/alias/sem-espaços
    out_ch = {}
    matched = 0
    for k in mine:
        found = None
        for cand in match_keys(k):
            if cand in progs:
                found = progs[cand]; break
        if not found:
            # tenta casar removendo espaços no lado do EPG
            nospace = {kk.replace(' ', ''): kk for kk in progs}
            cand = k.replace(' ', '')
            if cand in nospace:
                found = progs[nospace[cand]]
        if not found: continue
        lst = sorted(set(found))[:MAX_PER_CH]
        out_ch[k] = [[s, e, t] for (s, e, t) in lst]
        matched += 1

    payload = {'gen': now, 'ch': out_ch}
    json.dump(payload, open(OUT, 'w'), ensure_ascii=False, separators=(',', ':'))
    import os
    sz = os.path.getsize(OUT)
    print(f'EPG: {matched} canais casados | {OUT} ({sz//1024} KB)', flush=True)

if __name__ == '__main__':
    main()
