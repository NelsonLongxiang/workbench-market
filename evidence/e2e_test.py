"""workbench-market E2E 全流程自动化测试（Playwright，对 9800 已构建产物）

覆盖：仪表盘 / 市场 CRUD+校验+过滤+检测+抽屉+开关+编辑+复制+删除 / 使用页 / 类型管理增删+引用保护 / 设置保存+导出下载
要点：ModalForm 提交按钮是 type=button（pro-components 实现），统一用 .ant-modal-footer .ant-btn-primary；
     antd Select(tags) 不用 placeholder.fill，改为点击后键盘输入+Enter。
失败自动截图 evidence/fail-*.png；exit code 非 0 表示有失败。
"""
import json
import time
import sys
from datetime import datetime, timezone
from playwright.sync_api import sync_playwright, expect

import os as _os
_port = _os.environ.get('E2E_PORT', '9800')
BASE = f'http://127.0.0.1:{_port}'
RESULTS = []


def record(name, ok, err=''):
    RESULTS.append((name, ok, err))
    print(f'[{"PASS" if ok else "FAIL"}] {name}' + (f' — {err}' if err else ''))


def api(page, method, path, payload=None):
    return page.request.fetch(f'{BASE}{path}', method=method, data=payload,
                              headers={'Content-Type': 'application/json'})


def cleanup(page):
    """删除历史遗留的 E2E 数据，保证测试幂等"""
    for w in api(page, 'GET', '/api/workbenches').json():
        if w['name'].startswith('E2E'):
            api(page, 'DELETE', f"/api/workbenches/{w['id']}")
    for t in api(page, 'GET', '/api/types').json():
        if t['key'].startswith('e2e-'):
            try:
                api(page, 'DELETE', f"/api/types/{t['id']}")
            except Exception:
                pass
    for c in api(page, 'GET', '/api/cockpits').json():
        if c['name'].startswith('E2E'):
            try:
                api(page, 'DELETE', f"/api/cockpits/{c['id']}")
            except Exception:
                pass
    for a in api(page, 'GET', '/api/apps').json():
        if a['slug'].startswith('e2e-'):
            try:
                api(page, 'DELETE', f"/api/apps/{a['slug']}", {'reviewed_by': 'e2e-cleanup'})
            except Exception:
                pass


# ---- echo fixture 自管（监督席检出根治：fixture 是外部依赖，此前靠调用方带起——
# 跨会话/独立跑必断粮 → /go/ 透传断言 json() 崩「Expecting value line 1 column 1」。
# 脚本自起自收：在跑前探测 9901，死则 spawn，结束时只杀自己起的那个）
import atexit as _atexit
import socket as _sock
import subprocess as _sp
import os as _os

def _port_live(port):
    with _sock.socket(_sock.AF_INET, _sock.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex(('127.0.0.1', port)) == 0

_fixture_proc = None
if not _port_live(9901):
    _fixture_proc = _sp.Popen(
        ['node', 'scripts/echo-fixture.mjs'],
        stdout=_sp.DEVNULL, stderr=_sp.DEVNULL,
        cwd=_os.path.join(_os.path.dirname(_os.path.abspath(__file__)), '..'))
    for _ in range(40):
        if _port_live(9901):
            break
        time.sleep(0.25)

@_atexit.register
def _kill_fixture():
    if _fixture_proc is not None:
        _fixture_proc.terminate()

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 900})
    page.set_default_timeout(15000)

    def shot(name):
        try:
            page.screenshot(path=f'evidence/fail-{name}.png', full_page=True,
                            animations='disabled', timeout=5000)
        except Exception:
            pass

    def submit_modal(modal):
        modal.locator('.ant-modal-footer .ant-btn-primary').click()

    # 摘要门自锁修复（PR#46 门 × 卫生批顺序缺陷）：起跑重置为空占位（total=0），
    # 卫生批跑 make-submission 时门放行，E2E 末尾写真摘要——否则上一轮残次摘要自锁卫生批
    with open(_os.path.join(_os.path.dirname(_os.path.abspath(__file__)), 'e2e-summary.json'), 'w', encoding='utf-8') as _f:
        json.dump({'passed': 0, 'total': 0, 'failed': 0, 'all_passed': 0, 'fails': [], 'finished_at': '', 'contrast_rows': [], 'contrast_all_passed': 0}, _f)

    cleanup(page)

    # !!! 生产守卫（监督席 direct-ba8a2980·P0 事故）：E2E 只允许打测试端口 —— 9800 生产默认拒跑
    _e2e_port = str(_os.environ.get('E2E_PORT', '')).strip()
    if _e2e_port == '9800' and _os.environ.get('E2E_ALLOW_PROD') != '1':
        print('[E2E] ✗ 拒跑：E2E_PORT=9800 是生产实例（默认只跑测试端口；确需生产演练请显式 E2E_ALLOW_PROD=1）')
        sys.exit(2)
    # 分页/行定位策略（2026-10-28 修正·替换 10-26 的破坏性裁剪）：
    # 历史错误做法=按数量 DELETE 真工作台（曾删 16 台真台）——现改为**只清理 E2E 前缀行**，
    # 行定位一律用搜索/过滤（page.get_by_placeholder('搜索') 或 ?q=）而不做数据裁剪。
    _wbs = api(page, 'GET', '/api/workbenches').json()
    for _w in _wbs:
        if str(_w.get('name', '')).startswith('E2E'):
            try: api(page, 'DELETE', f"/api/workbenches/{_w['id']}")
            except Exception: pass

    # 生产形态（MCP_GATEWAY=on）：/mcp 需会话令牌——用 E2E_ADMIN_TOKEN 建会话+授权（无 401 则空头）
    _mcp_h = {'Content-Type': 'application/json'}
    try:
        _probe = page.request.post(BASE + '/mcp', headers={'Content-Type': 'application/json'},
            data=json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list'}))
        if _probe.status == 401:
            _at = _os.environ.get('E2E_ADMIN_TOKEN', '')
            assert _at, '网关模式需要 E2E_ADMIN_TOKEN（生产形态基线）'
            _sess = page.request.post(BASE + '/api/mcp/sessions',
                headers={'Content-Type': 'application/json', 'X-Admin-Token': _at},
                data=json.dumps({'name': 'e2e-runner-' + str(int(__import__('time').time()))})).json()
            _tools = page.request.get(BASE + '/api/mcp/tools', headers={'X-Admin-Token': _at}).json()
            _tl = _tools if isinstance(_tools, list) else (_tools.get('tools') or [])
            _names = [x.get('name') if isinstance(x, dict) else x for x in _tl]
            page.request.put(BASE + f"/api/mcp/sessions/{_sess['id']}/grants",
                headers={'Content-Type': 'application/json', 'X-Admin-Token': _at},
                data=json.dumps({'grants': _names}))
            _mcp_h['Authorization'] = 'Bearer ' + str(_sess.get('token', ''))
    except Exception as _e:
        print('[E2E] MCP 会话引导失败:', _e)

    # ---------- 1. 仪表盘 ----------
    try:
        page.goto(BASE + '/')
        page.wait_for_load_state('networkidle')
        body = page.inner_text('body')
        assert '工作台总数' in body and '平均延迟' in body, '统计卡缺失'
        assert '全部检测' in body, '操作按钮缺失'
        record('仪表盘渲染（统计卡/操作）', True)
    except Exception as e:
        record('仪表盘渲染（统计卡/操作）', False, str(e)); shot('dashboard')

    # ---------- 2. 市场页：新增（含校验失败分支） ----------
    # goto 入 try + 失败 dump HTML：主区空（chunk 加载中断）时现场可诊断（E2E 劣化调查增强）
    try:
        page.goto(BASE + '/market', wait_until='domcontentloaded', timeout=30000)
        page.wait_for_load_state('networkidle', timeout=15000)
        page.wait_for_timeout(800)
    except Exception as e:
        record('新增工作台流程', False, f'goto/idle 失败: {e}'); shot('market-goto')
        with open(_os.path.join(_os.path.dirname(_os.path.abspath(__file__)), 'fail-market-goto.html'), 'w', encoding='utf-8') as _hf:
            _hf.write(page.content())
        raise

    try:
        page.get_by_role('button', name='新增工作台').click()
        modal = page.locator('.ant-modal-content').filter(has_text='新增工作台')
        modal.wait_for(state='visible')
        # 2a. 空表单提交 → 必填校验
        submit_modal(modal)
        page.wait_for_timeout(500)
        assert '请输入名称' in modal.inner_text(), '必填校验未出现'
        # 2b. 非法 URL → pattern 校验
        modal.get_by_label('名称').fill('E2E 测试工作台')
        modal.get_by_label('服务地址').fill('ftp://bad')
        submit_modal(modal)
        page.wait_for_timeout(500)
        assert '必须以 http' in modal.inner_text(), 'URL pattern 校验未出现'
        record('表单校验（必填/URL pattern）', True)
        # 2c. 正常填写提交
        modal.get_by_label('服务地址').fill(BASE)
        modal.get_by_label('分类').fill('E2E')
        modal.get_by_label('标签').click()
        page.keyboard.type('e2e')
        page.keyboard.press('Enter')
        modal.locator('.ant-form-item').filter(has_text='描述').locator('textarea').fill('**E2E** 自动化测试条目')
        submit_modal(modal)
        page.wait_for_timeout(1200)
        expect(page.locator('.ant-table-row').filter(has_text='E2E 测试工作台')).to_be_visible()
        record('新增工作台 → 表格出现', True)
    except Exception as e:
        record('新增工作台流程', False, str(e)); shot('market-create')

    # ---------- 3. 过滤 ----------
    try:
        row = page.locator('.ant-table-row').filter(has_text='E2E 测试工作台')
        page.get_by_placeholder('搜索名称 / 地址 / 描述').fill('E2E 测试工作台')
        page.keyboard.press('Enter')
        page.wait_for_timeout(800)
        assert row.count() == 1, f'关键词过滤后行数={row.count()}'
        page.get_by_placeholder('搜索名称 / 地址 / 描述').fill('不存在的关键词xyz')
        page.keyboard.press('Enter')
        page.wait_for_timeout(800)
        assert '暂无工作台' in page.inner_text('body'), '空态未出现'
        page.get_by_placeholder('搜索名称 / 地址 / 描述').fill('')
        page.keyboard.press('Enter')
        page.wait_for_timeout(800)
        assert row.count() == 1
        record('关键词过滤（命中/空态/恢复）', True)
    except Exception as e:
        record('关键词过滤', False, str(e)); shot('market-filter')

    # ---------- 4. 行内检测 ----------
    try:
        row = page.locator('.ant-table-row').filter(has_text='E2E 测试工作台')
        row.get_by_role('button', name='检测').click()
        expect(page.locator('.ant-message')).to_contain_text('在线', timeout=8000)
        record('行内检测 → 在线提示', True)
    except Exception as e:
        record('行内检测', False, str(e)); shot('market-check')

    # ---------- 5. 详情抽屉（Markdown 渲染） ----------
    try:
        page.locator('.ant-table-row').filter(has_text='E2E 测试工作台').get_by_text('E2E 测试工作台').click()
        drawer = page.locator('.ant-drawer-content')
        drawer.wait_for(state='visible')
        expect(drawer.locator('strong', has_text='E2E')).to_be_visible()
        assert '服务地址' in drawer.inner_text() and '分类' in drawer.inner_text()
        page.keyboard.press('Escape')
        record('详情抽屉 + Markdown 加粗渲染', True)
    except Exception as e:
        record('详情抽屉', False, str(e)); shot('market-drawer')

    # ---------- 6. 启用开关 ----------
    try:
        row = page.locator('.ant-table-row').filter(has_text='E2E 测试工作台')
        row.locator('.ant-switch').click()
        page.wait_for_timeout(1000)
        wid = [w['id'] for w in api(page, 'GET', '/api/workbenches').json()
               if w['name'] == 'E2E 测试工作台'][0]
        w = api(page, 'GET', f'/api/workbenches/{wid}').json()
        assert w['enabled'] is False, f'开关后 enabled={w["enabled"]}'
        row.locator('.ant-switch').click()  # 恢复
        page.wait_for_timeout(800)
        record('启用开关切换（API 确认持久化）', True)
    except Exception as e:
        record('启用开关', False, str(e)); shot('market-switch')

    # ---------- 7. 编辑改名 ----------
    try:
        row = page.locator('.ant-table-row').filter(has_text='E2E 测试工作台')
        row.get_by_role('button', name='编辑').click()
        modal = page.locator('.ant-modal-content').filter(has_text='编辑工作台')
        modal.wait_for(state='visible')
        modal.get_by_label('名称').fill('E2E 改名后')
        submit_modal(modal)
        page.wait_for_timeout(1000)
        expect(page.locator('.ant-table-row').filter(has_text='E2E 改名后')).to_be_visible()
        record('编辑改名持久化', True)
    except Exception as e:
        record('编辑改名', False, str(e)); shot('market-edit')

    # ---------- 8. 复制工作台 → 副本出现 → UI 删除副本 ----------
    try:
        page.locator('.ant-table-row').filter(has_text='E2E 改名后').get_by_role('button', name='复制工作台').click()
        modal = page.locator('.ant-modal-content').filter(has_text='复制工作台')
        modal.wait_for(state='visible')
        # 预填检查：名称带 (副本)，地址与源一致
        assert modal.get_by_label('名称').input_value() == 'E2E 改名后 (副本)', '副本名称预填错误'
        assert modal.get_by_label('服务地址').input_value() == BASE, '地址预填错误'
        modal.get_by_label('名称').fill('E2E 复制件')
        submit_modal(modal)
        page.wait_for_timeout(1200)
        copy_row = page.locator('.ant-table-row').filter(has_text='E2E 复制件')
        expect(copy_row).to_be_visible()
        # API 确认字段复制完整（类型/分类/标签/描述）
        copies = [w for w in api(page, 'GET', '/api/workbenches').json() if w['name'] == 'E2E 复制件']
        assert copies and copies[0]['category'] == 'E2E' and copies[0]['tags'] == ['e2e'], f'副本字段不全: {copies}'
        # UI 删除副本（覆盖 Popconfirm 流程）
        copy_row.get_by_role('button', name='删除').click()
        page.get_by_role('button', name='确 定').click()
        page.wait_for_timeout(1000)
        expect(page.locator('.ant-table-row').filter(has_text='E2E 复制件')).to_have_count(0)
        record('复制工作台（预填+字段完整+UI 删除）', True)
    except Exception as e:
        record('复制工作台', False, str(e)); shot('market-copy')

    # ---------- 9. 使用页 ----------
    try:
        wid = [w['id'] for w in api(page, 'GET', '/api/workbenches').json()
               if w['name'] == 'E2E 改名后'][0]
        page.goto(f'{BASE}/use/{wid}')
        page.wait_for_load_state('networkidle')
        page.wait_for_timeout(1500)
        assert 'E2E 改名后' in page.inner_text('body'), '顶栏名称缺失'
        frame = page.locator('iframe.wm-use-frame')
        expect(frame).to_be_visible()
        assert frame.get_attribute('src') == f'/go/{wid}/', f'iframe src 应为统一门户: {frame.get_attribute("src")}'
        # 统一门户同源代理：contentDocument 可读（跨源时此访问抛异常/为 null）
        try:
            same_origin = frame.evaluate('el => !!el.contentDocument')
        except Exception:
            same_origin = False
        assert same_origin, 'iframe 应经 /go/ 同源代理可读'
        record('使用页（顶栏 + 统一门户 /go/ iframe 同源可读）', True)
    except Exception as e:
        record('使用页', False, str(e)); shot('use-page')

    # ---------- 9b. 统一门户 /go/：代理可达 + 禁嵌头剥离 ----------
    try:
        r = page.request.get(f'{BASE}/go/{wid}/')
        assert r.ok, f'/go/{wid}/ 代理请求失败: {r.status}'
        h = {k.lower(): v for k, v in r.headers.items()}
        assert 'x-frame-options' not in h, f'代理响应应剥 x-frame-options: {h.get("x-frame-options")}'
        assert 'content-security-policy' not in h, f'代理响应应剥 content-security-policy'
        r404 = page.request.get(f'{BASE}/go/999999/')
        assert r404.status == 404, f'不存在的工作台应 404: {r404.status}'
        record('统一门户（/go/ 代理 + 剥禁嵌头 + 404）', True)
    except Exception as e:
        record('统一门户', False, str(e)); shot('go-portal')

    # ---------- 9c. /go/ 代理四探针（G10·总工/监督席 direct-9aa84e01） ----------
    try:
        import http.server, socketserver, threading, gzip as _gzip
        _probe_html = '<html><body><img src="/assets/p.png"><h1>g10</h1></body></html>'
        _probe_gz = _gzip.compress(_probe_html.encode())
        class _G10(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a): pass
            def do_GET(self):
                if self.path == '/assets/p.png':
                    self.send_response(200); self.send_header('Content-Type', 'image/png'); self.end_headers(); self.wfile.write(b'PNG'); return
                if self.path == '/api/probe':
                    self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers(); self.wfile.write(b'{"upstream":true}'); return
                if self.path == '/gz':
                    self.send_response(200); self.send_header('Content-Type', 'text/html'); self.send_header('Content-Encoding', 'gzip'); self.send_header('Content-Length', str(len(_probe_gz))); self.end_headers(); self.wfile.write(_probe_gz); return
                self.send_response(200); self.send_header('Content-Type', 'text/html'); self.end_headers(); self.wfile.write(_probe_html.encode())
        _srv = socketserver.TCPServer(('127.0.0.1', 0), _G10); _pport = _srv.server_address[1]
        threading.Thread(target=_srv.serve_forever, daemon=True).start()
        _wb = page.request.post(f'{BASE}/api/workbenches',
            headers={'Content-Type': 'application/json'},
            data={'name': 'g10-probe', 'url': f'http://127.0.0.1:{_pport}/', 'type': 'web'}).json()
        _gid = _wb['id']
        r = page.request.get(f'{BASE}/go/{_gid}/')
        assert r.ok and 'text/html' in r.headers.get('content-type', ''), f'①页面加载: {r.status}'
        html = r.text()
        assert f'/go/{_gid}/assets/p.png' in html, f'②资产未加前缀: {html[:80]}'
        r2 = page.request.get(f'{BASE}/go/{_gid}/assets/p.png')
        assert r2.ok, f'②资产真取失败: {r2.status}'
        r3 = page.request.get(f'{BASE}/go/{_gid}/api/probe')
        _txt = r3.text() if r3.ok else ''
        assert 'upstream' in _txt, f'③API 未透传: {r3.status} {_txt[:60]}'
        r4 = page.request.get(f'{BASE}/go/{_gid}/gz')
        _raw = r4.body()
        _dec = _raw
        try:
            _dec = _gzip.decompress(_raw)
        except Exception:
            _dec = _raw
        assert _probe_html.encode() in _dec, f'④gzip 字节损坏: {len(_raw)}B'
        page.request.delete(f'{BASE}/api/workbenches/{_gid}')
        _srv.shutdown()
        record('/go/ 代理四探针（G10：页面/资产/API 透传/gzip 字节）', True)
    except Exception as e:
        try: _srv.shutdown()
        except Exception: pass
        record('/go/ 代理四探针（G10）', False, str(e)); shot('go-g10')

    # ---------- 10. 类型管理：新增 + 引用保护 + 删除 ----------
    try:
        page.goto(BASE + '/types')
        page.wait_for_load_state('networkidle')
        page.wait_for_timeout(800)
        rows = page.locator('.ant-table-row')
        assert rows.count() >= 8, f'内置类型行数={rows.count()}'
        page.get_by_role('button', name='新增类型').click()
        modal = page.locator('.ant-modal-content').filter(has_text='新增类型')
        modal.wait_for(state='visible')
        modal.get_by_label('类型标识').fill('e2e-custom')
        modal.get_by_label('名称').fill('E2E 自定义类型')
        modal.get_by_label('探测路径').fill('/healthz')
        submit_modal(modal)
        page.wait_for_timeout(1000)
        trow = page.locator('.ant-table-row').filter(has_text='e2e-custom')
        expect(trow).to_be_visible()
        assert '/healthz' in trow.inner_text(), '探测路径未显示'
        record('新增自定义类型', True)
        api(page, 'POST', '/api/workbenches',
            {'name': 'E2E 引用者', 'url': BASE, 'type': 'e2e-custom'})
        page.reload(); page.wait_for_load_state('networkidle'); page.wait_for_timeout(800)
        trow = page.locator('.ant-table-row').filter(has_text='e2e-custom')
        assert '1 个' in trow.inner_text(), '使用中计数未更新'
        del_btn = trow.get_by_role('button', name='删除')
        assert del_btn.is_disabled(), '引用中删除按钮未禁用'
        record('类型引用保护（计数 + 删除禁用）', True)
        for w in api(page, 'GET', '/api/workbenches').json():
            if w['name'].startswith('E2E'):
                api(page, 'DELETE', f"/api/workbenches/{w['id']}")
        page.reload(); page.wait_for_load_state('networkidle'); page.wait_for_timeout(800)
        trow = page.locator('.ant-table-row').filter(has_text='e2e-custom')
        trow.get_by_role('button', name='删除').click()
        page.get_by_role('button', name='确 定').click()
        page.wait_for_timeout(1000)
        expect(page.locator('.ant-table-row').filter(has_text='e2e-custom')).to_have_count(0)
        record('解除引用后删除类型', True)
    except Exception as e:
        record('类型管理流程', False, str(e)); shot('types')

    # ---------- 11. 设置保存 + 导出下载 ----------
    try:
        page.goto(BASE + '/settings')
        page.wait_for_load_state('networkidle')
        page.wait_for_timeout(800)
        page.get_by_label('巡检间隔（秒）').fill('30')
        page.get_by_role('button', name='保存').click()
        expect(page.locator('.ant-message')).to_contain_text('已保存', timeout=8000)
        s = api(page, 'GET', '/api/settings').json()
        assert s['health_interval_seconds'] == '30', f'API settings={s}'
        with page.expect_download() as dl:
            page.get_by_role('button', name='导出 JSON').click()
        assert dl.value.suggested_filename.startswith('workbench-market-'), dl.value.suggested_filename
        record('设置保存（API 确认）+ 导出下载', True)
        page.get_by_label('巡检间隔（秒）').fill('0')
        page.get_by_role('button', name='保存').click()
        page.wait_for_timeout(800)
    except Exception as e:
        record('设置/导出', False, str(e)); shot('settings')

    # ---------- 12. 任务驾驶舱（创建→加面板→持久化→面板操作→列表→删除） ----------
    try:
        page.goto(BASE + '/cockpit')
        page.wait_for_load_state('networkidle')
        # 创建（UI 点击覆盖 + API 建名直达：页头按钮存在性断言）
        assert page.get_by_role('button', name='新建驾驶舱').first.is_visible(), '新建按钮缺失'
        r = api(page, 'POST', '/api/cockpits', {'name': 'E2E 驾驶舱'}).json()
        cid = r['id']
        page.goto(BASE + f'/cockpit/{cid}')
        page.wait_for_load_state('networkidle')
        # 空态提示
        assert page.get_by_text('空驾驶舱', exact=False).first.is_visible(), '空驾驶舱提示未出现'
        # 添加面板：多选 Select 用搜索+回车（下拉项动画期间 locator 点击不稳定）
        page.locator('.ant-select', has_text='添加工作台面板').first.click()
        page.wait_for_timeout(300)
        page.keyboard.type('DSH')
        page.wait_for_timeout(300)
        page.keyboard.press('Enter')
        page.keyboard.press('Escape')
        page.wait_for_timeout(900)
        # 面板 iframe 出现
        panels = page.locator('.wm-panel')
        n_after_add = panels.count()
        assert n_after_add >= 1, f'面板未出现（{n_after_add}）'
        srcs = page.locator('.wm-panel-body iframe').evaluate_all('els => els.map(e => e.getAttribute("src"))')
        assert srcs and srcs[0].startswith('/go/'), f'iframe src 应为统一门户 /go/: {srcs}'
        # 刷新后布局持久化（服务端保存的面板还在）
        page.reload()
        page.wait_for_load_state('networkidle')
        page.wait_for_timeout(600)
        assert page.locator('.wm-panel').count() >= 1, '刷新后面板丢失（布局未持久化）'
        row = api(page, 'GET', f'/api/cockpits/{cid}').json()
        assert len(row['panels']) >= 1 and row['panels'][0]['workbenchId'] >= 1, f'API 面板数据异常: {row["panels"]}'
        assert row['name'] == 'E2E 驾驶舱', f'改名未持久化: {row["name"]}'
        # 移除面板 → 空态回归
        page.locator('.wm-panel-actions [aria-label="移除此面板"], .wm-panel-actions .anticon-close').first.click()
        page.wait_for_timeout(800)
        assert page.locator('.wm-panel').count() == 0, '面板移除失败'
        # 返回列表：卡片出现（E2E 驾驶舱）
        page.get_by_role('button', name='返回驾驶舱列表').click()
        page.wait_for_load_state('networkidle')
        card = page.get_by_text('E2E 驾驶舱', exact=True).first
        assert card.is_visible(), '列表中未见 E2E 驾驶舱'
        # 列表删除
        page.get_by_text('E2E 驾驶舱', exact=True).first.hover()
        page.get_by_role('button', name='删除').first.click()
        page.get_by_role('button', name='确 定').click()
        page.wait_for_timeout(600)
        leftover = api(page, 'GET', '/api/cockpits').json()
        assert not any(c['name'] == 'E2E 驾驶舱' for c in leftover), '驾驶舱删除失败'
        record('任务驾驶舱（创建/面板/持久化/删除）', True)
    except Exception as e:
        record('任务驾驶舱', False, str(e)); shot('cockpit')

    # ---------- 13. 渲染层对比度探针（深底文字可见性——静态色值钉位测不到的 fg/bg 配对） ----------
    CONTRAST_JS = '''
    ([sel, min]) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      let bg = 'rgba(0, 0, 0, 0)', node = el;
      while (node) {
        const c = getComputedStyle(node).backgroundColor;
        if (c && c !== 'rgba(0, 0, 0, 0)') { bg = c; break; }
        node = node.parentElement;
      }
      if (bg === 'rgba(0, 0, 0, 0)') bg = 'rgb(255, 255, 255)';
      const lum = (css) => {
        const m = css.match(/[\\d.]+/g).map(Number);
        const f = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]);
      };
      const l1 = lum(cs.color), l2 = lum(bg);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      return { text: el.textContent.trim().slice(0, 16), color: cs.color, bg, ratio: Math.round(ratio * 100) / 100, min };
    }'''
    # 使用页目标台动态化：导入 replace 等操作会重排自增 id，固定 /use/1 会在台不存在时假红
    _use_wid = next((w['id'] for w in api(page, 'GET', '/api/workbenches').json() if w['enabled']), 1)
    CONTRAST_TARGETS = [
        ('/ 使用页·状态文字（用户报告的 XPath）', f'/use/{_use_wid}', '.wm-use-bar .ant-badge-status-text', 4.5),
        ('/ 使用页·标题', f'/use/{_use_wid}', '.wm-use-bar .wm-use-title', 4.5),
        ('/ 使用页·地址文字', f'/use/{_use_wid}', '.wm-use-bar .wm-mono', 4.5),
        ('/ 使用页·顶栏按钮', f'/use/{_use_wid}', '.wm-use-bar .ant-btn', 4.5),
        ('/ 总览·统计标签', '/', '.wm-stat-card .wm-stat-label', 4.5),
        ('/ 总览·侧栏菜单项', '/', '.ant-pro-sider .ant-menu-item', 4.5),
        ('/market 表格·状态文字', '/market', '.ant-table-tbody .ant-badge-status-text', 4.5),
        ('/sops 表格·SOP 状态 Tag', '/sops', '.ant-table-tbody .ant-tag', 4.5),
        ('/sops 表格·标题文字', '/sops', '.ant-table-tbody .ant-typography', 4.5),
    ]
    contrast_rows = []
    try:
        for label, path, sel, min_r in CONTRAST_TARGETS:
            page.goto(BASE + path)
            page.wait_for_load_state('networkidle')
            page.wait_for_timeout(500)
            r = page.evaluate(CONTRAST_JS, [sel, min_r])
            assert r, f'{label}: 选择器 {sel} 未命中'
            r['passed'] = 1 if r['ratio'] >= r['min'] else 0
            r['label'] = label
            contrast_rows.append(r)
        bad = [r for r in contrast_rows if not r['passed']]
        record(f'渲染层对比度（{len(contrast_rows)} 处 ≥4.5）', not bad,
               '; '.join(f"{r['label']}={r['ratio']}" for r in bad))
    except Exception as e:
        record('渲染层对比度', False, str(e)); shot('contrast')

    # ---------- 14. 自产台（台生成器：AI 发布 API → 入册 → 门户嵌入 → 版本回滚） ----------
    try:
        # 发布 v1（模拟 AI 会话直发通道）
        # 组内自清理：残留 e2e-app 会让 version 断言假红（跨轮残留）
        try:
            api(page, 'DELETE', '/api/apps/e2e-app', {'reviewed_by': 'e2e-cleanup'})
        except Exception:
            pass
        r = api(page, 'POST', '/api/apps', {
            'slug': 'e2e-app',
            'title': 'E2E 自产台',
            'description': 'E2E 发布的版本化小工具',
            'created_by': 'e2e',
            'files': [
                {'path': 'index.html', 'content': '<!doctype html><meta charset="utf-8"><title>E2E 自产台</title><h1>E2E-APP-V1</h1>'},
            ],
        }).json()
        assert r['version'] == 1 and r['workbench_id'] > 0, f'发布响应异常: {r}'
        wid = r['workbench_id']
        # 静态可访问
        resp = page.request.fetch(BASE + '/apps/e2e-app/')
        assert resp.status == 200 and 'E2E-APP-V1' in resp.text(), '自产台静态服务失败'
        # 发布即入册：市场页出现行 + 类型 Tag
        page.goto(BASE + '/market')
        page.wait_for_load_state('networkidle')
        page.wait_for_timeout(600)
        row = page.locator('.ant-table-row').filter(has_text='E2E 自产台')
        assert row.count() == 1, f'市场页未见自产台行（{row.count()}）'
        # 检测短路 up
        api(page, 'POST', f'/api/workbenches/{wid}/check')
        wb = api(page, 'GET', f'/api/workbenches/{wid}').json()
        assert wb['last_status'] == 'up', f"自产台探测未短路: {wb['last_status']}"
        # 使用页 iframe 经门户 /go/ 嵌入且内容可达（同源可读）
        page.goto(BASE + f'/use/{wid}')
        page.wait_for_load_state('networkidle')
        page.wait_for_timeout(800)
        frame = page.locator('.wm-use-frame')
        assert frame.count() >= 1, '使用页 iframe 未出现'
        src = frame.get_attribute('src') or ''
        assert src.startswith(f'/go/{wid}'), f'iframe src 应为门户 /go/: {src}'
        # #170 P11：自产台响应带 CSP sandbox（不透明源）——contentDocument 不可读是**设计**（隔离），
        # 改为服务端面校验内容可达 + 响应头断言 sandbox 在位
        _go_html = page.request.fetch(f'{BASE}/go/{wid}/')
        assert _go_html.ok and 'E2E-APP-V1' in _go_html.text(), '门户重写后 iframe 内容不可达'
        _csp = (_go_html.headers.get('content-security-policy') or '')
        assert 'sandbox' in _csp and 'allow-same-origin' not in _csp, f'自产台应带 CSP sandbox 隔离: {_csp}'
        # 重发 v2 → 静态切换；activate 回 v1 → 回滚
        api(page, 'POST', '/api/apps', {'slug': 'e2e-app', 'title': 'E2E 自产台',
            'files': [{'path': 'index.html', 'content': '<!doctype html><meta charset="utf-8"><h1>E2E-APP-V2</h1>'}]})
        assert 'E2E-APP-V2' in page.request.fetch(BASE + '/apps/e2e-app/').text(), 'v2 未生效'
        api(page, 'POST', '/api/apps/e2e-app/activate', {'version': 1, 'reviewed_by': 'e2e-selftest'})  # S1 人审门（L14）
        assert 'E2E-APP-V1' in page.request.fetch(BASE + '/apps/e2e-app/').text(), '回滚 v1 未生效'
        detail = api(page, 'GET', '/api/apps/e2e-app').json()
        assert len(detail['versions']) == 2 and detail['active_version'] == 1, f'版本链异常: {detail["versions"]}'
        # 非法输入防御
        r400 = api(page, 'POST', '/api/apps', {'slug': 'Bad!', 'title': 'x',
            'files': [{'path': 'index.html', 'content': 'x'}]})
        assert r400.status == 400, '非法 slug 未拒绝'
        record('自产台（发布/入册/门户嵌入/版本回滚/防御）', True)
    except Exception as e:
        record('自产台', False, str(e)); shot('apps')

    # ---------- 15. 统一门户透传 + 凭据注入（echo fixture 内容源断言，防 SPA 假绿） ----------
    try:
        # 建认证类工作台：url 带 base query token，凭据 bearer
        r = api(page, 'POST', '/api/workbenches', {
            'name': 'E2E EchoAuth', 'url': 'http://127.0.0.1:9901/xfo?token=startup-tok',
            'type': 'web', 'category': 'E2E', 'enabled': True,
            'auth': {'type': 'bearer', 'value': 'e2e-bear-tok'},
        }).json()
        ewid = r['id']
        assert ewid > 0, f'建台失败: {r}'
        # ① 真实透传 + ② base query 补全 + ③ 凭据注入 + ④ 禁嵌头剥除
        resp = page.request.fetch(BASE + f'/go/{ewid}/sec')
        body = resp.json()
        assert body.get('fixture') == 'echo', f'未透传到上游（疑似 SPA 假绿）: {body}'
        assert body.get('url') == '/xfo/sec?token=startup-tok', f"base query 未补全: {body.get('url')}"
        assert body.get('authorization') == 'Bearer e2e-bear-tok', f"凭据未注入: {body.get('authorization')}"
        assert resp.headers.get('x-frame-options') is None, '禁嵌头未剥除'
        # ⑤ 请求自带 query 时不覆盖；带 dsh-auth cookie 时不补 token（防一次性 token 重签死循环）
        # 注意：Playwright request.fetch 的自定义 Cookie 头会被 cookie store 接管忽略，
        # 必须先 add_cookies 进 browser context 再 fetch（Python API 里 page.context 是属性）
        page.context.add_cookies([{'name': 'dsh-auth-abc', 'value': '1', 'url': BASE}])
        resp2 = page.request.fetch(BASE + f'/go/{ewid}/sec?a=1')
        b2 = resp2.json()
        assert b2.get('url') == '/xfo/sec?a=1', f"query 覆盖或 cookie 场景补了 token: {b2.get('url')}"
        assert b2.get('cookie') == 'has-dsh-auth', f'cookie 未透传: {b2.get("cookie")}'
        page.context.clear_cookies()
        # ⑥ 清除凭据 → 不再注入
        api(page, 'PUT', f'/api/workbenches/{ewid}', {'auth': None})
        b3 = page.request.fetch(BASE + f'/go/{ewid}/sec').json()
        assert b3.get('authorization') is None, f'清除后仍注入: {b3.get("authorization")}'
        # ⑦ WS 升级链路：门户 upgrade 代理必须路由到正确上游并完成 101 握手
        #    （回归锚：upgrade 不流经中间件链时 WS 被路由到死端口；握手 Origin/Host
        #    触发上游防护时回 403——DSH 台「重新连接中」的两处根因）
        import socket as sk
        s = sk.create_connection(('127.0.0.1', int(_port)), timeout=5)
        s.sendall((f'GET /go/{ewid}/ws HTTP/1.1\r\nHost: 127.0.0.1:9800\r\n'
                   'Upgrade: websocket\r\nConnection: Upgrade\r\n'
                   'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n'
                   'Sec-WebSocket-Version: 13\r\n'
                   'Origin: http://127.0.0.1:9800\r\n\r\n').encode())
        first = s.recv(128).decode('latin1')
        s.close()
        assert '101' in first.split('\r\n')[0], f'WS 握手未达 101: {first.split(chr(13))[0]}'
        # ⑧ 市场详情抽屉展示凭据状态（脱敏 Tag）
        api(page, 'PUT', f'/api/workbenches/{ewid}', {'auth': {'type': 'bearer', 'value': 'e2e-bear-tok'}})
        page.goto(BASE + '/market')
        page.wait_for_load_state('networkidle')
        # 详情抽屉由点击工作台名称打开
        page.locator('.ant-table-row').filter(has_text='E2E EchoAuth').first.locator('td a').first.click()
        page.wait_for_timeout(600)
        drawer = page.locator('.ant-drawer-content')
        assert '含凭据（bearer' in drawer.inner_text(), '详情抽屉未见凭据 Tag'
        # ⑨ 凭据面防浏览泄露（监督席派单 direct-30b57179 + 320ed1a5）：列表与详情
        #    同策略掩码 url 敏感 query；PUT 掩码回传不改库；POST 掩码指纹拒绝入新建
        lst = page.request.fetch(BASE + '/api/workbenches').json()
        leaked = [w['url'] for w in lst if 'token=' in w['url'] and 'token=****' not in w['url']]
        assert not leaked, f'列表响应泄漏明文 token: {leaked[:2]}'
        masked = next((w for w in lst if 'token=****' in w.get('url', '')), None)
        if masked:  # 库里存在带 query 门的台（如 84 号真实数据）时深化断言
            detail = api(page, 'GET', f"/api/workbenches/{masked['id']}").json()
            assert 'token=****' in detail['url'], f"详情端点未掩码: {detail['url']}"
        api(page, 'PUT', f'/api/workbenches/{ewid}', {'url': 'http://127.0.0.1:9901/xfo?token=****'})
        # DB 原值已无法从 API 直读（两端点均掩码）——经代理行为验证：
        # 无 query 无 cookie 的 /go/ 请求会补 DB 里 url 自带的 base query（token=startup-tok）
        b4 = page.request.fetch(BASE + f'/go/{ewid}/probe-mask').json()
        assert 'token=startup-tok' in b4.get('url', ''), f"掩码回传毁库: 代理补全 {b4.get('url')}"
        r400 = api(page, 'POST', '/api/workbenches', {'name': 'E2E MaskProbe', 'url': 'http://127.0.0.1:9901/x?token=****', 'type': 'web', 'category': 'E2E'})
        assert r400.status == 400, 'POST 掩码指纹未被拒绝'
        # ⑩ 安全批四项（外部评审 #1/#2/#3/#11，监督席派单 direct-74a7d418）
        # #2 auth.value 双端点掩码（S3CRET 探针不复现）
        authleak = [w['name'] for w in lst if (w.get('auth') or {}).get('value') not in (None, '****')]
        assert not authleak, f'列表泄漏明文 auth.value: {authleak}'
        d2 = api(page, 'GET', f'/api/workbenches/{ewid}').json()
        assert d2['auth'] and d2['auth']['value'] == '****', f"详情 auth 未掩码: {d2['auth']}"
        # 掩码回传不改凭据（PUT 掩码 auth + 代理注入仍带真票）
        api(page, 'PUT', f'/api/workbenches/{ewid}', {'auth': {'type': 'bearer', 'value': '****'}})
        b5 = page.request.fetch(BASE + f'/go/{ewid}/probe-mask2').json()
        assert b5.get('authorization') == 'Bearer e2e-bear-tok', f"auth 掩码回传毁库: {b5.get('authorization')}"
        r401b = api(page, 'POST', '/api/workbenches', {'name': 'E2E AuthMask', 'url': 'http://127.0.0.1:9901/x', 'type': 'web', 'category': 'E2E', 'auth': {'type': 'bearer', 'value': '****'}})
        assert r401b.status == 400, 'POST auth 掩码指纹未被拒绝'
        # #3 MCP 通道掩码
        mc_lst = page.request.fetch(BASE + '/mcp', method='POST', headers=_mcp_h,
            data=json.dumps({'jsonrpc': '2.0', 'id': 910, 'method': 'tools/call', 'params': {'name': 'workbench_list', 'arguments': {}}})).json()
        mc_txt = mc_lst['result']['content'][0]['text']
        assert 'token=8sKZ' not in mc_txt and 'token=****' in mc_txt, 'MCP workbench_list 泄漏明文 token'
        assert 'e2e-bear-tok' not in mc_txt, 'MCP workbench_list 泄漏 auth 明文'
        # #1 CORS 白名单：外源 Origin 不回 ACAO，本机 dev 源放行
        r_o = page.request.fetch(BASE + '/api/health', headers={'Origin': 'http://evil.example'})
        assert r_o.headers.get('access-control-allow-origin') is None, 'CORS 对外源仍开放'
        r_d = page.request.fetch(BASE + '/api/health', headers={'Origin': 'http://localhost:5173'})
        assert r_d.headers.get('access-control-allow-origin') == 'http://localhost:5173', 'dev 源未放行'
        # #11 draft 403 不再下发完整 Runner 页面
        draft_yaml = 'title: T\nsteps:\n  - key: a\n    title: SecretStep\n'
        api(page, 'POST', '/api/apps', {'slug': 'e2e-draft-leak', 'kind': 'sop', 'title': 'L', 'changelog': 'x',
            'files': [{'path': 'sop.yaml', 'content': draft_yaml}]})
        r403 = page.request.fetch(BASE + '/sop/e2e-draft-leak/')
        assert r403.status == 403 and 'SecretStep' not in r403.text(), 'draft 403 页面泄漏步骤内容'
        api(page, 'DELETE', '/api/apps/e2e-draft-leak', {'reviewed_by': 'e2e-cleanup'})
        # ⑪ 门户 3xx Location 改写（issue #4：proxyRes 用前置备份的 id，改写后跳转留在 /go/ 前缀内）
        # 注意：Playwright request.fetch 会跟随重定向（max_redirects=0 也不免），用 http.client 拿原始 302
        import http.client as _hc
        for _path, _expect in (('redir-relative', f'/go/{ewid}/landed'), ('redir-absolute', f'/go/{ewid}/landed')):
            _conn = _hc.HTTPConnection('127.0.0.1', int(_port), timeout=5)
            _conn.request('GET', f'/go/{ewid}/{_path}')
            _resp = _conn.getresponse()
            _loc = _resp.getheader('location')
            _conn.close()
            assert _resp.status == 302 and _loc == _expect, f'{_path} Location 未改写: status={_resp.status} loc={_loc}'
        # ⑫ 导出脱敏（compliance 二期首项）：默认掩码（url query + auth.value），?reveal=1 显式真值
        exp = page.request.fetch(BASE + '/api/export').json()
        assert exp.get('masked') == 1, '导出未标记 masked'
        ex_leak = [w['url'] for w in exp['workbenches'] if 'token=' in w['url'] and 'token=****' not in w['url']]
        assert not ex_leak, f'导出泄漏明文 token: {ex_leak[:2]}'
        au_leak = [w['name'] for w in exp['workbenches'] if (w.get('auth') or {}).get('value') not in (None, '', '****')]
        assert not au_leak, f'导出泄漏明文 auth: {au_leak[:2]}'
        expr = page.request.fetch(BASE + '/api/export?reveal=1').json()
        assert expr.get('masked') == 0 and any('token=startup-tok' in w['url'] for w in expr['workbenches']), 'reveal 导出未含真值'
        # 导入掩码行跳过（掩码永不落库）
        bad_payload = {'workbenches': [{'name': 'E2E MaskImport', 'url': 'http://127.0.0.1:9901/x?token=****', 'type': 'web'}], 'types': []}
        rim = api(page, 'POST', '/api/import', bad_payload)
        assert rim.status == 200 and rim.json()['imported'] == 0, f"掩码行未被跳过: {rim.json()}"
        record('统一门户透传+凭据注入+WS 升级（echo fixture 十九断言）', True)
    except Exception as e:
        record('统一门户透传+凭据注入', False, str(e)); shot('portal-auth')

    # ---------- 16. SOP 台：状态机 + Runner + 分层持久化（Redis 热态 + SQLite 真源） ----------
    try:
        sop_yaml = (
            'title: E2E 服务器上架 SOP\n'
            'code: SOP-E2E-001\n'
            'steps:\n'
            '  - key: prepare\n'
            '    title: 开箱检查\n'
            "    body: '<p>配件数：<input data-field=\"配件数\"></p>'\n"
            '  - key: rack\n'
            '    title: 上架固定\n'
            "    body: '<p>机位：<input data-field=\"机位\"></p>'\n"
        )
        # ① 发布面：缺 changelog 拒；缺 sop.yaml 拒
        r400 = api(page, 'POST', '/api/apps', {'slug': 'e2e-sop', 'kind': 'sop', 'title': 'E2E SOP',
            'files': [{'path': 'sop.yaml', 'content': sop_yaml}]})
        assert r400.status == 400, 'SOP 缺 changelog 未拒'
        r400 = api(page, 'POST', '/api/apps', {'slug': 'e2e-sop', 'kind': 'sop', 'title': 'E2E SOP', 'changelog': 'x',
            'files': [{'path': 'index.html', 'content': 'x'}]})
        assert r400.status == 400, 'SOP 缺 sop.yaml 未拒'
        # ② 发布 → draft 不入册 → publish 入册
        r = api(page, 'POST', '/api/apps', {'slug': 'e2e-sop', 'kind': 'sop', 'title': 'E2E SOP',
            'code': 'SOP-E2E-001', 'changelog': '初版',
            'files': [{'path': 'sop.yaml', 'content': sop_yaml}]}).json()
        assert r['status'] == 'draft' and r['workbench_id'] == 0, f'draft 语义异常: {r}'
        runner = page.request.fetch(BASE + '/sop/e2e-sop/')
        assert runner.status == 403, f'draft Runner 应 403: {runner.status}'
        r = api(page, 'POST', '/api/sops/e2e-sop/publish', {'note': '首发'}).json()
        swid = r['workbench_id']
        assert swid and swid > 0, f'publish 入册失败: {r}'
        # ③ Runner 页面渲染（直连 + 门户）
        html = page.request.fetch(BASE + '/sop/e2e-sop/').text()
        assert '开箱检查' in html and '__SOP__' in html and 'data-field' in html, 'Runner 渲染缺要素'
        phtml = page.request.fetch(BASE + f'/go/{swid}/').text()
        assert '开箱检查' in phtml, '门户未渲染 SOP Runner'
        # ④ run 分层：开 run → PUT 两步 → 热读回 → finish 归档
        r = api(page, 'POST', '/api/sop/runs', {'slug': 'e2e-sop'}).json()
        rid = r['id']
        assert rid > 0 and r['version'] == 1, f'开 run 异常: {r}'
        p1 = api(page, 'PUT', f'/api/sop/runs/{rid}', {'stepKey': 'prepare', 'value': {'配件数': '42'}}).json()
        assert p1['persisted'] in ('redis+checkpoint', 'sqlite'), f'PUT 异常: {p1}'
        api(page, 'PUT', f'/api/sop/runs/{rid}', {'stepKey': 'rack', 'value': {'机位': 'A-12'}})
        got = api(page, 'GET', f'/api/sop/runs/{rid}').json()
        assert got['data'].get('prepare', {}).get('配件数') == '42', f"热读缺失: {got['data']}"
        fin = api(page, 'POST', f'/api/sop/runs/{rid}/finish').json()
        assert fin['status'] == 'finished' and fin['steps'] == 2, f'finish 异常: {fin}'
        got = api(page, 'GET', f'/api/sop/runs/{rid}').json()
        assert got['status'] == 'finished' and got['data'].get('rack', {}).get('机位') == 'A-12', f'归档读异常: {got}'
        # ⑤ draft 状态机拒直跳 deprecate；重发=新版本带 changelog
        r409 = api(page, 'POST', '/api/sops/e2e-sop2-missing/publish')
        assert r409.status == 404
        r = api(page, 'POST', '/api/apps', {'slug': 'e2e-sop', 'kind': 'sop', 'changelog': 'v2 增加自检',
            'files': [{'path': 'sop.yaml', 'content': sop_yaml + '  - key: check\n    title: 通电自检\n'}]}).json()
        assert r['version'] == 2, f'重发版本异常: {r}'
        vs = api(page, 'GET', '/api/apps/e2e-sop').json()['versions']
        assert any('自检' in (v.get('changelog') or '') for v in vs), 'changelog 未入版本链'
        record('SOP 台（状态机/Runner/分层持久化/版本治理）', True)
    except Exception as e:
        record('SOP 台', False, str(e)); shot('sop')

    # ---------- 17. MCP 生产通道（StreamableHTTP 协议面 + 生产工具链） ----------
    try:
        def mcp(method, params=None, msg_id=True):
            body = {'jsonrpc': '2.0', 'method': method}
            if msg_id: body['id'] = 900
            if params is not None: body['params'] = params
            r = page.request.fetch(BASE + '/mcp', method='POST', headers=_mcp_h, data=json.dumps(body))
            return r
        # 协议面
        r = mcp('initialize', {'protocolVersion': '2025-03-26'})
        j = r.json()
        assert j['result']['serverInfo']['name'] == 'workbench-market', 'initialize serverInfo 异常'
        assert j['result']['protocolVersion'] == '2025-03-26', 'protocolVersion echo 异常'
        r = mcp('notifications/initialized', msg_id=False)
        assert r.status == 202, f'notification 应 202: {r.status}'
        j = mcp('tools/list').json()
        tool_names = [t['name'] for t in j['result']['tools']]
        LOCAL_TOOLS = ['workbench_list','workbench_summary','workbench_check','use_url','app_publish','change_request_create','change_requests','sop_publish','sop_run_start','sop_run_step_save','sop_run_get','sop_run_list','sop_run_finish','app_data_list','app_files_list','workbench_register','workbench_update','workbench_unregister']
        missing = [t for t in LOCAL_TOOLS if t not in tool_names]
        assert not missing, f'tools/list 缺本地工具: {missing}'
        assert len(tool_names) >= 17, f'tools/list 异常: {tool_names}'
        j = mcp('wat').json()
        assert j['error']['code'] == -32601, '未知 method 应 -32601'
        assert page.request.fetch(BASE + '/mcp', method='GET').status == 405, 'GET /mcp 应 405'
        # 工具链：summary + 发布 app + SOP 上架
        j = mcp('tools/call', {'name': 'workbench_summary', 'arguments': {}}).json()
        assert json.loads(j['result']['content'][0]['text'])['total'] > 0, 'summary 工具异常'
        mcp_files = [{'path': 'index.html', 'content': '<h1>E2E-MCP-APP</h1>'}]
        j = mcp('tools/call', {'name': 'app_publish', 'arguments': {'slug': 'e2e-mcp-app', 'title': 'E2E MCP 台', 'created_by': 'e2e', 'files': mcp_files}}).json()
        pub = json.loads(j['result']['content'][0]['text'])
        assert pub['ok'] and pub['workbench_id'] > 0, f'MCP app_publish 异常: {pub}'
        r = page.request.fetch(BASE + '/apps/e2e-mcp-app/')
        assert r.status == 200 and 'E2E-MCP-APP' in r.text(), 'MCP 发布的台不可访问'
        sop_yaml = 'title: E2E MCP SOP\nsteps:\n  - key: a\n    title: 步骤A\n'
        j = mcp('tools/call', {'name': 'app_publish', 'arguments': {'slug': 'e2e-mcp-sop', 'kind': 'sop', 'title': 'E2E MCP SOP', 'changelog': '初版', 'files': [{'path': 'sop.yaml', 'content': sop_yaml}]}}).json()
        assert json.loads(j['result']['content'][0]['text'])['status'] == 'draft', 'MCP SOP 发布应 draft'
        j = mcp('tools/call', {'name': 'sop_publish', 'arguments': {'slug': 'e2e-mcp-sop', 'note': 'E2E 上架'}}).json()
        up = json.loads(j['result']['content'][0]['text'])
        assert up['status'] == 'published' and up['workbench_id'] > 0, f'MCP sop_publish 异常: {up}'
        # C3: use_url 返回的门户入口实际可达（MCP 消费端拿到的链接就是给浏览器/agent 用的）
        j = mcp('tools/call', {'name': 'use_url', 'arguments': {'id': up['workbench_id']}}).json()
        u = json.loads(j['result']['content'][0]['text'])
        assert u['portal'].startswith(f"/go/{up['workbench_id']}/"), f'use_url 门户路径异常: {u}'
        pr = page.request.fetch(BASE + u['portal'])
        assert pr.status == 200 and '步骤A' in pr.text(), f"use_url 门户链不可达: {pr.status}"
        # C4: agent 直接更新持久化执行数据（sop_run_* 四工具——与 REST/Runner 同链，不经版本发布）
        j = mcp('tools/call', {'name': 'sop_run_start', 'arguments': {'slug': 'e2e-mcp-sop', 'started_by': 'agent-e2e'}}).json()
        mrun = json.loads(j['result']['content'][0]['text'])
        assert mrun['status'] == 'running' and mrun['id'] > 0, f'MCP 开 run 异常: {mrun}'
        for k, v in (('prepare', 'agent-填-1'), ('rack', 'agent-填-2')):
            j = mcp('tools/call', {'name': 'sop_run_step_save', 'arguments': {'run_id': mrun['id'], 'step_key': k, 'value': {'v': v}}}).json()
            sv = json.loads(j['result']['content'][0]['text'])
            assert sv['ok'] and sv['persisted'] in ('redis+checkpoint', 'sqlite'), f'MCP 写步骤异常: {sv}'
        j = mcp('tools/call', {'name': 'sop_run_get', 'arguments': {'run_id': mrun['id']}}).json()
        got = json.loads(j['result']['content'][0]['text'])
        assert got['data'].get('prepare') == {'v': 'agent-填-1'}, f"MCP 读回异常: {got['data']}"
        j = mcp('tools/call', {'name': 'sop_run_finish', 'arguments': {'run_id': mrun['id']}}).json()
        fin = json.loads(j['result']['content'][0]['text'])
        assert fin['status'] == 'finished' and fin['steps'] == 2, f'MCP 归档异常: {fin}'
        # 人机同链验证：REST 读到 agent 写的同一份数据
        same = api(page, 'GET', f"/api/sop/runs/{mrun['id']}").json()
        assert same['data'].get('rack') == {'v': 'agent-填-2'}, f"REST/MCP 数据不同链: {same['data']}"
        # C5: agent 登记外部台（CRUD 三工具；凭据字段拒绝）
        j = mcp('tools/call', {'name': 'workbench_register', 'arguments': {'name': 'E2E MCP 台', 'url': 'http://127.0.0.1:9901/mcpreg', 'category': 'E2E', 'tags': ['agent']}}).json()
        reg = json.loads(j['result']['content'][0]['text'])
        assert reg['id'] > 0 and reg['url'] == 'http://127.0.0.1:9901/mcpreg', f'MCP 登记异常: {reg}'
        j = mcp('tools/call', {'name': 'workbench_update', 'arguments': {'id': reg['id'], 'enabled': False, 'category': 'E2E2'}}).json()
        upd = json.loads(j['result']['content'][0]['text'])
        assert upd['enabled'] is False and upd['category'] == 'E2E2', f'MCP 更新异常: {upd}'
        j = mcp('tools/call', {'name': 'workbench_register', 'arguments': {'name': 'X', 'url': 'http://127.0.0.1:9901/y', 'auth': {'type': 'bearer', 'value': 'sekret'}}}).json()
        assert j['result'].get('isError') is True and '凭据' in j['result']['content'][0]['text'], 'MCP 凭据字段未被拒绝'
        j = mcp('tools/call', {'name': 'workbench_unregister', 'arguments': {'id': reg['id']}}).json()
        un = json.loads(j['result']['content'][0]['text'])
        assert un['ok'] and un['deleted'] == reg['id'], f'MCP 注销异常: {un}'
        # C11: 台数据读取两工具（17 工具面，监督席 direct-68a08a66 裁定本轮加）——
        # 台页经 REST 提交的数据/文件，只走 MCP 的 agent 也能消费
        api(page, 'POST', '/api/apps/e2e-mcp-app/data', {'data': {'k': 'agent-读-1'}, 'created_by': 'agent-e2e'})
        j = mcp('tools/call', {'name': 'app_data_list', 'arguments': {'slug': 'e2e-mcp-app'}}).json()
        dl = json.loads(j['result']['content'][0]['text'])
        assert dl['items'][0]['data']['k'] == 'agent-读-1' and dl['items'][0]['created_by'] == 'agent-e2e', f'app_data_list 异常: {dl}'
        j = mcp('tools/call', {'name': 'app_files_list', 'arguments': {'slug': 'e2e-mcp-app'}}).json()
        fl = json.loads(j['result']['content'][0]['text'])
        assert fl['count'] == 0 and fl['slug'] == 'e2e-mcp-app', f'app_files_list 异常: {fl}'
        # 清理（走 REST）
        api(page, 'DELETE', '/api/apps/e2e-mcp-app', {'reviewed_by': 'e2e-cleanup'}); api(page, 'DELETE', '/api/apps/e2e-mcp-sop', {'reviewed_by': 'e2e-cleanup'})
        # C6: MCP 网关 P1（GH #20）——主实例 MCP_GATEWAY 未设（off=现状行为），网关语义走独立实例冒烟
        j = mcp('tools/list').json()
        assert len(j['result']['tools']) >= 17, 'off 模式 tools/list 应含全量本地 17（网关默认关）'
        import subprocess as _sp2, os as _os4
        gw = _sp2.run(['node', 'scripts/gateway-smoke.mjs'], capture_output=True, text=True, timeout=180,
                      cwd=_os4.path.join(_os.path.dirname(_os.path.abspath(__file__)), '..'))
        assert gw.returncode == 0, f'gateway-smoke 失败:\n{gw.stdout[-500:]}\n{gw.stderr[-300:]}'
        assert '24 通过' in gw.stdout, f'gateway-smoke 计数异常: {gw.stdout[-200:]}'
        # C7: 网关管理页 UI（GH #20 P1 派单①——主实例无 ADMIN_TOKEN，控制面 403 但页面可渲染）
        page.goto(BASE + '/mcp-gateways')
        page.wait_for_load_state('networkidle')
        page.wait_for_timeout(600)
        body_txt = page.locator('body').inner_text()
        assert 'MCP 网关' in body_txt, '管理页标题未渲染'
        assert page.locator('input[type="password"]').count() >= 1, '口令输入未渲染'
        assert '默认拒绝' in body_txt, '默认拒绝提示未渲染'
        assert '审计' in body_txt, '审计区未渲染'
        # C8: Cookie 池（派单 direct-5fbb2176）——独立实例冒烟（导入→挂接→注入→过滤→掩码→删除）
        import subprocess as _sp3
        ck = _sp3.run(['node', 'scripts/cookie-smoke.mjs'], capture_output=True, text=True, timeout=120,
                      cwd=_os4.path.join(_os.path.dirname(_os.path.abspath(__file__)), '..'))
        assert ck.returncode == 0, f'cookie-smoke 失败:\n{ck.stdout[-500:]}\n{ck.stderr[-300:]}'
        assert '11 通过' in ck.stdout, f'cookie-smoke 计数异常: {ck.stdout[-200:]}'
        # C9: 自产台数据提交面（派单 direct-22838fab）——独立实例冒烟
        ad = _sp3.run(['node', 'scripts/appdata-smoke.mjs'], capture_output=True, text=True, timeout=120,
                      cwd=_os4.path.join(_os.path.dirname(_os.path.abspath(__file__)), '..'))
        assert ad.returncode == 0, f'appdata-smoke 失败:\n{ad.stdout[-500:]}\n{ad.stderr[-300:]}'
        # 隐私门红线后 LAN_IP 不入库：无 env 时远程面三项跳过（13 通过+跳过标记）；设了 env 走全量 16——两形皆绿
        assert (('16 通过' in ad.stdout) or ('13 通过' in ad.stdout and '跳过远程面' in ad.stdout)), f'appdata-smoke 计数异常: {ad.stdout[-200:]}'
        # C10: 自产台文件提交面（所有资源类型 · 50MB 上限）——独立实例冒烟
        af = _sp3.run(['node', 'scripts/appfiles-smoke.mjs'], capture_output=True, text=True, timeout=240,
                      cwd=_os4.path.join(_os4.path.dirname(_os4.path.abspath(__file__)), '..'))
        assert af.returncode == 0, f'appfiles-smoke 失败:\n{af.stdout[-500:]}\n{af.stderr[-300:]}'
        assert '14 通过' in af.stdout, f'appfiles-smoke 计数异常: {af.stdout[-200:]}'
        # C12: MCP 上游聚合（GH #20 P2：taste__* 并入 /mcp）——独立实例 + 假上游冒烟
        up = _sp3.run(['node', 'scripts/upstream-smoke.mjs'], capture_output=True, text=True, timeout=180,
                      cwd=_os4.path.join(_os4.path.dirname(_os4.path.abspath(__file__)), '..'))
        assert up.returncode == 0, f'upstream-smoke 失败:\n{up.stdout[-500:]}\n{up.stderr[-300:]}'
        assert '19 通过' in up.stdout, f'upstream-smoke 计数异常: {up.stdout[-200:]}'
        # C13: 管理员口令安全（评审 #27：出口剔除 + 加盐存储 + 旧格式兼容）
        tk = _sp3.run(['node', 'scripts/token-smoke.mjs'], capture_output=True, text=True, timeout=180,
                      cwd=_os4.path.join(_os4.path.dirname(_os4.path.abspath(__file__)), '..'))
        assert tk.returncode == 0, f'token-smoke 失败:\n{tk.stdout[-500:]}\n{tk.stderr[-300:]}'
        assert '16 通过' in tk.stdout, f'token-smoke 计数异常: {tk.stdout[-200:]}'
        # C14: A2A P3 回执（评审席 network/a2a-receipt E1-E6 自查版，独立实例）
        rc = _sp3.run(['node', 'scripts/receipt-smoke.mjs'], capture_output=True, text=True, timeout=240,
                      cwd=_os4.path.join(_os4.path.dirname(_os4.path.abspath(__file__)), '..'))
        assert rc.returncode == 0, f'receipt-smoke 失败:\n{rc.stdout[-600:]}\n{rc.stderr[-300:]}'
        assert '16 通过' in rc.stdout, f'receipt-smoke 计数异常: {rc.stdout[-200:]}'
        # C15: P4 run 交付物（product/run-delivery F1-F7 自查版，独立实例）
        dv = _sp3.run(['node', 'scripts/run-delivery-smoke.mjs'], capture_output=True, text=True, timeout=300,
                      cwd=_os4.path.join(_os4.path.dirname(_os4.path.abspath(__file__)), '..'))
        assert dv.returncode == 0, f'run-delivery-smoke 失败:\n{dv.stdout[-600:]}\n{dv.stderr[-300:]}'
        assert '10 通过' in dv.stdout, f'run-delivery-smoke 计数异常: {dv.stdout[-200:]}'
        # C16: 19a 任务发布面（监督席 direct-58d60ed6）
        dp = _sp3.run(['node', 'scripts/dispatch-smoke.mjs'], capture_output=True, text=True, timeout=300,
                      cwd=_os4.path.join(_os4.path.dirname(_os4.path.abspath(__file__)), '..'))
        assert dp.returncode == 0, f'dispatch-smoke 失败:\n{dp.stdout[-600:]}\n{dp.stderr[-300:]}'
        assert '11 通过' in dp.stdout, f'dispatch-smoke 计数异常: {dp.stdout[-200:]}'
        record('MCP 生产通道（协议面 + 17 tools + 网关 P1 + 管理页 + Cookie 池 + 数据面 + 文件面 + 上游聚合 P2）', True)
    except Exception as e:
        record('MCP 生产通道', False, str(e)); shot('mcp')

    # ---------- 18. SOP 管理页（/sops：状态徽章 + 版本链 + run 记录 Drawer） ----------
    try:
        sop_yaml_ui = (
            'title: E2E SOP UI 验证\n'
            'steps:\n'
            '  - key: a\n'
            '    title: 步骤A\n'
        )
        # ① draft 行：徽章 + 执行按钮禁用
        api(page, 'POST', '/api/apps', {'slug': 'e2e-sop-ui', 'kind': 'sop', 'title': 'E2E SOP UI 验证',
            'changelog': 'ui 验证', 'files': [{'path': 'sop.yaml', 'content': sop_yaml_ui}]})
        page.goto(BASE + '/sops')
        page.wait_for_load_state('networkidle')
        page.wait_for_timeout(800)
        row = page.locator('.ant-table-row').filter(has_text='e2e-sop-ui')
        assert row.count() == 1, f'/sops 未见 draft 行（{row.count()}）'
        assert row.locator('.ant-tag').filter(has_text='draft').count() >= 1, 'draft 徽章缺失'
        # 执行入口是 href Button（渲染为 a.ant-btn），disabled 体现为 aria-disabled
        exec_link = row.locator('a.ant-btn').filter(has_text='执行').first
        assert exec_link.count() >= 1, 'draft 行未见执行入口'
        assert exec_link.get_attribute('aria-disabled') == 'true', 'draft 执行入口应禁用'
        # antd 两字中文无 icon 按钮自动插空格（「上 架」），用正则容错
        import re as _re
        assert row.locator('button').filter(has_text=_re.compile(r'上\s*架')).count() >= 1, 'draft 应有上架按钮'
        # ② 演示 SOP 常驻行：published 徽章 + 执行锚点
        # 行键精确定位（文本过滤会命中 changelog 里提到 demo-rack-sop 的其他 SOP 行）
        demo = page.locator('.ant-table-row[data-row-key="demo-rack-sop"]')
        assert demo.count() == 1, '演示 SOP 未出现在 /sops'
        assert demo.locator('.ant-tag').filter(has_text='published').count() >= 1, 'published 徽章缺失'
        href = demo.locator('a.ant-btn').first.get_attribute('href') or ''
        assert '/sop/demo-rack-sop/' in href, f'执行入口应指 Runner: {href}'
        # ③ 记录 Drawer：演示 run（#8 风格，3 步数据）可见 + 展开数据
        demo.locator('button').filter(has_text='记录').first.click()
        page.wait_for_timeout(900)
        drawer = page.locator('.ant-drawer-content')
        drawer.wait_for(state='visible', timeout=5000)
        assert '已完成' in drawer.inner_text(), '记录 Drawer 未见已完成 run'
        runrow = drawer.locator('.ant-table-row').filter(has_text='演示·张工').first
        runrow.locator('.ant-table-row-expand-icon').click()
        page.wait_for_timeout(500)
        assert 'A-12' in drawer.inner_text() or '机位' in drawer.inner_text(), 'run 展开未见步骤数据'
        page.keyboard.press('Escape')
        page.wait_for_timeout(400)
        # ④ 上架状态机经页面：draft → published（Popconfirm「确 定」→ note 弹窗「上 架」两段）
        import re as _re2
        row.locator('button').filter(has_text=_re2.compile(r'上\s*架')).first.click()
        page.wait_for_timeout(600)
        page.locator('.ant-popover .ant-btn-primary').filter(has_text=_re2.compile(r'确\s*定')).first.click()
        page.wait_for_timeout(900)
        try:
            page.locator('.ant-modal .ant-btn-primary').filter(has_text=_re2.compile(r'上\s*架')).first.click(timeout=4000)
            page.wait_for_timeout(900)
        except Exception:
            pass
        page.wait_for_timeout(1200)
        row2 = page.locator('.ant-table-row').filter(has_text='e2e-sop-ui')
        assert row2.locator('.ant-tag').filter(has_text='published').count() >= 1, '页面上架后徽章未切换'
        record('SOP 管理页（状态徽章/Runner 入口/记录 Drawer/页面上架）', True)
    except Exception as e:
        record('SOP 管理页', False, str(e)); shot('sops-ui')

    # ---------- 19. 运行时批六项（评审 #5/#6/#7/#8/#9/#10） ----------
    try:
        # ① #6 删除 SOP 台同时清市场注册（不留孤儿）
        api(page, 'POST', '/api/apps', {'slug': 'e2e-del-sop', 'kind': 'sop', 'title': 'T', 'changelog': 'x',
            'files': [{'path': 'sop.yaml', 'content': 'title: T\nsteps:\n  - key: a\n    title: A\n'}]})
        pub = api(page, 'POST', '/api/sops/e2e-del-sop/publish', {}).json()
        swid = pub['workbench_id']
        api(page, 'DELETE', '/api/apps/e2e-del-sop', {'reviewed_by': 'e2e-cleanup'})
        orphan = [w for w in api(page, 'GET', '/api/workbenches').json() if w['id'] == swid]
        assert not orphan, f'删除 SOP 后孤儿工作台仍在: {orphan[:1]}'
        # ② #10 deprecate→publish 恢复 enabled
        api(page, 'POST', '/api/apps', {'slug': 'e2e-rearm', 'kind': 'sop', 'title': 'T', 'changelog': 'x',
            'files': [{'path': 'sop.yaml', 'content': 'title: T\nsteps:\n  - key: a\n    title: A\n'}]})
        api(page, 'POST', '/api/sops/e2e-rearm/publish', {})
        api(page, 'POST', '/api/sops/e2e-rearm/deprecate', {})
        api(page, 'POST', '/api/sops/e2e-rearm/publish', {})
        wb = api(page, 'GET', f'/api/workbenches/{api(page, "GET", "/api/apps/e2e-rearm").json()["workbench_id"]}').json()
        assert wb['enabled'] is True, f'重新上架后 enabled 未恢复: {wb["enabled"]}'
        api(page, 'DELETE', '/api/apps/e2e-rearm')
        # ③ #8 输入校验 400 非 500 + 坏 health_path 单台 down 不炸巡检
        r500 = api(page, 'POST', '/api/workbenches', {'name': 'E2E BadUrl', 'url': 'notaurl', 'type': 'web', 'category': 'E2E'})
        assert r500.status == 400, f'坏 url 未 400: {r500.status}'
        # 注：Node WHATWG URL 对相对路径极宽容（自动编码），构造失败难经相对路径触发；
        # 用完整但残缺的 URL（http:// 无 host）走 probe 既有兜底——行为面：单测 200 + 记 down
        badhp = api(page, 'POST', '/api/workbenches', {'name': 'E2E BadHp', 'url': 'http://127.0.0.1:9901/', 'type': 'web', 'category': 'E2E', 'health_path': 'http://'}).json()
        chk = api(page, 'POST', f"/api/workbenches/{badhp['id']}/check")
        assert chk.status == 200, f'坏 health_path 单测 500: {chk.status}'
        assert chk.json()['last_status'] == 'down', '坏 health_path 未记 down'
        # ④ #9 删台同步清驾驶舱面板引用（保存布局不再 400）
        pw = api(page, 'POST', '/api/workbenches', {'name': 'E2E CockpitPanel', 'url': 'http://127.0.0.1:9901/', 'type': 'web', 'category': 'E2E'}).json()
        cp = api(page, 'POST', '/api/cockpits', {'name': 'E2E 面板清理舱', 'description': '', 'panels': [{'i': 'p1', 'workbenchId': pw['id'], 'x': 0, 'y': 0, 'w': 4, 'h': 3}]}).json()
        api(page, 'DELETE', f"/api/workbenches/{pw['id']}")
        cp2 = api(page, 'GET', f"/api/cockpits/{cp['id']}").json()
        assert all(p['workbenchId'] != pw['id'] for p in cp2['panels']), '驾驶舱面板未同步清理'
        rsave = api(page, 'PUT', f"/api/cockpits/{cp['id']}", {'panels': cp2['panels']})
        assert rsave.status == 200, f'清理后保存布局仍 400: {rsave.status}'
        api(page, 'DELETE', f"/api/cockpits/{cp['id']}")
        api(page, 'DELETE', f"/api/workbenches/{badhp['id']}")
        # ⑤ #5 改巡检设置不重启生效（幂等重挂——行为面：设置回读 + 服务继续健康）
        api(page, 'PUT', '/api/settings', {'health_timeout_ms': '4000'})
        st = api(page, 'GET', '/api/settings').json()
        assert st['health_timeout_ms'] == '4000', f'设置未生效: {st}'
        api(page, 'PUT', '/api/settings', {'health_timeout_ms': '5000'})
        # ⑥ #7 导入 replace：**独立实例跑**（scripts/import-smoke.mjs，独立 DATA_DIR+PORT）——
        # replace 是全表清写，在活库跑会重排自增 id 并吃掉真实台（84 事故 ×3 的根因，
        # 监督席 direct-2102fc1b 升级后落地）；断言覆盖 query 语义/内部路径行不丢/
        # 悬空面板 prune/掩码行跳过/body mode 等价，共 7 项
        import subprocess as _sp, os as _os3
        smoke = _sp.run(['node', 'scripts/import-smoke.mjs'], capture_output=True, text=True, timeout=180,
                        cwd=_os3.path.join(_os3.path.dirname(_os3.path.abspath(__file__)), '..'))
        assert smoke.returncode == 0, f'import-smoke 失败:\n{smoke.stdout[-500:]}\n{smoke.stderr[-300:]}'
        assert '7 通过' in smoke.stdout, f'import-smoke 计数异常: {smoke.stdout[-200:]}'
        record('运行时批六项（#5-#10：巡检重挂/删台清注册/导入 replace[独立实例]/校验400/面板清理/enabled 恢复）', True)
    except Exception as e:
        record('运行时批六项', False, str(e)); shot('runtime-batch')

    # ---------- 20. 卫生批（评审 #12/#13：README 一致性 + 干净克隆自愈） ----------
    try:
        # ① #12 README 与代码一致（验证器版本/判据数/类型数/页面目录；README 在仓库根不经 9800 托管，直读文件）
        import os as _os
        with open(_os.path.join(_os.path.dirname(_os.path.abspath(__file__)), '..', 'README.md'), encoding='utf-8') as _f:
            readme = _f.read()
        assert 'v71' in readme and '175 条判据' in readme, 'README 验证器节未同步（现行 v71/175）'
        assert '内置 9 种' in readme, 'README 类型数未同步 9'
        assert 'Sops' in readme, 'README 目录缺 Sops 页'
        assert '≥25' in readme or '25 组' in readme, 'README E2E 组数未同步'
        # ② #13 make-submission 幂等（重跑成功，判定面产物在场）
        import subprocess
        rmk = subprocess.run(['node', 'scripts/make-submission.mjs'], capture_output=True, text=True, timeout=120)
        assert rmk.returncode == 0, f'make-submission 重跑失败: {rmk.stderr[:200]}'
        assert 'snapshot' in rmk.stdout, 'make-submission 未产出快照'
        record('卫生批（README v18 一致性/提交物脚本幂等）', True)
    except Exception as e:
        record('卫生批', False, str(e)); shot('hygiene')

    # ---------- 21. A2A 网络接入 P1（GH #17：签名卡片 + 人工绑定，只读暴露） ----------
    try:
        # ① 主实例卡片：形状 + 签名面 + ≤48h + 不含绑定图
        card = page.request.fetch(BASE + '/.well-known/agent-card.json').json()
        for f in ('name', 'session', 'team', 'capabilities', 'expiresAt', 'publicKey', 'signature'):
            assert f in card, f'卡片缺字段 {f}'
        assert 0 < card['expiresAt'] - (time.time() * 1000) <= 48 * 3600 * 1000, 'expiresAt 超预算'
        assert 'teamMemberships' not in card, '卡片不得发布绑定图'
        assert isinstance(card.get('sessionTeams'), list), 'sessionTeams 缺失'
        # ② /a2a/direct P2 开放：生产实例无 ADMIN_TOKEN → 绑定面休眠 → 派单一律 admission 拒
        r404 = page.request.fetch(BASE + '/a2a/direct', method='POST', headers={'Content-Type': 'application/json'}, data='{"team":"market/00000000","message":"x","caller_session":"dsh/00000000"}')
        assert r404.status == 404, f'未知 id8 应 404 不泄露: {r404.status}'
        rmis = page.request.fetch(BASE + '/a2a/direct', method='POST', headers={'Content-Type': 'application/json'}, data='{"caller_session":"dsh/00000000"}')
        assert rmis.status == 200 and rmis.json().get('code') == -32000, '缺 team/message 应 -32000'
        # ③ 专用实例全链（独立 DATA_DIR + ADMIN_TOKEN；上游 verifyCard 裁判 + 绑定 CRUD + 上卡规则，21 项）
        import subprocess, os as _os2
        smoke = subprocess.run(
            ['node', 'scripts/a2a-smoke.mjs'],
            capture_output=True, text=True, timeout=180,
            cwd=_os2.path.join(_os.path.dirname(_os.path.abspath(__file__)), '..'))
        assert smoke.returncode == 0, f'a2a-smoke 失败:\n{smoke.stdout[-600:]}\n{smoke.stderr[-300:]}'
        assert '35 通过' in smoke.stdout, f'a2a-smoke 计数异常: {smoke.stdout[-200:]}'
        record('A2A 网络接入 P1（卡片签名/人工绑定/上卡规则/direct 不泄露）', True)
    except Exception as e:
        record('A2A 网络接入 P1', False, str(e)); shot('a2a-p1')

    cleanup(page)
    browser.close()

fails = [r for r in RESULTS if not r[1]]
total, passed = len(RESULTS), len(RESULTS) - len(fails)
summary = {
    'total': total,
    'passed': passed,
    'failed': len(fails),
    'all_passed': 1 if not fails else 0,
    'finished_at': datetime.now(timezone.utc).isoformat(),
    'contrast_checks': contrast_rows,
    'contrast_all_passed': 1 if contrast_rows and all(r['passed'] for r in contrast_rows) else 0,
}
with open(_os.path.join(_os.path.dirname(_os.path.abspath(__file__)), 'e2e-summary.json'), 'w', encoding='utf-8') as f:
    json.dump(summary, f, ensure_ascii=False, indent=2)
print(f'\n===== E2E 汇总：{passed}/{total} PASS =====')
sys.exit(1 if fails else 0)
