"""在 9800 所在主机上运行：抓线上自产台源 → restyle.py 生成 → 与审计过的产物哈希核对 → 本机 CLI 发布（POST /api/apps patch）。
默认只做演练（不写任何东西），加 --apply 才发布；--only slug1,slug2 限定范围。
用法: python -I publish_local.py [--base http://127.0.0.1:9800] [--apply] [--only demo-timestamp] [--changelog 文本]
已统一过的台走「换层」：只替换 <head> 里的统一层（restyle.py 自动识别）。expected.json 只放本批要发的台。
本机 CLI 写面按服务端设计走回环信任（非浏览器、127.0.0.1），不需要也不读取管理口令。"""
import hashlib, json, re, subprocess, sys, tempfile, urllib.request
from pathlib import Path

def rd(p):  # 原样读写：不做换行转换（Windows 下 read_text/write_text 会改 \r\n）
    with open(p, encoding='utf-8', newline='') as f: return f.read()

def wr(p, s):
    with open(p, 'w', encoding='utf-8', newline='') as f: f.write(s)

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
MANIFEST = json.loads(rd(HERE / 'expected.json'))
INJECT = re.compile(r'<meta name="wm-app-token".*?</script>', re.S)

def arg(name, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default

CHANGELOG = arg('--changelog', '统一层更新（PATTERNS.md §7）')

def get(url):
    with urllib.request.urlopen(url, timeout=60) as r:
        return r.read().decode('utf-8')

def sha(s):
    return hashlib.sha256(s.encode('utf-8')).hexdigest()

def main():
    base = arg('--base', 'http://127.0.0.1:9800').rstrip('/')
    apply = '--apply' in sys.argv
    only = set(filter(None, (arg('--only', '') or '').split(',')))
    work = Path(tempfile.mkdtemp(prefix='wm-restyle-'))
    apps, extra, out = work / 'apps', work / 'extra', work / 'out'
    apps.mkdir(); extra.mkdir()
    slugs = [s for s in MANIFEST if not only or s in only]
    for slug in slugs:
        for rel in MANIFEST[slug]['files']:
            txt = get(f'{base}/apps/{slug}/' + ('' if rel == 'index.html' else rel))
            dst = apps / f'{slug}.html' if rel == 'index.html' else extra / slug / rel
            dst.parent.mkdir(parents=True, exist_ok=True); wr(dst, txt)
    subprocess.run([sys.executable, '-I', str(HERE / 'restyle.py'), str(ROOT / 'web/src/tokens.css'), str(apps), str(extra), str(out)], check=True, stdout=subprocess.DEVNULL)
    report = {}
    for slug in slugs:
        sets, mismatch = [], []
        for rel, exp in MANIFEST[slug]['files'].items():
            src_path = apps / f'{slug}.html' if rel == 'index.html' else extra / slug / rel
            src = INJECT.sub('', rd(src_path), count=1)
            new = rd(out / slug / rel)
            if sha(src) != exp['src'] or sha(new) != exp['out']:
                mismatch.append(rel)  # 线上源自审计后变了：不发，交回复核
            elif new != src:
                sets.append({'path': rel, 'content': new})
        if mismatch:
            report[slug] = {'result': 'skip-baseline-changed', 'files': mismatch}; continue
        if not sets:
            report[slug] = {'result': 'no-change'}; continue
        body = {'slug': slug, 'patch': {'set': sets}, 'changelog': CHANGELOG, 'created_by': 'market-app-restyle'}
        if not apply:
            report[slug] = {'result': 'dry-run-ok', 'files': [s['path'] for s in sets], 'bytes': len(json.dumps(body, ensure_ascii=False).encode())}; continue
        req = urllib.request.Request(f'{base}/api/apps', data=json.dumps(body, ensure_ascii=False).encode('utf-8'), headers={'Content-Type': 'application/json'}, method='POST')
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                res = json.loads(r.read().decode('utf-8'))
            live = get(f'{base}/apps/{slug}/')
            report[slug] = {'result': 'published', 'version': res.get('version'), 'served_has_layer': 'id="wm-design-layer"' in live}
        except urllib.error.HTTPError as e:
            report[slug] = {'result': f'http-{e.code}', 'error': e.read().decode('utf-8', 'replace')[:300]}
            break  # 第一处失败即停，剩余不发
    print(json.dumps(report, ensure_ascii=False, indent=1))

if __name__ == '__main__':
    main()
