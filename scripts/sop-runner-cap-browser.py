"""#309 phase2 真实浏览器实测：Runner 页的读能力（cap）存储与「需读授权」提示。

覆盖（监督席自留边界补齐）：
  1) 新 run：Runner 页拿到创建响应的 read_capability 并写入 localStorage（wm.sop.run.<slug>.rcap）。
  2) 旧 run 无 cap：?run=<id> 打开只回元数据 → 页面显示「需读授权」提示，且不渲染私有字段值。
  3) 有 cap 的旧 run：注入该 run 的 cap 后重开 → 正常渲染字段值、无授权提示。

前置：E2E_PORT 指向已起的合成实例（拒 9800，除非 E2E_ALLOW_PROD=1）；E2E_ADMIN_TOKEN 给管理口令。
"""
import json
import os
import sys
import urllib.error
import urllib.request

from playwright.sync_api import sync_playwright

_port = os.environ.get('E2E_PORT', '').strip()
if not _port:
    print('[CAP-BROWSER] ✗ 拒跑：必须显式给测试端口 E2E_PORT=<端口>')
    sys.exit(2)
if _port == '9800' and os.environ.get('E2E_ALLOW_PROD') != '1':
    print('[CAP-BROWSER] ✗ 拒跑：E2E_PORT=9800 是生产实例')
    sys.exit(2)
BASE = f'http://127.0.0.1:{_port}'
ADMIN = os.environ.get('E2E_ADMIN_TOKEN', '')
SLUG = 'sop-cap-browser'
RESULTS = []


def record(name, ok, err=''):
    RESULTS.append((name, ok, err))
    print(f'[{"PASS" if ok else "FAIL"}] {name}' + (f' — {err}' if err else ''))


def req(method, path, payload=None):
    data = None if payload is None else json.dumps(payload).encode()
    r = urllib.request.Request(BASE + path, data=data, method=method)
    r.add_header('Content-Type', 'application/json')
    if ADMIN:
        r.add_header('X-Admin-Token', ADMIN)
    try:
        with urllib.request.urlopen(r, timeout=15) as resp:
            body = resp.read()
            return resp.status, (json.loads(body) if body else None)
    except urllib.error.HTTPError as e:
        detail = e.read().decode('utf-8', 'replace')[:200]
        raise AssertionError(f'{method} {path} -> {e.code} {detail}') from None


SOP_YAML = """title: Cap Browser Fixture
steps:
  - key: inspect
    title: 检查
    fields:
      - {key: note, type: text, required: false, maxLength: 4096, operations: [read]}
    body: |
      <p>备注：<input data-field="note" placeholder="如 说明"></p>
"""

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()

    # ---- 0. 建台并发布（管理面；不带 Origin 走口令） ----
    try:
        try:
            req('DELETE', f'/api/apps/{SLUG}?reviewed_by=cap-browser-cleanup')
        except Exception:
            pass
        st, _ = req('POST', '/api/apps', {
            'slug': SLUG, 'kind': 'sop', 'title': 'Cap Browser Fixture', 'changelog': 'cap browser fixture',
            'files': [{'path': 'sop.yaml', 'content': SOP_YAML}],
        })
        assert st in (200, 201), f'建台失败 {st}'
        st, app = req('GET', f'/api/apps/{SLUG}')
        if app.get('status') != 'published':
            st, _ = req('POST', f'/api/sops/{SLUG}/publish', {})
            assert st == 200, f'发布失败 {st}'
        record('合成台就绪（建台+发布）', True)
    except Exception as e:
        record('合成台就绪（建台+发布）', False, str(e)[:160])
        print(json.dumps({'results': RESULTS}))
        sys.exit(1)

    # ---- 1. 旧 run（无 cap）：页面应显示需读授权、不渲染私有值 ----
    try:
        st, run = req('POST', '/api/sop/runs', {'slug': SLUG, 'started_by': 'cap-browser'})
        assert st in (200, 201) and isinstance(run.get('id'), int), f'开 run 失败 {st} {run}'
        rid, cap = run['id'], run.get('read_capability', '')
        assert isinstance(cap, str) and len(cap) >= 64, '创建响应未带 read_capability'
        req('PUT', f'/api/sop/runs/{rid}', {'stepKey': 'inspect', 'value': {'note': 'PRIVATE_FIELD_VALUE'}})
        record('创建响应带 read_capability', True)
    except Exception as e:
        record('创建响应带 read_capability', False, str(e)[:160])
        browser.close()
        print(json.dumps({'results': RESULTS}))
        sys.exit(1)

    # ---- 2. 新开 Runner：cap 落 localStorage ----
    try:
        page.goto(f'{BASE}/sop/{SLUG}/', wait_until='domcontentloaded')
        page.wait_for_timeout(1500)
        stored = page.evaluate(f"() => localStorage.getItem('wm.sop.run.{SLUG}.rcap')")
        parsed = json.loads(stored) if stored else None
        record('Runner 把 cap 存入 localStorage',
               bool(parsed) and isinstance(parsed.get('id'), int) and len(str(parsed.get('c', ''))) >= 64,
               f'localStorage={str(stored)[:80]}')
    except Exception as e:
        record('Runner 把 cap 存入 localStorage', False, str(e)[:160])

    # ---- 3. 清 cap 后开旧 run：显示需读授权、不渲染私有值 ----
    try:
        page.evaluate(f"() => {{ localStorage.removeItem('wm.sop.run.{SLUG}.rcap'); localStorage.removeItem('wm.sop.run.{SLUG}'); }}")
        page.goto(f'{BASE}/sop/{SLUG}/?run={rid}', wait_until='domcontentloaded')
        page.wait_for_timeout(1500)
        state = page.eval_on_selector('#state', 'el => el.textContent') if page.query_selector('#state') else ''
        body_text = page.inner_text('body')
        leaked = 'PRIVATE_FIELD_VALUE' in body_text
        record('无 cap 旧 run 显示需读授权', '需读授权' in state or '需读授权' in body_text, f'state={state[:60]}')
        record('无 cap 旧 run 不渲染私有值', not leaked)
    except Exception as e:
        record('无 cap 旧 run 显示需读授权', False, str(e)[:160])

    # ---- 4. 注入该 run 的 cap 后重开：正常渲染 ----
    try:
        page.evaluate(
            f"() => localStorage.setItem('wm.sop.run.{SLUG}.rcap', JSON.stringify({{ id: {rid}, c: {json.dumps(cap)} }}))")
        page.goto(f'{BASE}/sop/{SLUG}/?run={rid}', wait_until='domcontentloaded')
        page.wait_for_timeout(1500)
        state2 = page.eval_on_selector('#state', 'el => el.textContent') if page.query_selector('#state') else ''
        body2 = page.inner_text('body')
        record('带 cap 旧 run 无授权提示', '需读授权' not in state2 and '需读授权' not in body2, f'state={state2[:60]}')
        filled = page.evaluate(
            f"() => {{ const el = document.querySelector('[data-field=\"note\"]'); return el ? el.value : null; }}")
        record('带 cap 旧 run 渲染私有值', filled == 'PRIVATE_FIELD_VALUE', f'field={filled!r}')
    except Exception as e:
        record('带 cap 旧 run 渲染私有值', False, str(e)[:160])

    browser.close()

failed = [r for r in RESULTS if not r[1]]
print(json.dumps({'results': RESULTS, 'checks': len(RESULTS), 'failed': len(failed)}, ensure_ascii=False))
sys.exit(1 if failed else 0)
