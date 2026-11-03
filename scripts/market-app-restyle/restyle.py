"""自产台统一层（DESIGN.md v1.0.0 + PATTERNS.md §7）：色值/字体/字号/圆角映射到 token，深色台转浅色，
注入 --wm-* 变量、基础排版、wm-ux.js（菜单/焦点/状态持久化）与 wm-nav.js（菜单/目录/视图外壳）。
用法（现行）: python3 -I restyle.py <web/src/tokens.css> --repo <workbench-market-apps 检出目录> [--only slug1,slug2]
  就地改写仓库里每台目录下的 .html/.css/.js；已统一过的页面只换 <head> 统一层（换层），新页面走全套转换；
  SOP 台（含 sop.yaml）与数据文件不动。改完在 apps 仓库里看 git diff、提 PR、合 main，再 app_sync 上线。
用法（本地预览）: python3 -I restyle.py <tokens.css> <apps_dir> <extra_dir> <out_dir>
  apps_dir/<slug>.html 为台首页（可带服务端注入的令牌段，会被剥掉）；extra_dir/<slug>/<path> 为附属文件；产物写到 out_dir/<slug>/<path>"""
import colorsys, json, re, sys
from pathlib import Path

def rd(p):  # 原样读写：不做换行转换（Windows 下 read_text/write_text 会改 \r\n）
    with open(p, encoding='utf-8', newline='') as f: return f.read()

def wr(p, s):
    with open(p, 'w', encoding='utf-8', newline='') as f: f.write(s)

T = {  # token 名 -> 值（与 web/src/tokens.css 一致）
    'primary': '#1E3A5F', 'primary-subtle': '#EEF2F7', 'on-primary': '#FFFFFF',
    'text': '#0F172A', 'text-secondary': '#5A6577',
    'page': '#F6F7F9', 'surface': '#FFFFFF', 'border': '#E2E8F0', 'border-strong': '#CBD5E1',
    'success': '#047857', 'success-bg': '#ECFDF5', 'warning': '#F59E0B', 'warning-text': '#B45309',
    'nav-bg': '#0F172A', 'nav-text': '#CBD5E1', 'nav-text-active': '#FFFFFF',
    'warning-bg': '#FFFBEB', 'danger': '#DC2626', 'danger-text': '#B91C1C', 'danger-bg': '#FEF2F2',
}
TOKEN_HEX = {v.upper() for v in T.values()}

# 深色台（规范只做浅色）
DARK = {'finance-workbench', 'logistics-owba-board', 'preset-ops', 'procurement-workbench'}
# 每台品牌色/特殊色的人工裁定（hex 大写 -> token 名）
OVERRIDE = {
    'dev-collab-board': {'#2F6F4F': 'primary', '#EEF4F0': 'primary-subtle', '#15803D': 'success'},
    'multi-platform-sop-workbench': {'#164B3E': 'primary', '#E2EEE7': 'primary-subtle', '#315D7B': 'primary', '#E7EFF4': 'primary-subtle'},
    'multi-platform-product-catalog': {'#174B3D': 'primary'},
    'multi-platform-t101208-evidence': {'#E3EDE4': 'primary-subtle'},
    'zcode-cockpit': {'#059669': 'success', '#334155': 'text-secondary'},
    'yuanguang-crm-budget': {'#B45309': 'primary'},
    'finance-workbench': {'#FFFFFF': 'on-primary', '#2A6DF0': 'primary', '#3DD68C': 'success'},
}

def rgb(h):
    h = h.lstrip('#')
    if len(h) == 3: h = ''.join(c * 2 for c in h)
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))

def lum(c):
    f = lambda x: x / 12.92 if x <= 0.03928 else ((x + 0.055) / 1.055) ** 2.4
    r, g, b = map(f, c)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b

def family(c):
    hue, _, _ = colorsys.rgb_to_hls(*c); hue *= 360
    if 75 <= hue < 170: return 'success'
    if hue < 15 or hue >= 340: return 'danger'
    if hue < 75: return 'warning'
    return 'primary'

def classify(h, dark, ov):
    H = '#' + h.lstrip('#').upper()
    if len(H) == 4: H = '#' + ''.join(c * 2 for c in H[1:])
    if H in ov: return ov[H]
    if H == '#F59E0B': return 'warning-text'  # 琥珀主值不写字，统一走 warning-text
    if H == '#DC2626': return 'danger-text'  # danger 主值写字不足 4.5:1（浅底标签上），统一走 danger-text
    if H in TOKEN_HEX and not dark:  # 深色台里同值语义相反，不按字面认
        return next(k for k, v in T.items() if v.upper() == H and not k.startswith('nav-'))
    c = rgb(H); Y = lum(c); chroma = max(c) - min(c)
    sat = colorsys.rgb_to_hls(*c)[2]
    tinted = Y > 0.75 and chroma >= 0.045 and sat >= 0.25  # 浅色带色底（状态条/标签底）
    grey = (chroma < 0.12 and not tinted) or sat < 0.25 or (not dark and Y < 0.05 and chroma < 0.35)
    if grey:
        if dark:
            if Y < 0.004: return 'page'
            if Y < 0.025: return 'surface'
            if Y < 0.12: return 'border'
            if Y < 0.45: return 'text-secondary'
            return 'text'
        if Y >= 0.99: return 'surface'
        if Y >= 0.90: return 'page'
        if Y >= 0.80: return 'border'
        if Y >= 0.55: return 'border-strong'
        if Y >= 0.04: return 'text-secondary'
        return 'text'
    fam = family(c)
    light_bg = Y < 0.07 if dark else Y > 0.75
    if light_bg: return 'primary-subtle' if fam == 'primary' else fam + '-bg'
    return {'primary': 'primary', 'success': 'success', 'warning': 'warning-text', 'danger': 'danger-text'}[fam]

RGB = re.compile(r'rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(1|1\.0+)\s*)?\)')
HEX = re.compile(r'(?<![\w&])#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![\w-])')
def snap(px):
    """字号吸附到 DESIGN.md 六档 12/14/16/20/24（≥18 平局取大，标题倾向上一档）"""
    if px >= 24: return 24
    return min((12, 14, 16, 20, 24), key=lambda g: (abs(g - px), -g if px >= 18 else g))

FS_MAP = {8: 12, 9: 12, 10: 12, 11: 12, 13: 12, 15: 14, 17: 16, 18: 20, 19: 20, 21: 20, 22: 20, 23: 24, 25: 24, 26: 24, 28: 24, 29: 24, 30: 24, 32: 24, 34: 24, 36: 24}
RADIUS_MAP = {2: 4, 3: 4, 5: 6, 7: 6, 10: 8, 12: 8, 14: 8, 16: 8, 18: 8, 20: 8}
FONT_DECL = re.compile(r'font-family:\s*((?:"[^"]*"|&#?\w+;|[^;}"\n])+)')
INJECT = re.compile(r'<meta name="wm-app-token"[^>]*><script>window\.WM_APP_TOKEN=[^<]*</script>')
STYLE = re.compile(r'(<style[^>]*>)(.*?)(</style>)', re.S)

def nav_bands(css, dark, ov):
    """浅色台里背景近黑的条带（顶栏/页头）= 规范里唯一允许的深色区：底用 nav-bg，字用 nav-text(-active)"""
    if dark: return css
    RULE = re.compile(r'([^{}@]+)\{([^{}]*)\}')
    scopes = []
    for m in RULE.finditer(css):
        bg = re.search(r'background(?:-color)?:\s*(#[0-9a-fA-F]{3,6})\b', m.group(2))
        if bg and classify(bg.group(1), False, ov) == 'text':
            scopes += [x.strip() for x in m.group(1).split(',') if x.strip()]
    if not scopes: return css
    def in_scope(sel):
        return any(x.strip() == sc or x.strip().startswith(sc + ' ') or x.strip().startswith(sc + '>') for x in sel.split(',') for sc in scopes)
    def nav_color(h):
        c = rgb(h); return 'nav-text-active' if lum(c) > 0.55 or (max(c) - min(c)) > 0.25 else 'nav-text'
    def fix(m):
        sel, body = m.group(1), m.group(2)
        if not in_scope(sel): return m.group(0)
        body = re.sub(r'(background(?:-color)?:\s*)#[0-9a-fA-F]{3,6}\b', r'\1var(--wm-color-nav-bg)', body)
        body = re.sub(r'((?<![-\w])color:\s*)(#[0-9a-fA-F]{3,6})\b', lambda c: c.group(1) + 'var(--wm-color-' + nav_color(c.group(2)) + ')', body)
        body = re.sub(r'((?<![-\w])color:\s*)var\(--(card|surface|paper|bg|white)\)', r'\1var(--wm-color-nav-text-active)', body)
        return sel + '{' + body + '}'
    return RULE.sub(fix, css)

def strip_dark(css):
    """去掉 @media (prefers-color-scheme: dark){…}（规范只做浅色）"""
    out, i = [], 0
    for m in re.finditer(r'@media[^{]*prefers-color-scheme\s*:\s*dark[^{]*\{', css):
        if m.start() < i: continue
        depth, j = 1, m.end()
        while j < len(css) and depth:
            depth += {'{': 1, '}': -1}.get(css[j], 0); j += 1
        out.append(css[i:m.start()]); i = j
    return ''.join(out) + css[i:]

def rgba_fix(css, dark):
    if not dark: return css
    # 深色主题里的白色叠层/描边在浅色底上改为深色同透明度
    return re.sub(r'rgba\(\s*255\s*,\s*255\s*,\s*255\s*,', 'rgba(15, 23, 42,', css)

PATCH = {  # 每台的定点修正（规范：primary 按钮实心、不用渐变；深色只留给导航条）
    'zcode-cockpit': [('.top .sub{color:#94A3B8', '.top .sub{color:var(--wm-color-nav-text)')],
    'finance-workbench': [("var _TRUSTED_ORIGIN='http://192.168.3.156:9800';", 'var _TRUSTED_ORIGIN=location.origin;'),  # 属主 11-02 已批（v84 条目）
                          ('background:linear-gradient(90deg,var(--c-cta-from),var(--c-cta-to))', 'background:var(--wm-color-primary)')],
}
UX_CSS = (
    # 菜单：统一选中/悬停态，不动台内布局
    '.wm-menu-item{transition:background-color var(--wm-motion-fast) var(--wm-motion-easing),color var(--wm-motion-fast) var(--wm-motion-easing)}\n'
    '.wm-menu-item:hover{color:var(--wm-color-text)}\n'
    '.wm-menu-item[aria-selected=true],.wm-menu-item[aria-pressed=true]{color:var(--wm-color-primary)!important;font-weight:600}\n'
    '.wm-menu-item[aria-selected=true] *,.wm-menu-item[aria-pressed=true] *{color:inherit!important}\n'
    '.wm-menu-item[aria-selected=true]:not(a):not(nav a),.wm-menu-item[aria-pressed=true]{background-color:var(--wm-color-primary-subtle)!important;border-color:var(--wm-color-primary)!important}\n'
    # 焦点：任何台内 outline:none 都压不掉键盘焦点环
    ':focus-visible{outline:2px solid var(--wm-color-primary)!important;outline-offset:2px!important}\n'
    'input:focus-visible,select:focus-visible,textarea:focus-visible{outline-offset:0!important;border-color:var(--wm-color-primary)!important}\n'
    '[role=button][tabindex],[role=link][tabindex]{cursor:pointer}\n'
)
# 菜单 / 目录 / 视图（PATTERNS.md §7.4）：按台配置区块分组；区块按 h2 标题前缀匹配
NAV = {
    'finance-workbench': {'title': '财务月度交付驾驶舱', 'groups': [
        {'key': 'overview', 'label': '总览', 'sections': ['双栏时钟卡', 'KPI 条', '财务行动看板']},
        {'key': 'delivery', 'label': '交付', 'sections': ['11 件交付清单', '交付空间']},
        {'key': 'submit', 'label': '提交', 'sections': ['数据包提交', '任务数据提交']},
        {'key': 'tasks', 'label': '任务', 'sections': ['JF十月执行任务']},
    ],
        # 只给业务看（属主 11-03）：验证器、运维台账、表单自查、task list 属工程/agent 面，整块不显示
        'hideSections': ['表单异常项评审', '在途任务表', '四族验证器状态', 'A 族 spec 明细', '台账近 8 条'],
        'hideNodes': ['只读状态面', '浏览器直连环境警示', '登记口径：', '按 SOP→年→月 组织',
                      '数据源=task list', 'commitment_clock', '若本数据已过验证器', '已读取',
                      '默认聚焦重点业务件', '当前月份：', '全量保留原登记', '来源与登记说明'],
        'keepNodes': ['口径图例'],
        # 保留区块里的工程字段（属主 11-03「去掉」）
        'hideColumns': ['任务锚'],
        'hideFields': ['验证器关联', '验收证', '责任会话'],
        'scrub': ['（评审席[^）]*）', '\\s*direct-[0-9a-f]{8}', '表单 v\\d+ · ',
                  # 交付空间：标签说明与文件元信息
                  '（全部登记(?:附件引用)?）', '（依登记名；不代表采用）',
                  '\\s*·\\s*附件备注(?:标注)?归属月(?:份)?：[0-9-]+', '\\s*·\\s*关联记录：[0-9、，, ]+', '\\s*·\\s*同一文件跨月引用'],
        # 交付空间：单列文件清单 + 紧凑吸顶筛选栏（修 .frow 6 列模板配 5 个子元素导致文件名只剩 38px）
        'css': (
            '.ds-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px 24px;padding:8px 16px;margin:12px 0;background:var(--wm-color-surface);border:1px solid var(--wm-color-border);border-radius:8px;box-shadow:var(--wm-shadow-1)}'
            '@media (min-width:1024px){.ds-toolbar{position:sticky;top:56px;z-index:5}}'
            '.ds-toolbar>div{display:flex;align-items:center;gap:8px;margin:0}'
            '.ds-toolbar .tlabel{margin:0;font-size:12px;line-height:20px;font-weight:600;color:var(--wm-color-text-secondary)}'
            '.ds-toolbar .segbar{display:inline-flex;flex-wrap:wrap;gap:2px;padding:2px;background:var(--wm-color-page);border:1px solid var(--wm-color-border);border-radius:6px}'
            '.ds-toolbar .segbar .seg.seg{height:28px;min-height:0;margin:0;padding:0 10px;border:0!important;border-radius:4px;background:none!important;color:var(--wm-color-text-secondary)!important;font-size:12px;line-height:28px;font-weight:400;box-shadow:none}'
            '.ds-toolbar .segbar .seg.seg:hover{color:var(--wm-color-text)!important}'
            '.ds-toolbar .segbar .seg.seg[aria-pressed=true]{background:var(--wm-color-surface)!important;color:var(--wm-color-text)!important;font-weight:600;box-shadow:var(--wm-shadow-1)}'
            '.ds-toolbar .seg .ct{margin-left:6px;padding:0;background:none;color:var(--wm-color-text-secondary);font-size:12px;font-weight:400}'
            '#dsGrid{display:block}'
            '#dsGrid .ds-section-label{display:flex;align-items:center;gap:8px;margin:16px 0 8px;font-size:16px;line-height:24px;font-weight:600;color:var(--wm-color-text)}'
            '#dsGrid .ds-section-label .ct{font-size:12px;font-weight:400;color:var(--wm-color-text-secondary);background:var(--wm-color-page);border-radius:4px;padding:0 8px}'
            '#dsGrid .ds-subgrid{display:grid;grid-template-columns:1fr!important;gap:12px}'
            '#dsGrid .dcard{padding:0;overflow:hidden;background:var(--wm-color-surface);border:1px solid var(--wm-color-border);border-radius:8px;box-shadow:var(--wm-shadow-1)}'
            '#dsGrid .dcard-hd{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0;padding:12px 16px;border-bottom:1px solid var(--wm-color-border)}'
            '#dsGrid .dcard-hd .ti{font-size:16px;line-height:24px;font-weight:600;color:var(--wm-color-text)}'
            '#dsGrid .dcard-hd .meta{margin-left:auto;font-size:12px;line-height:20px;color:var(--wm-color-text-secondary)}'
            '#dsGrid .dcard-note{padding:8px 16px 0}'
            '#dsGrid .frow{display:flex;align-items:center;gap:16px;margin:0;padding:10px 16px;border-bottom:1px solid var(--wm-color-border)}'
            '#dsGrid .frow:last-child{border-bottom:0}'
            '#dsGrid .frow:hover{background:var(--wm-color-page)}'
            '#dsGrid .frow .ftype{flex:none;width:44px;text-align:center}'
            '#dsGrid .frow .fname{flex:1;min-width:0;white-space:normal;overflow:visible;text-overflow:clip;overflow-wrap:anywhere;font-size:14px;line-height:22px;color:var(--wm-color-text)}'
            '#dsGrid .frow .month-meta{display:block;margin-top:2px;font-size:12px;line-height:20px;color:var(--wm-color-text-secondary)}'
            '#dsGrid .frow .fsize{flex:none;width:72px;text-align:right;font-size:12px;color:var(--wm-color-text-secondary)}'
            '#dsGrid .frow .ftime{flex:none;width:128px;font-size:12px;color:var(--wm-color-text-secondary)}'
            '#dsGrid .frow .badge,#dsGrid .frow .dl{flex:none}'
            '#dsGrid details.ds-aux{margin-top:16px;padding:0;background:var(--wm-color-surface);border:1px solid var(--wm-color-border);border-radius:8px}'
            '#dsGrid details.ds-aux>summary{padding:12px 16px;font-size:14px;font-weight:600;color:var(--wm-color-text)}'
            '#dsGrid details.ds-aux[open]>summary{border-bottom:1px solid var(--wm-color-border)}'
            '#dsGrid details.ds-aux>*:not(summary){margin:12px 16px}'
            '@media (max-width:720px){#dsGrid .frow{flex-wrap:wrap;gap:8px}#dsGrid .frow .fname{flex-basis:calc(100% - 60px)}#dsGrid .frow .ftime{width:auto}}'
        ),
        # 最新月份还没有核心业务件时，打开就落到最近一个有成品的月份
        'fallback': {'probe': '#dsCount', 'when': '核心业务件 0；', 'click': '#segMonth .seg'},
    },
}
NAV_CSS = (
    'html.wm-has-nav{scroll-padding-top:64px}\n'
    'html.wm-has-nav body{padding-top:72px!important}\n'
    '@media (min-width:1024px){html.wm-has-nav body{padding-left:244px!important}}\n'
    '.wm-off,.wm-hide{display:none!important}\n'
    '.wm-nav-bar{position:fixed;top:0;left:0;right:0;z-index:1000;height:48px;box-sizing:border-box;display:flex;align-items:center;gap:16px;padding:0 16px;'
    'background:var(--wm-color-surface);border-bottom:1px solid var(--wm-color-border);box-shadow:var(--wm-shadow-1);font-family:var(--wm-font-sans);font-size:14px;line-height:22px}\n'
    '.wm-nav-home{color:var(--wm-color-text-secondary);text-decoration:none;font-size:12px;line-height:20px;white-space:nowrap}\n'
    '.wm-nav-home:hover{color:var(--wm-color-primary)}\n'
    '.wm-nav-title{font-size:16px;line-height:24px;font-weight:600;color:var(--wm-color-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:240px}\n'
    '.wm-nav-menu{display:flex;gap:4px;flex:1;min-width:0;overflow-x:auto;scrollbar-width:none}\n'
    '.wm-nav-menu-item,.wm-nav-view,.wm-nav-tocbtn{font:inherit;cursor:pointer;white-space:nowrap}\n'
    '.wm-nav-menu-item{height:32px;padding:0 12px;border:0;border-radius:6px;background:none;color:var(--wm-color-text-secondary)}\n'
    '.wm-nav-menu-item:hover{background:var(--wm-color-page);color:var(--wm-color-text)}\n'
    '.wm-nav-menu-item[aria-selected=true]{background:var(--wm-color-primary-subtle);color:var(--wm-color-primary);font-weight:600}\n'
    '.wm-nav-views{display:inline-flex;flex:none;padding:2px;border-radius:6px;background:var(--wm-color-page);border:1px solid var(--wm-color-border)}\n'
    '.wm-nav-view{height:26px;padding:0 12px;border:0;border-radius:4px;background:none;color:var(--wm-color-text-secondary);font-size:12px}\n'
    '.wm-nav-view[aria-checked=true]{background:var(--wm-color-surface);color:var(--wm-color-text);font-weight:600;box-shadow:var(--wm-shadow-1)}\n'
    '.wm-nav-tocbtn{display:none;height:32px;padding:0 12px;border:1px solid var(--wm-color-border-strong);border-radius:6px;background:var(--wm-color-surface);color:var(--wm-color-text)}\n'
    '.wm-nav-toc{position:fixed;top:48px;left:0;bottom:0;z-index:999;width:220px;box-sizing:border-box;overflow-y:auto;padding:16px 8px 24px;'
    'background:var(--wm-color-surface);border-right:1px solid var(--wm-color-border);font-family:var(--wm-font-sans);font-size:14px;line-height:22px}\n'
    '.wm-nav-toc-title{padding:4px 12px;font-size:12px;line-height:20px;font-weight:600;color:var(--wm-color-text-secondary)}\n'
    '.wm-nav-toc-group+.wm-nav-toc-group{margin-top:12px}\n'
    '.wm-nav-toc ul{list-style:none;margin:0;padding:0}\n'
    '.wm-nav-toc a{display:block;padding:4px 12px 4px 10px;border-left:2px solid transparent;border-radius:0 6px 6px 0;color:var(--wm-color-text);text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n'
    '.wm-nav-toc a:hover{background:var(--wm-color-page)}\n'
    '.wm-nav-toc-group:not(.wm-current) a{color:var(--wm-color-text-secondary)}\n'
    '.wm-nav-toc a[aria-current]{border-left-color:var(--wm-color-primary);background:var(--wm-color-primary-subtle);color:var(--wm-color-primary)!important;font-weight:600}\n'
    '.wm-nav-scrim{position:fixed;top:48px;left:0;right:0;bottom:0;z-index:998;background:rgba(15,23,42,.32)}\n'
    '@media (max-width:1023px){.wm-nav-tocbtn{display:inline-flex;align-items:center}.wm-nav-home{display:none}'
    '.wm-nav-toc{width:280px;max-width:85vw;transform:translateX(-100%);box-shadow:var(--wm-shadow-3);transition:transform var(--wm-motion-base) var(--wm-motion-easing)}.wm-nav-toc.wm-open{transform:none}}\n'
    '@media (max-width:640px){.wm-nav-bar{gap:8px;padding:0 8px}.wm-nav-title{display:none}}\n'
    '@media print{.wm-nav-bar,.wm-nav-toc,.wm-nav-scrim{display:none!important}html.wm-has-nav body{padding:24px!important}.wm-off{display:block!important}.wm-hide{display:none!important}}\n'
)

# 换行容 \r\n：有的台在 Windows 上另存过，整页（含统一层）都是 CRLF；认不出旧层会叠出第二层
LAYER_RE = re.compile(r'\r?\n<style id="wm-design-layer">.*?</style>\r?\n<script id="wm-ux">.*?</script>\r?\n(?:<script id="wm-nav">.*?</script>\r?\n)?', re.S)

def build_layer(slug, tokens_css):
    return ('<style id="wm-design-layer">\n/* 工作台统一设计层 · DESIGN.md v1.0.0（仅浅色）。台内样式只引用 --wm-* 变量 */\n'
             + tokens_css.split('*/', 1)[1].strip() + '\n'
             'html{color-scheme:light}\n'
             'body{font-family:var(--wm-font-sans);font-size:var(--wm-font-size-body);line-height:var(--wm-line-height-body);'
             'color:var(--wm-color-text);background:var(--wm-color-page);-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}\n'
             'code,pre,kbd,samp{font-family:var(--wm-font-mono)}\n'
             'button,input,select,textarea{font:inherit;font-size:var(--wm-font-size-body)}\n'
             'h1{font-size:var(--wm-font-size-title);line-height:var(--wm-line-height-title);font-weight:600}\n'
             'h2{font-size:var(--wm-font-size-subtitle);line-height:var(--wm-line-height-subtitle);font-weight:600}\n'
             'h3,h4,h5,h6{font-size:var(--wm-font-size-body);line-height:var(--wm-line-height-body);font-weight:600}\n'
             'small{font-size:var(--wm-font-size-caption);line-height:var(--wm-line-height-caption)}\n'
             'a{color:var(--wm-color-primary)}\n'
             '::selection{background:var(--wm-color-primary-subtle);color:var(--wm-color-text)}\n'
             + UX_CSS +
             'input::placeholder,textarea::placeholder{color:var(--wm-color-text-disabled)}\n'
             '@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}\n'
             + (NAV_CSS if slug in NAV else '') + (NAV.get(slug, {}).get('css', '') + '\n' if slug in NAV else '') +
             '</style>\n<script id="wm-ux">' + UX_JS + '</script>\n'
             + (('<script id="wm-nav">window.WM_NAV=' + json.dumps({k: v for k, v in NAV[slug].items() if k != 'css'}, ensure_ascii=False) + ';' + NAV_JS + '</script>\n') if slug in NAV else ''))

def transform(src, slug, tokens_css, kind='html'):
    dark, ov = slug in DARK, OVERRIDE.get(slug, {})
    stats = {'colors': {}, 'font_size': 0, 'font_family': 0, 'radius': 0}
    s = INJECT.sub('', src)
    # 换层：已经统一过的页面只替换 <head> 里的统一层，正文不再转换（深色台二次映射会把语义反过来）
    if kind == 'html' and LAYER_RE.search(s):
        def relayer(m):
            layer = '\n' + build_layer(slug, tokens_css)
            return layer.replace('\n', '\r\n') if m.group(0).startswith('\r\n') else layer  # 保持该页原有换行风格
        return LAYER_RE.sub(relayer, s, count=1), stats
    if kind != 'html' and 'var(--wm-' in s:
        return s, stats
    for a, b in PATCH.get(slug, []): s = s.replace(a, b)
    s = re.sub(r'https?://192\.168\.3\.156:9800(?=/)', '', s)
    s = re.sub(r"(new URL\([^,()]+(?:\([^()]*\))?,\s*)'https?://192\.168\.3\.156:9800/?'", r'\1location.origin', s)
    s = RGB.sub(lambda m: '#%02X%02X%02X' % tuple(min(255, int(x)) for x in m.groups()[:3]), s)

    def color_sub(in_css):
        def f(m):
            role = classify(m.group(1), dark, ov)
            stats['colors'][m.group(0).upper()] = role
            return f'var(--wm-color-{role})' if in_css else T[role]
        return f

    def fs(m):
        n = float(m.group(1)); k = snap(n)
        if k == n: return m.group(0)
        stats['font_size'] += 1
        return f'{m.group(0)[:m.group(0).index(m.group(1))]}{k}px'

    def ff(m):
        stats['font_family'] += 1
        v = m.group(1).lower()
        if 'var(--wm-' in v or v.strip() in ('inherit', 'initial', 'unset'): return m.group(0)
        mono = any(k in v for k in ('mono', 'consolas', 'code', 'courier', 'menlo'))
        return 'font-family:var(--wm-font-mono)' if mono else 'font-family:var(--wm-font-sans)'

    def rad(m):
        n = int(m.group(1)); k = RADIUS_MAP.get(n)
        if k is None: return m.group(0)
        stats['radius'] += 1
        return f'border-radius:{k}px'

    def fs_rem(m):
        stats['font_size'] += 1
        return f'font-size:{snap(float(m.group(1)) * 16)}px'

    def fs_em(m):
        stats['font_size'] += 1
        return f'font-size:{snap(float(m.group(1)) * 14)}px'

    def font_short(f):
        """font 简写：字号吸附、字体族换 token（clamp 大标题 → display 24/32）"""
        stats['font_size'] += 1
        size, lh, fam = f.group(2), f.group(3) or '', f.group(4)
        if size.startswith('clamp'): px, lh = 24, '/32px'
        else:
            n = float(re.match(r'[\d.]+', size).group(0)); unit = size.lstrip('0123456789.')
            px = snap(n * (16 if unit == 'rem' else 14 if unit == 'em' else 1))
        mono = any(k in fam.lower() for k in ('mono', 'consolas', 'code', 'courier', 'menlo'))
        keep = fam.strip() in ('inherit',) or 'var(--' in fam
        return f"font:{f.group(1)}{px}px{lh} " + (fam if keep else ('var(--wm-font-mono)' if mono else 'var(--wm-font-sans)'))

    def common(x, in_css=False):
        x = re.sub(r'font-size:\s*(\d*\.?\d+)rem', fs_rem, x)
        x = re.sub(r'font-size:\s*(\d*\.?\d+)em', fs_em, x)
        fam = r'((?:&#?\w+;|[^;}\n])+)' if in_css else r'((?:&#?\w+;|[^;}"\n])+)'  # CSS 里字体族可带双引号；内联属性里不能越过属性引号
        x = re.sub(r'(?<![-\w])font:\s*((?:(?:italic|bold|normal|\d00)\s+)*)(clamp\([^)]*\)|\d*\.?\d+(?:px|rem|em))(/[\w.%]+)?\s+' + fam, font_short, x)
        x = re.sub(r'(background(?:-color)?:\s*)(#E2E8F0|#CBD5E1)\b', r'\1#F6F7F9', x)
        x = re.sub(r'font-size:\s*(\d+(?:\.\d+)?)px', fs, x)
        x = re.sub(r'border-radius:\s*(\d+)px(?=\s*[;}"\'!])', rad, x)
        return x

    # <style> 内：用 var()
    def style_block(m):
        css = nav_bands(strip_dark(m.group(2)), dark, ov)
        # 渐变压成首个色标的实色（规范：按钮/横幅不用渐变）
        css = re.sub(r'background(-image)?:\s*linear-gradient\(\s*(?:[\d.]+deg\s*,\s*|to [a-z ]+,\s*)?([^,()]+(?:\([^)]*\))?)[^;}]*\)', lambda g: 'background:' + g.group(2).strip().split(' ')[0], css)
        css = re.sub(r'--font(?:-body)?:\s*[^;}]+', '--font:var(--wm-font-sans)', css)
        css = re.sub(r'--font-mono:\s*[^;}]+', '--font-mono:var(--wm-font-mono)', css)
        css = re.sub(r'--mono:\s*[^;}]+', '--mono:var(--wm-font-mono)', css)
        css = re.sub(r'--radius:\s*\d+px', '--radius:8px', css)
        css = FONT_DECL.sub(ff, css)
        css = HEX.sub(color_sub(True), css)
        css = rgba_fix(css, dark)
        css = re.sub(r'(background(?:-color)?:\s*)var\(--wm-color-border(?:-strong)?\)', r'\1var(--wm-color-page)', css)
        css = re.sub(r'(--([\w-]+):\s*)var\(--wm-color-border(?:-strong)?\)', lambda v: v.group(0) if re.search(r'line|border|rule|sep|stroke|bd|edge|grid', v.group(2)) else v.group(1) + 'var(--wm-color-page)', css)
        # 实心底（主色/状态色）上的深色字 → on-primary
        def solid(r):
            b = r.group(2)
            if re.search(r'background(?:-color)?:\s*var\(--wm-color-(primary|success|danger-text|warning-text|danger)\)', b):
                b = re.sub(r'((?<![-\w])color:\s*)var\(--wm-color-(text|text-secondary|page|surface-?\w*)\)', r'\1var(--wm-color-on-primary)', b)
            return r.group(1) + '{' + b + '}'
        css = re.sub(r'([^{}@]+)\{([^{}]*)\}', solid, css)
        # 线色变量被当成文字容器（带 padding 的徽标/标签）的底色 → page，避免灰底压次级字
        linevars = {v.group(1) for v in re.finditer(r'(--[\w-]+):\s*var\(--wm-color-border(?:-strong)?\)', css)}
        if linevars:
            css = re.sub(r'([^{}@]+)\{([^{}]*padding[^{}]*)\}', lambda r: r.group(1) + '{' + re.sub(r'(background(?:-color)?:\s*)var\((' + '|'.join(map(re.escape, linevars)) + r')\)', r'\1var(--wm-color-page)', r.group(2)) + '}', css)
        return m.group(1) + common(css, True) + m.group(3)
    if kind == 'css':
        return style_block(re.match(r'()(.*)()', s, re.S)), stats
    parts, last = [], 0
    for m in STYLE.finditer(s):
        out = s[last:m.start()]
        out = HEX.sub(color_sub(False), out)  # 内联/脚本：写字面值（canvas/SVG 属性不认 var）
        out = re.sub(r"font-family:\s*(?:&#?\w+;|[^;\"'}])+", lambda mm: ff(re.match(r'font-family:\s*(.*)', mm.group(0))), out)
        parts.append(common(rgba_fix(out, dark))); parts.append(style_block(m)); last = m.end()
    tail = HEX.sub(color_sub(False), s[last:])
    tail = re.sub(r"font-family:\s*(?:&#?\w+;|[^;\"'}])+", lambda mm: ff(re.match(r'font-family:\s*(.*)', mm.group(0))), tail)
    parts.append(common(rgba_fix(tail, dark)))
    s = ''.join(parts)
    if kind != 'html': return s, stats

    layer = build_layer(slug, tokens_css)
    m = re.search(r'<head[^>]*>', s, re.I)
    # 插在 <head> 起始：台内已映射的规则仍可覆盖基础排版
    s = s[:m.end()] + '\n' + layer + s[m.end():] if m else layer + s
    return s, stats

UX_JS = rd(Path(__file__).parent / 'wm-ux.js')
NAV_JS = rd(Path(__file__).parent / 'wm-nav.js')

def kind_of(rel):
    return rel.rsplit('.', 1)[-1] if rel.endswith(('.css', '.js')) else 'html'

def restyle_repo(tokens, repo, only):
    """就地改写 apps 仓库：每台一个根目录（source_path=<slug>）"""
    for d in sorted(p for p in repo.iterdir() if p.is_dir() and not p.name.startswith('.')):
        if only and d.name not in only: continue
        if (d / 'sop.yaml').exists() or not (d / 'index.html').exists(): continue
        changed = []
        for f in sorted(x for x in d.rglob('*') if x.is_file() and x.suffix.lower() in ('.html', '.htm', '.css', '.js')):
            rel = str(f.relative_to(d)); src = rd(f)
            body, _ = transform(src, d.name, tokens, kind_of(rel))
            if body != src: wr(f, body); changed.append(rel)
        print(f"{d.name:38s} {'改写 ' + ', '.join(changed) if changed else '无变化'}")

if __name__ == '__main__':
    tokens = rd(Path(sys.argv[1]))
    if '--repo' in sys.argv:
        only = set(filter(None, (sys.argv[sys.argv.index('--only') + 1] if '--only' in sys.argv else '').split(',')))
        restyle_repo(tokens, Path(sys.argv[sys.argv.index('--repo') + 1]), only); sys.exit(0)
    src, extra, out = Path(sys.argv[2]), Path(sys.argv[3]), Path(sys.argv[4])
    report = {}
    for f in sorted(src.glob('*.html')):
        slug = f.stem
        jobs = [('index.html', f)] + [(str(x.relative_to(extra / slug)), x) for x in sorted((extra / slug).rglob('*')) if x.is_file()]
        agg = {'colors': {}, 'font_size': 0, 'font_family': 0, 'radius': 0}
        for rel, path in jobs:
            body, st = transform(rd(path), slug, tokens, kind_of(rel))
            dst = out / slug / rel; dst.parent.mkdir(parents=True, exist_ok=True); wr(dst, body)
            agg['colors'].update(st['colors'])
            for k in ('font_size', 'font_family', 'radius'): agg[k] += st[k]
        roles = {}
        for k, v in agg['colors'].items(): roles.setdefault(v, []).append(k)
        report[slug] = {'files': [r for r, _ in jobs], 'distinct_colors': len(agg['colors']), 'font_size': agg['font_size'], 'font_family': agg['font_family'], 'radius': agg['radius'], 'roles': roles}
    wr(out / 'report.json', json.dumps(report, ensure_ascii=False, indent=1))
    for k, v in report.items(): print(f"{k:38s} files={len(v['files'])} colors={v['distinct_colors']:3d} fs={v['font_size']:4d} ff={v['font_family']:3d} r={v['radius']:3d}")
