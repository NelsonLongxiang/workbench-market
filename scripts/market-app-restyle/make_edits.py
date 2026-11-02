"""把 原文件 → 统一层产物 拆成 app_draft_edit 用的 old_text→new_text 清单（合并相邻差异块），
并在本地按顺序模拟应用，必须逐字节还原产物。
用法: python3 -I make_edits.py <apps_dir> <extra_dir> <out_dir> <edits_dir>"""
import difflib, json, re, sys
from pathlib import Path

def rd(p):  # 原样读写：不做换行转换（Windows 下 read_text/write_text 会改 \r\n）
    with open(p, encoding='utf-8', newline='') as f: return f.read()

def wr(p, s):
    with open(p, 'w', encoding='utf-8', newline='') as f: f.write(s)

INJECT = re.compile(r'<meta name="wm-app-token".*?</script>', re.S)
TOK = re.compile(r'[^;{}>,\n]*[;{}>,\n]?')  # 按 CSS/HTML 分隔符切片，长行也能细粒度对齐
GAP, MAX = 400, 120_000  # 相邻块间距 <400 字符就合并；单条编辑上限 ~120KB

def toks(s):
    return [t for t in TOK.findall(s) if t]

def edits_for(a, b):
    ta, tb = toks(a), toks(b)
    assert ''.join(ta) == a and ''.join(tb) == b
    pa = [0]; [pa.append(pa[-1] + len(t)) for t in ta]
    pb = [0]; [pb.append(pb[-1] + len(t)) for t in tb]
    sm = difflib.SequenceMatcher(None, ta, tb, autojunk=False)
    spans = [(pa[i1], pa[i2], pb[j1], pb[j2]) for op, i1, i2, j1, j2 in sm.get_opcodes() if op != 'equal']
    merged = []
    for s in spans:
        if merged and s[0] - merged[-1][1] < GAP and (s[1] - merged[-1][0]) < MAX:
            m = merged[-1]; merged[-1] = (m[0], s[1], m[2], s[3])
        else:
            merged.append(s)
    out = []
    for a0, a1, b0, b1 in merged:
        # 向两侧扩上下文直到 old_text 在原文唯一（且非空）
        lo, hi, pad = a0, a1, 0
        while True:
            lo2, hi2 = max(0, a0 - pad), min(len(a), a1 + pad)
            old = a[lo2:hi2]
            if old and a.count(old) == 1: break
            pad = pad * 2 + 16
        new = a[lo2:a0] + b[b0:b1] + a[a1:hi2]
        out.append({'old_text': old, 'new_text': new, '_at': lo2})
    return out

def apply(a, edits):
    for e in edits:
        assert a.count(e['old_text']) == 1, 'old_text 不唯一/缺失'
        a = a.replace(e['old_text'], e['new_text'], 1)
    return a

if __name__ == '__main__':
    apps, extra, out, dst = map(Path, sys.argv[1:5]); dst.mkdir(exist_ok=True)
    summary = {}
    for f in sorted(apps.glob('*.html')):
        slug = f.stem; plan = []
        jobs = [('index.html', INJECT.sub('', rd(f), count=1))]
        jobs += [(str(x.relative_to(extra / slug)), rd(x)) for x in sorted((extra / slug).rglob('*')) if x.is_file()]
        for rel, src in jobs:
            target = rd(out / slug / rel)
            es = edits_for(src, target)
            # 按位置倒序应用：前面的替换不影响后面 old_text 的唯一性判断
            es.sort(key=lambda e: -e['_at'])
            assert apply(src, es) == target, f'{slug}/{rel} 模拟应用不一致'
            plan.append({'path': rel, 'edits': [{'old_text': e['old_text'], 'new_text': e['new_text']} for e in es],
                         'bytes_old': len(src.encode()), 'bytes_new': len(target.encode())})
        wr(dst / f'{slug}.json', json.dumps(plan, ensure_ascii=False))
        summary[slug] = [(p['path'], len(p['edits']), max((len(e['old_text']) + len(e['new_text']) for e in p['edits']), default=0)) for p in plan]
    for k, v in summary.items():
        print(f'{k:38s}', ' '.join(f'{p}:{n}条/最大{m // 1024}KB' for p, n, m in v))
