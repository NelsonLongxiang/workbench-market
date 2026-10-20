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
