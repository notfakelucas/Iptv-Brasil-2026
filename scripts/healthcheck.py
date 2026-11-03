#!/usr/bin/env python3
"""Health-check dos links do catálogo -> gera deadlist.json (usado pelo build).
Testa todos os links não-dbonline + uma amostra do dbonline (que é gigante),
marcando como morto apenas códigos duros (000/401/403/404/410). Pensado pra rodar
no GitHub Actions semanalmente; a reachability de runners de CI a hosts BR pode
variar, então cada execução gera uma deadlist fresca do conjunto testado.

Uso: python3 -I scripts/healthcheck.py <data_dir> <out_deadlist.json>
"""
import json, glob, subprocess, sys, random
import concurrent.futures as cf
from urllib.parse import urlparse
from collections import Counter

DATA = sys.argv[1] if len(sys.argv) > 1 else 'data'
OUT = sys.argv[2] if len(sys.argv) > 2 else 'deadlist.json'
BIG = 'dbonline.tech-cdn.top:80'
DBONLINE_SAMPLE = int(__import__('os').environ.get('DBONLINE_SAMPLE', '15000'))
WORKERS = int(__import__('os').environ.get('HC_WORKERS', '60'))
random.seed()  # amostra rotativa a cada run

allu = set()
for f in glob.glob(f'{DATA}/movies/*.json') + glob.glob(f'{DATA}/live/*.json'):
    for it in json.load(open(f)):
        if it.get('u'): allu.add(it['u'])
for f in glob.glob(f'{DATA}/series/*.json'):
    for t in json.load(open(f)):
        for e in t.get('eps', []):
            if e.get('u'): allu.add(e['u'])

nonbig = [u for u in allu if urlparse(u).netloc != BIG]
big = [u for u in allu if urlparse(u).netloc == BIG]
sample_big = random.sample(big, min(DBONLINE_SAMPLE, len(big)))
urls = nonbig + sample_big
print(f"catálogo={len(allu)} | testando={len(urls)} (não-dbonline={len(nonbig)} + amostra dbonline={len(sample_big)})", flush=True)

DEAD = {'000', '401', '403', '404', '410'}
def probe(u):
    try:
        r = subprocess.run(
            ['curl', '-s', '-o', '/dev/null', '-m', '7', '-r', '0-1', '-A', 'VLC/3.0', '-L',
             '-w', '%{http_code}', u], capture_output=True, text=True)
        return u, (r.stdout.strip() or '000')
    except Exception:
        return u, '000'

codes = Counter(); dead = []; done = 0
with cf.ThreadPoolExecutor(max_workers=WORKERS) as ex:
    for u, c in ex.map(probe, urls):
        codes[c] += 1
        if c in DEAD: dead.append(u)
        done += 1
        if done % 5000 == 0:
            print(f"  … {done}/{len(urls)} | mortos: {len(dead)}", flush=True)

# preserva mortos já conhecidos que não foram testados nesta run (ex.: resto do dbonline)
prev = set()
try:
    prev = set(json.load(open(OUT)).get('dead', []))
except Exception:
    pass
tested = set(urls)
carried = [u for u in prev if u not in tested]  # mantém o que não re-testamos
final = sorted(set(dead) | set(carried))
json.dump({'dead': final}, open(OUT, 'w'))
print(f"\nMortos nesta run={len(dead)} | carregados de runs anteriores={len(carried)} | total deadlist={len(final)}", flush=True)
print("códigos:", dict(codes.most_common()), flush=True)
