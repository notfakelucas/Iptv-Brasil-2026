#!/usr/bin/env python3
"""MobTV catalog builder: parse m3u8 playlists -> compact JSON (lazy per-category).
Usage: python3 -I build.py <repo_dir> <out_dir>
"""
import sys, os, re, json, unicodedata, hashlib

repo, out = sys.argv[1], sys.argv[2]

ATTR = re.compile(r'(\S+?)="(.*?)"')
EP = re.compile(r'\s*[\[(]?\bS(\d{1,2})\s*[ExX]\s*(\d{1,3})[\])]?\b', re.I)  # S01E02 / S01 E02
EP2 = re.compile(r'\s*[\[(]?\bT(\d{1,2})\s*[:._ -]*\s*E(?:P)?\s*(\d{1,3})[\])]?\b', re.I)  # T01:E02

def slug(s, n=48):
    s = unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode()
    s = re.sub(r'[^a-zA-Z0-9]+', '-', s).strip('-').lower()
    return (s or 'x')[:n]

def parse_m3u(path):
    """Yield dicts {name, logo, group, url}."""
    cur = None
    with open(path, 'r', encoding='utf-8', errors='replace') as f:
        for line in f:
            line = line.rstrip('\n')
            if line.startswith('#EXTINF'):
                attrs = dict(ATTR.findall(line))
                name = line.split(',', 1)[-1].strip() if ',' in line else attrs.get('tvg-name', '')
                cur = {
                    'name': name or attrs.get('tvg-name', ''),
                    'logo': attrs.get('tvg-logo', ''),
                    'group': attrs.get('group-title', ''),
                }
            elif line and not line.startswith('#') and cur is not None:
                cur['url'] = line.strip()
                yield cur
                cur = None
            elif line.startswith('#') and not line.startswith('#EXTINF'):
                continue  # EXTVLCOPT etc.

def strip_ep(name):
    m = EP.search(name) or EP2.search(name)
    if m:
        base = name[:m.start()].strip(' -:._')
        return base, int(m.group(1)), int(m.group(2))
    return None

# ---------- VOD (Filmes-Series.m3u8) ----------
movies = {}   # cat_slug -> {label, items:[{t,l,u}]}
series = {}   # cat_slug -> {label, titles: {base: {t,l,eps:[{s,e,u}]}}}
vod_path = os.path.join(repo, 'Filmes-Series.m3u8')
MOVIE_CAP = 800
for it in parse_m3u(vod_path):
    g = it['group']
    if not it.get('url'):
        continue
    up = g.upper()
    if up.startswith('FILMES'):
        label = g.split('|', 1)[-1].strip() if '|' in g else g
        cs = slug(label)
        d = movies.setdefault(cs, {'label': label, 'items': []})
        if len(d['items']) < MOVIE_CAP:
            d['items'].append({'t': it['name'], 'l': it['logo'], 'u': it['url']})
    elif up.startswith('SÉRIES') or up.startswith('SERIES'):
        label = g.split('|', 1)[-1].strip() if '|' in g else g
        cs = slug(label)
        d = series.setdefault(cs, {'label': label, 'titles': {}})
        parsed = strip_ep(it['name'])
        if parsed:
            base, s, e = parsed
        else:
            base, s, e = it['name'], 1, len(d['titles'])
        t = d['titles'].get(base)
        if t is None:
            t = d['titles'][base] = {'t': base, 'l': it['logo'], 'eps': []}
        if not t['l'] and it['logo']:
            t['l'] = it['logo']
        t['eps'].append({'s': s, 'e': e, 'u': it['url']})

# ---------- LIVE (channel playlists) ----------
live = {}  # cat_label -> [{t,l,u}]
LIVE_CAP = 500
live_files = ['Canais.m3u8', 'CanaisIPTV.m3u8', 'CanaisBR01.m3u8',
              'CanaisBR02.m3u8', 'CanaisBR03.m3u8', 'CanaisBR04.m3u8']
# Only keep "channel-like" groups (skip the massive VOD-in-channels groups: SÉRIES/FILMES)
for fn in live_files:
    p = os.path.join(repo, fn)
    if not os.path.exists(p):
        continue
    for it in parse_m3u(p):
        if not it.get('url'):
            continue
        g = it['group'] or 'Diversos'
        gu = g.upper()
        if 'SÉRIE' in gu or 'SERIE' in gu or 'FILME' in gu or 'SERIADO' in gu or 'NOVELA' in gu:
            continue  # these are VOD dumped into channel lists; skip for Live
        cs = slug(g)
        d = live.setdefault(cs, {'label': g, 'items': []})
        if len(d['items']) < LIVE_CAP:
            d['items'].append({'t': it['name'], 'l': it['logo'], 'u': it['url']})

# ---------- Write output ----------
os.makedirs(out, exist_ok=True)
for sub in ('movies', 'series', 'live'):
    os.makedirs(os.path.join(out, sub), exist_ok=True)

def write(path, obj):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, separators=(',', ':'))

catalog = {'movies': [], 'series': [], 'live': []}
prev_movies, prev_series, prev_live = {}, {}, {}

for cs, d in movies.items():
    if not d['items']:
        continue
    write(os.path.join(out, 'movies', cs + '.json'), d['items'])
    catalog['movies'].append({'slug': cs, 'label': d['label'], 'count': len(d['items'])})
    prev_movies[cs] = d['items'][:20]

for cs, d in series.items():
    titles = list(d['titles'].values())
    if not titles:
        continue
    for t in titles:
        t['eps'].sort(key=lambda x: (x['s'], x['e']))
    titles.sort(key=lambda x: x['t'].lower())
    write(os.path.join(out, 'series', cs + '.json'), titles)
    catalog['series'].append({'slug': cs, 'label': d['label'], 'count': len(titles)})
    prev_series[cs] = [{'t': t['t'], 'l': t['l'], 'slug': cs} for t in titles[:20]]

for cs, d in live.items():
    if not d['items']:
        continue
    write(os.path.join(out, 'live', cs + '.json'), d['items'])
    catalog['live'].append({'slug': cs, 'label': d['label'], 'count': len(d['items'])})
    prev_live[cs] = d['items'][:20]

catalog['movies'].sort(key=lambda x: -x['count'])
catalog['series'].sort(key=lambda x: -x['count'])
catalog['live'].sort(key=lambda x: -x['count'])
write(os.path.join(out, 'catalog.json'), catalog)

# ---------- home.json: curated rails + hero ----------
def pick(cats, previews, keywords, fallback_n=6):
    chosen, used = [], set()
    for kw in keywords:
        for c in cats:
            if c['slug'] in used:
                continue
            if kw in c['label'].lower():
                chosen.append(c); used.add(c['slug']); break
    for c in cats:  # fill with biggest remaining
        if len(chosen) >= fallback_n:
            break
        if c['slug'] not in used:
            chosen.append(c); used.add(c['slug'])
    rails = []
    for c in chosen:
        pv = previews.get(c['slug'], [])
        if pv:
            rails.append({'slug': c['slug'], 'label': c['label'], 'count': c['count'], 'items': pv})
    return rails

home = {'hero': [], 'rails_live': [], 'rails_movies': [], 'rails_series': []}
home['rails_live'] = pick(catalog['live'], prev_live,
                          ['globo', 'sportv', 'premiere', 'telecine', 'hbo', 'esporte'], 8)
home['rails_movies'] = pick(catalog['movies'], prev_movies,
                            ['lan', 'ação', 'acao', 'terror', 'coméd', 'comed', 'animação', 'animacao', '4k'], 8)
home['rails_series'] = pick(catalog['series'], prev_series,
                            ['netflix', 'dorama', 'novela', 'crunchy', 'disney', 'max', 'prime', 'turca'], 8)

# hero: take movies from a "lançamentos"-like category (portrait posters)
hero_cat = next((c for c in catalog['movies'] if 'lan' in c['label'].lower()), None) \
           or (catalog['movies'][0] if catalog['movies'] else None)
if hero_cat:
    for m in prev_movies.get(hero_cat['slug'], [])[:8]:
        home['hero'].append({'t': m['t'], 'l': m['l'], 'u': m['u'],
                             'slug': hero_cat['slug'], 'type': 'movie'})
write(os.path.join(out, 'home.json'), home)

# ---------- search.json: lightweight global title index ----------
# entry = [title, type('m'|'s'|'l'), slug]
search = []
for cs, d in movies.items():
    for it in d['items']:
        search.append([it['t'], 'm', cs])
for cs, d in series.items():
    for base in d['titles']:
        search.append([base, 's', cs])
for cs, d in live.items():
    for it in d['items']:
        search.append([it['t'], 'l', cs])
write(os.path.join(out, 'search.json'), search)
print("search entries:", len(search), "| search.json (MB): %.2f" % (os.path.getsize(os.path.join(out, 'search.json')) / 1e6))

# summary
def dsize(p):
    tot = 0
    for root, _, files in os.walk(p):
        for fn in files:
            tot += os.path.getsize(os.path.join(root, fn))
    return tot

print("movies cats:", len(catalog['movies']), "| series cats:", len(catalog['series']), "| live cats:", len(catalog['live']))
print("total movies items:", sum(c['count'] for c in catalog['movies']))
print("total series titles:", sum(c['count'] for c in catalog['series']))
print("total live channels:", sum(c['count'] for c in catalog['live']))
print("out size (MB): %.2f" % (dsize(out) / 1e6))
print("catalog.json (KB): %.1f" % (os.path.getsize(os.path.join(out, 'catalog.json')) / 1e3))
print("home.json (KB): %.1f" % (os.path.getsize(os.path.join(out, 'home.json')) / 1e3))
