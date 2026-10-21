"""workbench-market E2E 全流程自动化测试（Playwright，对 9800 已构建产物）

覆盖：仪表盘 / 市场 CRUD+校验+过滤+检测+抽屉+开关+编辑+复制+删除 / 使用页 / 类型管理增删+引用保护 / 设置保存+导出下载
要点：ModalForm 提交按钮是 type=button（pro-components 实现），统一用 .ant-modal-footer .ant-btn-primary；
     antd Select(tags) 不用 placeholder.fill，改为点击后键盘输入+Enter。
失败自动截图 evidence/fail-*.png；exit code 非 0 表示有失败。
"""
import json
import sys
from datetime import datetime, timezone
from playwright.sync_api import sync_playwright, expect

BASE = 'http://127.0.0.1:9800'
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
                api(page, 'DELETE', f"/api/apps/{a['slug']}")
            except Exception:
                pass


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

    cleanup(page)

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
    page.goto(BASE + '/market')
    page.wait_for_load_state('networkidle')
    page.wait_for_timeout(800)

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
    CONTRAST_TARGETS = [
        ('/ 使用页·状态文字（用户报告的 XPath）', '/use/1', '.wm-use-bar .ant-badge-status-text', 4.5),
        ('/ 使用页·标题', '/use/1', '.wm-use-bar .wm-use-title', 4.5),
        ('/ 使用页·地址文字', '/use/1', '.wm-use-bar .wm-mono', 4.5),
        ('/ 使用页·顶栏按钮', '/use/1', '.wm-use-bar .ant-btn', 4.5),
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
        body_txt = frame.evaluate('el => el.contentDocument && el.contentDocument.body ? el.contentDocument.body.innerText : ""')
        assert 'E2E-APP-V1' in body_txt, '门户重写后 iframe 内容不可达'
        # 重发 v2 → 静态切换；activate 回 v1 → 回滚
        api(page, 'POST', '/api/apps', {'slug': 'e2e-app', 'title': 'E2E 自产台',
            'files': [{'path': 'index.html', 'content': '<!doctype html><meta charset="utf-8"><h1>E2E-APP-V2</h1>'}]})
        assert 'E2E-APP-V2' in page.request.fetch(BASE + '/apps/e2e-app/').text(), 'v2 未生效'
        api(page, 'POST', '/api/apps/e2e-app/activate', {'version': 1})
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
        s = sk.create_connection(('127.0.0.1', 9800), timeout=5)
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
        record('统一门户透传+凭据注入+WS 升级（echo fixture 九断言）', True)
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
            r = page.request.fetch(BASE + '/mcp', method='POST',
                headers={'Content-Type': 'application/json'},
                data=json.dumps(body))
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
        assert len(tool_names) == 7 and 'app_publish' in tool_names and 'sop_publish' in tool_names, f'tools/list 异常: {tool_names}'
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
        # 清理（走 REST）
        api(page, 'DELETE', '/api/apps/e2e-mcp-app'); api(page, 'DELETE', '/api/apps/e2e-mcp-sop')
        record('MCP 生产通道（协议面 + 7 tools 生产链）', True)
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
        demo = page.locator('.ant-table-row').filter(has_text='demo-rack-sop')
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
with open(__file__.replace('e2e_test.py', 'e2e-summary.json'), 'w', encoding='utf-8') as f:
    json.dump(summary, f, ensure_ascii=False, indent=2)
print(f'\n===== E2E 汇总：{passed}/{total} PASS =====')
sys.exit(1 if fails else 0)
