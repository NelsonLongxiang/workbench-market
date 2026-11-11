#!/usr/bin/env node
/**
 * 路由的录制回放：搬路由之前录一遍，之后对同一组请求重放，状态码、响应头和响应体必须和录下来的一样。
 * 每个域一份 surfaces/replay/<域>.json，请求和录下来的应答放在一起，对应 server/src/routes/<域>.ts。
 * 每个场景起一个隔离实例：临时数据目录、临时 HOME、随机的空闲端口（请求只发到回环地址）、固定的最小环境变量，再加场景自己声明的几个。
 * 场景里写了 clock（一个 ISO 时刻）的，实例的时钟从那一刻开始走（scripts/replay-clock-preload.mjs）：
 * 应答里由「现在」算出来的数（还有几天过期、今天是哪一天）才能每次都一样。数据库自己取的时间不受影响，照旧换成占位。
 *
 *   node scripts/route-replay-test.mjs                 回放全部域；有差异退出 1，逐条列出
 *   node scripts/route-replay-test.mjs types           只回放一个域（多打印每条路由三类各有几条）
 *   node scripts/route-replay-test.mjs --record [域]   把当前的应答录进去：搬之前录；有意改了行为也用它，PR 里看得见改了什么
 *   node scripts/route-replay-test.mjs --selftest      比较与覆盖检查的自检（不起市场实例）
 *
 * 录什么、比什么：状态码、内容类型、其余的响应头、响应体。每次都不一样的东西不比：
 *   · Date、Connection、Keep-Alive 这三个头不录（传输层的，随时间和客户端变）；
 *   · 时间里的数字换成占位，写法留着（中间是空格还是 T、小数秒几位、带不带 Z），所以写法变了看得出来；响应体和响应头里的都换；
 *   · 按内容算出来的 ETag 只留长度，后半段换成占位（响应体里有时间，那一段每次都变；响应体本身另外比）。
 *
 * 覆盖要求，不满足就直接失败、不起实例：
 *   · server/src/routes/ 下每个域模块都有一份；routes 的条数等于模块里注册的路由数，每条都在 surfaces/routes.json 里；
 *     用 app.all 注册的路由在 routes 里写成「ALL 路径」，什么方法的请求都算打在它上面；
 *   · 每条路由都有未授权（unauthorized）、参数非法（invalid）、正常（normal）三类请求，请求确实打在那条路由上；
 *   · 类别按录下来的应答核对，不是标了就算：未授权是 401 或 403，参数非法是其余的 4xx，正常是 2xx 或 3xx；
 *   · 确实没有某一类的路由（比如不读任何参数，就没有会被拒的输入），在 exempt 里写明理由，并指给一条打在这条路由上、照常应答的请求。
 * 请求只打全局中间件或本域路由会应答的路径。落空的路径由最后的兜底应答，兜底随有没有 web/dist 而不同，不放进来。
 *
 * 场景可以带 seed：实例起好之后、第一条请求之前往库里写几行（经 HTTP 建不出来的前提，比如一个已有的主体）。
 * 每一项是 { table, row }：表名、列名只收小写字母、数字和下划线（不以数字开头）；不收任意 SQL。
 */
import { spawn } from './owned-script-fixture.mjs';
import { createServer, request as httpRequest } from 'node:http';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const REPLAY_DIR = join(ROOT, 'surfaces', 'replay');
const ROUTES_SNAPSHOT = join(ROOT, 'surfaces', 'routes.json');
const MODULES_DIR = join(ROOT, 'server', 'src', 'routes');
const CLOCK_PRELOAD = join(HERE, 'replay-clock-preload.mjs');
/** 场景可以带的测试夹具：名字 → 预加载的文件和要加的环境变量。都只在 NODE_ENV=test 下干活。 */
const FIXTURES = {
  // 登录提供方换成假的（scripts/identity-fake-provider.mjs）：认人只看 session_id 的值，不访问任何外部系统
  'identity-fake': { preload: join(HERE, 'identity-fake-preload.mjs'), env: { IDENTITY_SEAM_ROOT: ROOT } },
  // 本机起一个假飞书、建一个放好合成应用凭证的临时凭据库，飞书登录指过去（scripts/feishu-fake-preload.mjs）
  'feishu-fake': { preload: join(HERE, 'feishu-fake-preload.mjs'), env: { IDENTITY_SEAM_ROOT: ROOT } },
};
const CLASSES = ['unauthorized', 'invalid', 'normal'];
const CLASS_NAME = { unauthorized: '未授权', invalid: '参数非法', normal: '正常' };
// 和 scripts/tech-route-check.mjs 数路由的写法一样，另外多认 all：体检不数它，但它在运行时是一条路由（快照里记成 ALL）
const ROUTE_CALL = /\b(?:app|router|r|api)\.(?:get|post|put|patch|delete|all)\(\s*['"`\/\[]/g;

/** 一段源码里注册了几条路由。 */
export function countRouteCalls(source) {
  return (String(source).match(ROUTE_CALL) || []).length;
}

/** 一个应答算哪一类，只看状态码：401、403 是未授权；其余 4xx 是参数非法；2xx、3xx 是正常；别的（比如 5xx）哪一类都不算。 */
export function classOf(status) {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status >= 400 && status <= 499) return 'invalid';
  if (status >= 200 && status <= 399) return 'normal';
  return null;
}

// ---------- 请求集的静态检查 ----------

/** surfaces/routes.json 里的路由行 → [{ methods, path }]。中间件行（USE）不要。 */
export function snapshotRoutes(snapshot) {
  const out = [];
  for (const line of (snapshot?.apps ?? []).flat()) {
    const m = /^\s*([A-Z,-]+) (.+?) {2}<- /.exec(line);
    if (m && m[1] !== 'USE') out.push({ methods: m[1].split(','), path: m[2] });
  }
  return out;
}

/** 路由路径 → 判断一个请求路径是不是落在它上面的正则。和 Express 的缺省一致：不分大小写，末尾的斜杠可有可无。 */
export function routeMatcher(routePath) {
  const literal = /^\/(.*)\/([a-z]*)$/.exec(routePath);
  if (routePath.startsWith('/^') && literal) return new RegExp(literal[1], literal[2]);
  const source = routePath.split('/').map((seg) => {
    const param = /^:[A-Za-z0-9_]+(\(.+\))?$/.exec(seg);
    if (param) return param[1] ?? '[^/]+';
    return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  return new RegExp(`^${source}/?$`, 'i');
}

/**
 * 一份请求集哪里不合要求。返回问题清单，空就是合格。
 * answered 为真（回放、录完之后）：每条标了类别的请求都要录过，类别要和录下来的应答对得上。
 * answered 为假（开录之前）：只查结构，应答还没有或者马上要重录。
 */
export function checkCassette(cassette, known, moduleRouteCount = null, answered = true) {
  const problems = [];
  const routes = Array.isArray(cassette?.routes) ? cassette.routes : [];
  const scenarios = Array.isArray(cassette?.scenarios) ? cassette.scenarios : [];
  if (!cassette?.domain) problems.push('缺 domain');
  if (routes.length === 0) problems.push('routes 是空的');
  if (scenarios.length === 0) problems.push('scenarios 是空的');
  for (const scenario of scenarios) {
    if (scenario?.seed === undefined) continue;
    if (!Array.isArray(scenario.seed)) { problems.push(`${scenario?.name}：seed 要是数组`); continue; }
    for (const item of scenario.seed) {
      const cols = item?.row && typeof item.row === 'object' && !Array.isArray(item.row) ? Object.keys(item.row) : [];
      if (!/^[a-z_][a-z0-9_]*$/.test(String(item?.table ?? '')) || cols.length === 0 || cols.some((c) => !/^[a-z_][a-z0-9_]*$/.test(c)) || Object.values(item.row).some((v) => v !== null && typeof v === 'object')) {
        problems.push(`${scenario?.name}：seed 的每一项要是 { table, row }，表名和列名只收小写字母、数字和下划线（不以数字开头），值不能是对象`);
      }
    }
  }
  for (const route of routes) {
    const [method, ...rest] = String(route).split(' ');
    if (!known.some((k) => k.path === rest.join(' ') && k.methods.includes(method))) problems.push(`路由不在 surfaces/routes.json 里：${route}`);
  }
  if (moduleRouteCount !== null && moduleRouteCount !== routes.length) problems.push(`域模块里注册了 ${moduleRouteCount} 条路由，routes 列了 ${routes.length} 条`);
  const seen = new Map();
  const covered = new Map(routes.map((r) => [r, new Set()]));
  for (const scenario of scenarios) {
    if (!scenario?.name) problems.push('有场景没有 name');
    if (scenario?.fixtures !== undefined && !(Array.isArray(scenario.fixtures) && scenario.fixtures.every((f) => f in FIXTURES))) problems.push(`${scenario?.name}：fixtures 只能是 ${Object.keys(FIXTURES).join('、')} 里的名字`);
    if (scenario?.clock !== undefined && (typeof scenario.clock !== 'string' || !Number.isFinite(Date.parse(scenario.clock)))) problems.push(`${scenario?.name}：clock 要写成 ISO 时刻（比如 2030-01-01T00:00:00Z）`);
    for (const step of scenario?.steps ?? []) {
      const where = `${scenario.name}/${step?.id ?? '?'}`;
      if (!step?.id) problems.push(`${scenario.name} 里有请求没有 id`);
      if (seen.has(where)) problems.push(`请求 id 重复：${where}`);
      seen.set(where, step);
      const method = String(step?.request?.method ?? '');
      const path = String(step?.request?.path ?? '');
      if (!method || !path.startsWith('/')) { problems.push(`${where}：request 要有 method 和以 / 开头的 path`); continue; }
      if (step.request.raw !== undefined && step.request.raw !== true) { problems.push(`${where}：request.raw 只能写 true（路径原样发出去）`); continue; }
      if (step.verify !== undefined && !(step.verify in VERIFIERS)) { problems.push(`${where}：verify 只能是 ${Object.keys(VERIFIERS).join('、')}`); continue; }
      if (step.vary !== undefined && !(step.vary && typeof step.vary === 'object' && !Array.isArray(step.vary) && Object.keys(step.vary).length > 0 && Object.entries(step.vary).every(([k, h]) => (k === '$text' ? h === 'hex64' : k.startsWith('$header:') ? /^\$header:[a-z0-9-]+$/.test(k) && h === 'random' : k === '$location' ? locationVaryOk(h) : k === '$cookies' ? cookieVaryOk(h) : h === 'random' || (typeof h === 'number' && h > 0))))) { problems.push(`${where}：vary 要写成 { 字段路径: 'random' 或一个正数 }，文本应答体写 { $text: 'hex64' }，响应头写 { '$header:小写头名': 'random' }，跳转地址写 { $location: ['port', 'query:名'] }，cookie 写 { $cookies: { 名字: ['value', 'max-age'] } }`); continue; }
      if (step.compare !== undefined && step.compare !== 'status' && !(Array.isArray(step.compare) && step.compare.length > 0 && step.compare.every((x) => typeof x === 'string' && x))) { problems.push(`${where}：compare 只能是 'status'，或者一组字段的路径`); continue; }
      if (step.route === undefined) continue;
      if (!covered.has(step.route)) { problems.push(`${where}：route 不在 routes 里：${step.route}`); continue; }
      if (!CLASSES.includes(step.class)) { problems.push(`${where}：class 只能是 ${CLASSES.join(' / ')}`); continue; }
      const [routeMethod, ...rest] = step.route.split(' ');
      const pathname = path.split('?')[0].replace(/\{\{[A-Za-z0-9_]+\}\}/g, '0');
      if ((routeMethod !== 'ALL' && routeMethod !== method.toUpperCase()) || !routeMatcher(rest.join(' ')).test(pathname)) { problems.push(`${where}：请求 ${method} ${path} 打不到它声明的路由 ${step.route}`); continue; }
      if (answered) {
        const status = step.response?.status;
        if (typeof status !== 'number') { problems.push(`${where}：还没录过（跑一次 --record）`); continue; }
        const actual = classOf(status);
        if (actual !== step.class) { problems.push(`${where}：标的是「${CLASS_NAME[step.class]}」，录下来的应答是 ${status}，${actual ? `按应答算「${CLASS_NAME[actual]}」` : '哪一类都不算'}`); continue; }
      }
      covered.get(step.route).add(step.class);
    }
  }
  const exempted = new Set();
  for (const item of Array.isArray(cassette?.exempt) ? cassette.exempt : []) {
    const label = `豁免 ${item?.route} 的「${CLASS_NAME[item?.class] ?? item?.class}」`;
    if (!covered.has(item?.route)) { problems.push(`${label}：route 不在 routes 里`); continue; }
    if (!CLASSES.includes(item.class)) { problems.push(`${label}：class 只能是 ${CLASSES.join(' / ')}`); continue; }
    if (typeof item.why !== 'string' || !item.why.trim()) { problems.push(`${label}：要写理由（why）`); continue; }
    const shown = seen.get(item.shown_by);
    // 豁免未授权、参数非法：指给一条照常应答的请求（证明这条路由确实应答）。
    // 豁免正常（退役的路由，一律回 4xx）：指给一条打在这条路由上的请求，它不能是正常的（证明确实不照常应答）。
    const wantNormal = item.class !== 'normal';
    if (!shown || shown.route !== item.route || (wantNormal ? shown.class !== 'normal' : !CLASSES.includes(shown.class) || shown.class === 'normal')) { problems.push(`${label}：shown_by 要指给一条打在这条路由上的请求（写成 场景名/请求 id）：豁免未授权、参数非法时那条要照常应答；豁免正常时那条不能照常应答`); continue; }
    if (covered.get(item.route).has(item.class)) { problems.push(`${label}：这条路由有这一类的请求，豁免是多余的`); continue; }
    exempted.add(`${item.route}\n${item.class}`);
  }
  for (const [route, classes] of covered) {
    const missing = CLASSES.filter((c) => !classes.has(c) && !exempted.has(`${route}\n${c}`));
    if (missing.length) problems.push(`${route} 缺 ${missing.map((c) => CLASS_NAME[c]).join('、')} 的请求${answered ? '（按录下来的应答算）' : ''}`);
  }
  return problems;
}

/** 每条路由三类各有几条，豁免的写「豁免」。请求集合格之后才调用，所以标的类别已经和应答对过。 */
export function coverage(cassette) {
  const counts = new Map(cassette.routes.map((r) => [r, { unauthorized: 0, invalid: 0, normal: 0 }]));
  for (const scenario of cassette.scenarios) for (const step of scenario.steps) if (counts.has(step.route) && CLASSES.includes(step.class)) counts.get(step.route)[step.class]++;
  const exempted = new Set((cassette.exempt ?? []).map((item) => `${item.route}\n${item.class}`));
  return [...counts].map(([route, n]) => `${route}：${CLASSES.map((c) => `${CLASS_NAME[c]} ${exempted.has(`${route}\n${c}`) ? '豁免' : n[c]}`).join('，')}`);
}

// ---------- 发请求、整理应答、比较 ----------

/** 把 {{名字}} 换成前面请求存下来的值。没存过就报错，不悄悄发出一个带花括号的请求。 */
export function fill(value, vars) {
  if (typeof value === 'string') return value.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (_, name) => { if (!(name in vars)) throw new Error(`用了没存过的变量 {{${name}}}`); return String(vars[name]); });
  if (Array.isArray(value)) return value.map((v) => fill(v, vars));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, vars)]));
  return value;
}

const DATETIME = /\b\d{4}-\d{2}-\d{2}([ T])\d{2}:\d{2}:\d{2}(?:\.(\d+))?(Z?)/g;
/**
 * 时间每次都不一样：数字换成字母占位，写法原样留着（中间是空格还是 T、小数秒几位、带不带 Z），长度也不变。
 * 整个换成同一个占位的话，时间的写法变了（比如空格换成 T）是看不出来的。
 */
export function maskTime(text) {
  return String(text).replace(DATETIME, (_all, sep, fraction, zone) => `YYYY-MM-DD${sep}hh:mm:ss${fraction ? `.${'f'.repeat(fraction.length)}` : ''}${zone}`);
}

/** 响应体里每次都不一样的东西只有时间：换成占位。别的一律原样比较。 */
export function steady(value) {
  if (typeof value === 'string') return maskTime(value);
  if (Array.isArray(value)) return value.map(steady);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, steady(v)]));
  return value;
}

// 传输层的头：随时间、随客户端怎么用连接而变，不是路由的行为
const TRANSPORT_HEADERS = new Set(['date', 'connection', 'keep-alive']);
// 头里的时间多半是 HTTP 的写法（Expires、Last-Modified、Set-Cookie 的 Expires=）。这种写法只有一种，整个换成 <时间>
const HTTP_DATE = /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT\b/g;
// 按内容算出来的 ETag 是「长度-内容的指纹或改动时间」。响应体里有时间，后半段每次都变；长度留着比
const DERIVED_ETAG = /^(W\/)?"([0-9a-f]+)-[^"]+"$/;

/** 响应头：去掉传输层的，按名字排好；时间换成占位；按内容算的 ETag 只留长度。别的一律原样比较。 */
export function steadyHeaders(headers) {
  const out = {};
  for (const name of Object.keys(headers ?? {}).sort()) {
    if (TRANSPORT_HEADERS.has(name)) continue;
    const one = (v) => (name === 'etag' ? String(v).replace(DERIVED_ETAG, '$1"$2-<指纹>"') : maskTime(String(v).replace(HTTP_DATE, '<时间>')));
    out[name] = Array.isArray(headers[name]) ? headers[name].map(one) : one(headers[name]);
  }
  return out;
}

/** 一个应答整理成录下来的样子：状态码、内容类型、其余的响应头、响应体。 */
export function steadyResponse(raw) {
  return { status: raw.status, type: raw.type, headers: steadyHeaders(raw.headers), body: steady(raw.body) };
}

const pick = (value, path) => String(path).split('.').reduce((v, key) => (v == null ? undefined : v[key]), value);

/**
 * 路径原样发出去：request 上写 raw: true。fetch（WHATWG URL）发之前会把路径里的 .、..（连 %2e%2e 也算）规范掉，
 * 反斜杠也会换成斜杠，防穿越的拦截就收不到这种请求。原样发用 node:http，路径一个字不改；应答整理成和 fetch 一样的形状。
 */
/**
 * 打包的应答体（tar、tar.gz）：字节里带着随时间变的东西（tar 头的修改时刻、跟着它变的校验和），不能逐字比，也不能丢掉不比。
 * 规范化之后记下来比：gzip 先解压；每个 512 字节的 tar 头块里，修改时刻（偏移 136–147）和校验和（148–155）换成 '?'，其余字节照旧。
 * 条目是文本（UTF-8 能原样往返）的，内容里的时间照应答体的规矩换成占位（占位和原来一样长，大小、偏移都不变），
 *   比如技能包里市场生成的 .wm-skill.json 带着版本的发布时刻（SQLite 的 datetime('now')，回放定的时钟管不到）。
 * 记：规范化之后整个 tar 的长度和 sha256（头块里任何别的字节变了都看得出来）、每个条目的路径、大小、类型和内容的 sha256（哪一项变了一眼看出）。
 * 不是 tar、tar.gz 的应答返回 null，照旧按文本或 JSON 比。
 */
export function archiveBody(type, buf) {
  const gz = /application\/(x-)?gzip/i.test(type);
  if (!gz && !/application\/(x-)?tar\b/i.test(type)) return null;
  let tar;
  try { tar = Buffer.from(gz ? gunzipSync(buf) : buf); } catch (e) { return { archive: gz ? 'tar.gz' : 'tar', error: `解不开：${String(e?.message ?? e).slice(0, 80)}` }; }
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  const str = (b) => b.toString('utf8').replace(/\0[\s\S]*$/, '');
  const entries = [];
  for (let off = 0; off + 512 <= tar.length;) {
    const head = tar.subarray(off, off + 512);
    if (head.every((x) => x === 0)) break;
    const name = str(head.subarray(0, 100)), prefix = str(head.subarray(345, 500));
    const size = parseInt(str(head.subarray(124, 136)).trim() || '0', 8) || 0;
    const kind = String.fromCharCode(head[156] || 0x30);
    head.fill(0x3f, 136, 156); // 修改时刻和校验和
    const content = tar.subarray(off + 512, off + 512 + size);
    const text = content.toString('utf8');
    if (Buffer.from(text, 'utf8').equals(content)) { const masked = Buffer.from(maskTime(text), 'utf8'); if (masked.length === content.length) masked.copy(content); }
    entries.push({ path: prefix ? `${prefix}/${name}` : name, size, type: kind, sha256: sha(content) });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return { archive: gz ? 'tar.gz' : 'tar', length: tar.length, normalized_sha256: sha(tar), entries };
}

function sendRaw(base, request, path, headers, body) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: url.hostname, port: url.port, method: request.method, path, headers: { ...headers, ...(body !== undefined ? { 'content-length': Buffer.byteLength(body) } : {}) }, timeout: 15000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        const type = String(res.headers['content-type'] ?? '');
        const others = {};
        for (const [name, value] of Object.entries(res.headers)) if (name !== 'content-type' && name !== 'set-cookie') others[name] = Array.isArray(value) ? value.join(', ') : value;
        if (res.headers['set-cookie']?.length) others['set-cookie'] = res.headers['set-cookie'];
        let parsed = archiveBody(type, buf) ?? text;
        if (/json/i.test(type)) { try { parsed = JSON.parse(text); } catch { /* 按文本比 */ } }
        resolve({ status: res.statusCode, type, headers: others, body: parsed });
      });
    });
    req.on('timeout', () => req.destroy(new Error('原样发路径：超时')));
    req.on('error', reject);
    req.end(body);
  });
}

async function send(base, request, vars) {
  const headers = fill(request.headers ?? {}, vars);
  let body;
  if ('json' in request) { body = JSON.stringify(fill(request.json, vars)); if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json'; }
  else if ('text' in request) body = fill(request.text, vars);
  if (request.raw === true) return sendRaw(base, request, fill(request.path, vars), headers, body);
  // 不跟着跳转走：3xx 本身和它的 Location 就是要比的应答
  const res = await fetch(base + fill(request.path, vars), { method: request.method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(15000) });
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString('utf8');
  const type = res.headers.get('content-type') ?? '';
  // 内容类型单独记在 type 里；Set-Cookie 可以有好几条，一条一条记，不拼成一行
  const others = {};
  for (const [name, value] of res.headers) if (name !== 'content-type' && name !== 'set-cookie') others[name] = value;
  const cookies = res.headers.getSetCookie();
  if (cookies.length) others['set-cookie'] = cookies;
  let parsed = archiveBody(type, buf) ?? text; // 打包的应答体规范化之后比（见 archiveBody）
  if (/json/i.test(type)) { try { parsed = JSON.parse(text); } catch { /* 说是 JSON 但解析不了：按文本比 */ } }
  return { status: res.status, type, headers: others, body: parsed };
}

/** 两个值哪里不一样：一处一行，带路径。字段的顺序也算（响应体是按字节发出去的）。 */
export function differences(before, after, path = '响应体', out = []) {
  if (Object.is(before, after)) return out;
  const plain = (v) => v !== null && typeof v === 'object';
  if (plain(before) && plain(after) && Array.isArray(before) === Array.isArray(after)) {
    const found = out.length;
    const keys = Array.isArray(before) ? Array.from({ length: Math.max(before.length, after.length) }, (_, i) => i) : [...new Set([...Object.keys(before), ...Object.keys(after)])];
    for (const key of keys) differences(before[key], after[key], Array.isArray(before) ? `${path}[${key}]` : `${path}.${key}`, out);
    if (!Array.isArray(before) && out.length === found && Object.keys(before).join('\n') !== Object.keys(after).join('\n')) out.push(`${path}：字段的顺序变了`);
    return out;
  }
  const show = (v) => (v === undefined ? '（没有）' : JSON.stringify(v)?.slice(0, 200));
  out.push(`${path}：${show(before)} → ${show(after)}`);
  return out;
}

/**
 * 一条请求录什么、比什么，由它的 compare 定：
 *   · 不写：状态码、内容类型、响应头、响应体，全比；
 *   · 'status'：只比状态码（借别的域的路由布置现场用）；
 *   · 一组字段的路径（比如 ['cookie_set_id']）：比状态码和响应体里点名的这几个字段。
 *     借别的域的路由看副作用用：那条路由的应答里别的字段可能每次不一样，也不归这个域管。
 */
/**
 * 应答体里每次都不一样、又不是时间的字段：请求上写 vary，按字段的路径点名。
 *   'random'：每个实例随机生成的值（密钥、签名）。换成占位，只留类型和长度，有没有这个字段照样比。
 *   一个正数 n：由「现在」算出来、带毫秒的数。往下取整到 n 的倍数再比（定了时钟，起实例到发请求只差几秒）。
 *   文本的应答体（比如注入了台令牌的 HTML）：写 { $text: 'hex64' }，正文里每一段独立的 64 位十六进制
 *   （每个实例随机的密钥算出来的令牌）换成占位，别的字照常比。
 * 别的字段照常比，响应头也照常比。
 */
const LOCATION_PARTS_RE = /^(port|query:[a-z_][a-z0-9_]{0,31})$/;
const locationVaryOk = (h) => Array.isArray(h) && h.length > 0 && h.every((x) => typeof x === 'string' && LOCATION_PARTS_RE.test(x));
const cookieVaryOk = (h) => !!h && typeof h === 'object' && !Array.isArray(h) && Object.keys(h).length > 0
  && Object.entries(h).every(([name, parts]) => /^[A-Za-z0-9_-]{1,64}$/.test(name) && Array.isArray(parts) && parts.length > 0 && parts.every((x) => x === 'value' || x === 'max-age'));

/**
 * 响应头里每次都不一样的那几个字节（跳转地址里的随机端口和随机参数、cookie 的随机值），按请求上的 vary 点名遮：
 *   $location: ['port', 'query:state']：跳转地址（Location 头，以及「Found. Redirecting to …」那样把地址写进正文的）里，
 *     回环地址 127.0.0.1 后面的端口（含编码在参数里的 %3A）换成占位：是这个实例自己的端口写 <市场端口>，别的写 <别的端口>
 *     （回调地址写死成别的端口看得出来）；点名的查询参数的值换成只留长度的占位。主机、路径、别的参数照比。
 *   $cookies: { 名字: ['value', 'max-age'] }：Set-Cookie 里这个名字的 cookie，值换成只留长度的占位（空值不换，清除照样看得出），
 *     Max-Age 按分钟四舍五入（599 秒和 600 秒都记「约 10 分」，改成一小时看得出；有没有 Max-Age 照比）。cookie 的名字、Path、HttpOnly、SameSite、Secure 这些属性照比。
 * 别的头、别的 cookie 一律原样比。
 */
export function applyRedirectCookieVary(raw, vary) {
  if (!vary || (!vary.$location && !vary.$cookies)) return raw;
  const headers = { ...(raw.headers ?? {}) };
  let body = raw.body;
  if (vary.$location) {
    const mask = (text) => {
      let out = String(text);
      for (const part of vary.$location) {
        if (part === 'port') out = out.replace(/127\.0\.0\.1(:|%3A)(\d{1,5})/gi, (_m, sep, port) => `127.0.0.1${sep}<${raw.selfPort !== undefined && port === String(raw.selfPort) ? '市场端口' : '别的端口'}>`);
        else {
          const name = part.slice('query:'.length);
          out = out.replace(new RegExp(`([?&]${name}=)([^&#\\s"]*)`, 'g'), (_m, head, value) => `${head}<每个实例随机·${value.length}>`);
        }
      }
      return out;
    };
    if (typeof headers.location === 'string') headers.location = mask(headers.location);
    if (typeof body === 'string') body = mask(body);
  }
  if (vary.$cookies && headers['set-cookie']) {
    const list = Array.isArray(headers['set-cookie']) ? headers['set-cookie'] : [headers['set-cookie']];
    headers['set-cookie'] = list.map((line) => {
      const m = /^([^=;\s]+)=([^;]*)(.*)$/.exec(String(line));
      const parts = m ? vary.$cookies[m[1]] : undefined;
      if (!m || !parts) return line;
      let value = m[2], rest = m[3];
      if (parts.includes('value') && value !== '') value = `<每个实例随机·${value.length}>`;
      if (parts.includes('max-age')) rest = rest.replace(/(;\s*Max-Age=)(\d+)/i, (_m, head, n) => `${head}<约${Math.round(Number(n) / 60)}分>`);
      return `${m[1]}=${value}${rest}`;
    });
  }
  return { ...raw, headers, body };
}

export function applyVary(body, vary) {
  if (vary && typeof body === 'string') return vary.$text === 'hex64' ? body.replace(/(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/g, '<每个实例随机·hex64>') : body;
  if (!vary || body === null || typeof body !== 'object') return body;
  const out = structuredClone(body);
  for (const [path, how] of Object.entries(vary)) {
    if (path.startsWith('$')) continue; // $location、$cookies 管响应头，见 applyHeaderVary
    const keys = String(path).split('.');
    const last = keys.pop();
    const holder = keys.reduce((v, k) => (v == null ? undefined : v[k]), out);
    if (holder == null || typeof holder !== 'object' || !(last in holder)) continue;
    const value = holder[last];
    if (how === 'random') holder[last] = `<每个实例随机·${typeof value}·${typeof value === 'string' ? value.length : String(value).length}>`;
    else if (typeof how === 'number' && typeof value === 'number') holder[last] = value - (value % how);
  }
  return out;
}

/**
 * 响应头里每次都不一样的值：vary 写 { '$header:小写头名': 'random' }，换成只留类型和长度的占位（和应答体的 'random' 一样）。
 * 比如打包下载：gzip 的字节随包里的时刻变，Content-Length 的位数、X-Package-Sha256 的长度不变，有没有这个头照样比。
 */
export function applyHeaderVary(headers, vary) {
  const out = { ...(headers ?? {}) };
  for (const [key, how] of Object.entries(vary ?? {})) {
    if (!key.startsWith('$header:') || how !== 'random') continue;
    const name = key.slice('$header:'.length);
    if (name in out) out[name] = `<每个实例随机·${typeof out[name]}·${String(out[name]).length}>`;
  }
  return out;
}

/**
 * 应答体要验的东西：请求上写 verify，值是下面的名字。验的结果记成 verified，和别的一样录下来比。
 * vary 把签名换成了只留长度的占位，签名坏了但长度不变时看不出来；这里在换之前先验。
 *   'a2a-card'：A2A 签名卡片，用卡片里的公钥验签名（和 server 用的是同一个库）。
 */
const VERIFIERS = {
  'a2a-card': async () => {
    const require = createRequire(join(ROOT, 'server', 'package.json'));
    const { verifyCard } = await import(pathToFileURL(require.resolve('@nelsonlongxiang/dsh-open-a2a-net/card')).href);
    return (body) => { try { return verifyCard(body, Date.now()).ok === true; } catch { return false; } };
  },
};
const loadedVerifiers = {};
export async function loadVerifiers(names) {
  for (const name of names) {
    if (!VERIFIERS[name]) throw new Error(`没有叫 ${JSON.stringify(name)} 的验法（有：${Object.keys(VERIFIERS).join('、')}）`);
    loadedVerifiers[name] ??= await VERIFIERS[name]();
  }
}

export function shapeOf(step, raw) {
  if (step.compare === 'status') return { status: raw.status };
  if (step.vary && Object.keys(step.vary).some((k) => k.startsWith('$header:'))) raw = { ...raw, headers: applyHeaderVary(raw.headers, step.vary) };
  let verified;
  if (step.verify) {
    const check = loadedVerifiers[step.verify];
    if (!check) throw new Error(`验法 ${step.verify} 没有加载`);
    verified = { [step.verify]: check(raw.body) };
  }
  if (step.vary) raw = applyRedirectCookieVary({ ...raw, body: applyVary(raw.body, step.vary) }, step.vary);
  if (verified) return { ...steadyResponse(raw), verified };
  // 应答里没有的字段不记（写进 JSON 也留不住），所以「原来没有、后来有了」和「原来有、后来没了」都看得出来
  if (Array.isArray(step.compare)) return { status: raw.status, picked: Object.fromEntries(step.compare.map((path) => [path, steady(pick(raw.body, path))]).filter(([, value]) => value !== undefined)) };
  return steadyResponse(raw);
}

/** 录下来的应答和这次的应答比。 */
export function compareStep(step, actual) {
  const recorded = step.response;
  if (!recorded) return ['还没录过（跑一次 --record）'];
  const out = [];
  if (recorded.status !== actual.status) out.push(`状态码：${recorded.status} → ${actual.status}`);
  if (step.compare === 'status') return out;
  if (Array.isArray(step.compare)) return differences(recorded.picked ?? {}, actual.picked ?? {}, '点名的字段', out);
  if (recorded.type !== actual.type) out.push(`内容类型：${JSON.stringify(recorded.type)} → ${JSON.stringify(actual.type)}`);
  if (!recorded.headers) out.push('录制里没有响应头（跑一次 --record）');
  else differences(recorded.headers, actual.headers ?? {}, '响应头', out);
  differences(recorded.body, actual.body, '响应体', out);
  if (recorded.verified || actual.verified) differences(recorded.verified, actual.verified, '验', out);
  return out;
}

/**
 * 依次跑一个场景的请求。sendRequest(request, vars) 负责发出去并返回 { status, type, headers, body }（自检时换成假的）。
 * 回放：返回每条请求的差异。某一条发不出去（比如它要用的变量前面没存下来），算这一条的差异，后面的照跑。
 * 录制：把应答写进 step.response；发不出去、或要存的值没取到，直接报错，不写出半份录制。
 */
export async function runSteps(steps, sendRequest, record = false) {
  const vars = {};
  const results = [];
  for (const step of steps) {
    let actual;
    try {
      const raw = await sendRequest(step.request, vars);
      for (const [name, path] of Object.entries(step.save ?? {})) {
        const value = pick(raw.body, path);
        if (value !== undefined && value !== null) vars[name] = value;
        else if (record) throw new Error(`应答里取不到要存的 ${path}`);
      }
      actual = shapeOf(step, raw);
    } catch (err) {
      if (record) throw new Error(`${step.id}：${err.message}`);
      results.push({ step, diffs: [`请求没发出去：${err.message}`] });
      continue;
    }
    if (record) step.response = actual;
    results.push({ step, diffs: record ? [] : compareStep(step, actual) });
  }
  return results;
}

// ---------- 隔离实例 ----------

async function freePort() {
  const probe = createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address();
  await new Promise((r) => probe.close(r));
  return port;
}

/**
 * 端口是先探到空闲的、再交给实例去绑，中间可能被别的进程占走，实例就起不来（EADDRINUSE）。
 * 只有这一种失败换一个端口再起，最多三次；别的失败（比如代码改坏了起不来）不重试，直接报。
 */
export async function withPortRetry(start, attempts = 3, note = (line) => console.error(line)) {
  for (let attempt = 1; ; attempt++) {
    try { return await start(); }
    catch (err) {
      if (!err?.portBusy || attempt >= attempts) throw err;
      note(`[route-replay] 探到的端口被别的进程占了，换一个再起（第 ${attempt + 1} 次）`);
    }
  }
}

const boot = (tag, env, clock, fixtures) => withPortRetry(() => bootOnce(tag, env, clock, fixtures));

/** 起实例用的 node 参数和多出来的环境变量。场景定了时钟，就把平移时钟的预加载带上。 */
export function launchPlan(clock, fixtures = []) {
  const imports = [], env = {};
  for (const name of fixtures) {
    const f = FIXTURES[name];
    if (!f) throw new Error(`没有叫 ${JSON.stringify(name)} 的夹具（有：${Object.keys(FIXTURES).join('、')}）`);
    imports.push('--import', pathToFileURL(f.preload).href);
    Object.assign(env, f.env);
  }
  if (clock !== undefined) {
    if (typeof clock !== 'string' || !Number.isFinite(Date.parse(clock))) throw new Error(`clock 要写成 ISO 时刻（比如 2030-01-01T00:00:00Z），现在是 ${JSON.stringify(clock)}`);
    imports.push('--import', pathToFileURL(CLOCK_PRELOAD).href);
    env.WM_REPLAY_CLOCK = clock;
  }
  return { args: ['--disable-warning=ExperimentalWarning', ...imports, 'src/index.ts'], env };
}

async function bootOnce(tag, env, clock, fixtures) {
  const plan = launchPlan(clock, fixtures);
  const port = await freePort();
  const root = join(ROOT, 'tmp', `route-replay-${process.pid}-${tag}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, 'data'), { recursive: true });
  mkdirSync(join(root, 'home'), { recursive: true });
  const child = spawn(process.execPath, plan.args, {
    cwd: join(ROOT, 'server'),
    env: { PATH: process.env.PATH, HOME: join(root, 'home'), MCP_GATEWAY: 'off', NODE_ENV: 'test', PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: join(root, 'data'), ...env, ...plan.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += String(d); });
  // 先请它退出；5 秒不退就强杀，并且等到它真的退出，再删目录。删不掉只警告，不改结果
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  const waitExit = (ms) => new Promise((r) => { if (exited()) r(); else { const t = setTimeout(r, ms); child.once('exit', () => { clearTimeout(t); r(); }); } });
  const stop = async () => {
    if (!exited()) { child.kill('SIGTERM'); await waitExit(5000); }
    if (!exited()) { child.kill('SIGKILL'); await waitExit(5000); }
    try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    catch (e) { console.warn(`⚠ 临时目录没删干净（不影响结果）：${root}：${e?.code ?? e}`); }
  };
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30000;
  let ready = false;
  while (!ready && Date.now() < deadline && child.exitCode === null) {
    try { ready = (await fetch(`${base}/api/health`)).status === 200; } catch { /* 还没起来 */ }
    if (!ready) await new Promise((r) => setTimeout(r, 200));
  }
  if (!ready) {
    await stop();
    throw Object.assign(new Error(`隔离实例没起来（${tag}）：${stderr.trim().split('\n').slice(-3).join(' | ') || '没有输出'}`), { portBusy: stderr.includes('EADDRINUSE') });
  }
  return { base, stop, data: join(root, 'data') };
}

/** 场景的 seed：往实例的库里写几行。checkCassette 已经核过形状，这里表名、列名都只会是小写字母和下划线 */
function seedInstance(dataDir, seed) {
  if (!seed?.length) return;
  const db = new DatabaseSync(join(dataDir, 'workbench-market.db'));
  try {
    db.exec('PRAGMA busy_timeout=5000');
    for (const { table, row } of seed) {
      const cols = Object.keys(row);
      db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => row[c]));
    }
  } finally { db.close(); }
}

// ---------- 读写请求集 ----------

const LINE = 240;
/** 请求集、场景、请求这三层总是拆开写；一条记录（值都不是容器的对象）总是一行；其余一行放得下就写成一行。录下来的文件要能一条一条读。 */
export function render(value, indent = '') {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  const entries = Array.isArray(value) ? value.map((v) => [null, v]) : Object.entries(value);
  if (entries.length === 0) return Array.isArray(value) ? '[]' : '{}';
  const inline = (v) => (v === null || typeof v !== 'object' ? JSON.stringify(v)
    : Array.isArray(v) ? `[${v.map(inline).join(', ')}]` : Object.keys(v).length === 0 ? '{}' : `{ ${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`).join(', ')} }`);
  const structural = (v) => (Array.isArray(v) ? v.some(structural) : v !== null && typeof v === 'object' && ('scenarios' in v || 'steps' in v || 'request' in v));
  const record = !Array.isArray(value) && Object.values(value).every((v) => v === null || typeof v !== 'object');
  const flat = inline(value);
  if (!structural(value) && (record || indent.length + flat.length <= LINE)) return flat;
  const inner = `${indent}  `;
  const lines = entries.map(([k, v]) => `${inner}${k === null ? '' : `${JSON.stringify(k)}: `}${render(v, inner)}`);
  return `${Array.isArray(value) ? '[' : '{'}\n${lines.join(',\n')}\n${indent}${Array.isArray(value) ? ']' : '}'}`;
}

/** 字段按固定的顺序写：手写的请求集录一遍之后格式就定了，之后的差异都是内容上的。 */
function canonical(cassette) {
  const order = (obj, keys) => Object.fromEntries([...keys.filter((k) => k in obj).map((k) => [k, obj[k]]), ...Object.entries(obj).filter(([k]) => !keys.includes(k))]);
  return order({
    ...cassette,
    scenarios: cassette.scenarios.map((s) => order({
      ...s,
      steps: s.steps.map((step) => order({ ...step, request: order(step.request, ['method', 'path', 'raw', 'headers', 'json', 'text']) }, ['id', 'route', 'class', 'what', 'compare', 'vary', 'verify', 'request', 'save', 'response'])),
    }, ['name', 'what', 'env', 'clock', 'fixtures', 'seed', 'steps'])),
  }, ['domain', 'what', 'routes', 'exempt', 'scenarios']);
}

function loadCassettes(only) {
  const names = existsSync(REPLAY_DIR) ? readdirSync(REPLAY_DIR).filter((n) => n.endsWith('.json')).sort() : [];
  const all = names.map((name) => ({ file: join(REPLAY_DIR, name), domain: name.replace(/\.json$/, ''), cassette: JSON.parse(readFileSync(join(REPLAY_DIR, name), 'utf8')) }));
  return only ? all.filter((c) => c.domain === only) : all;
}

function moduleRouteCount(domain) {
  const file = join(MODULES_DIR, `${domain}.ts`);
  return existsSync(file) ? countRouteCalls(readFileSync(file, 'utf8')) : null;
}

// ---------- 自检 ----------

async function selftest() {
  let failed = 0;
  const check = (ok, label) => { console.log(`  ${ok ? '✓' : '✗'} ${label}`); if (!ok) failed++; };
  const known = snapshotRoutes({ apps: [['USE /  <- query', 'GET /api/x  <- <anonymous>', 'PUT /api/x/:id(\\d+)  <- <anonymous>', 'GET,POST /api/y  <- a, b', 'GET /^\\/z\\/[a-z]+$/  <- <anonymous>']] });
  check(known.length === 4 && known[2].methods.join() === 'GET,POST', '读快照：只取路由行，多方法的行拆开');
  check(routeMatcher('/api/x/:id').test('/API/x/12/') && !routeMatcher('/api/x/:id').test('/api/x/12/more') && !routeMatcher('/api/x/:id').test('/api/x'), '路径匹配：不分大小写、末尾斜杠可有可无、段数要对');
  check(routeMatcher('/api/x/:id(\\d+)').test('/api/x/7') && !routeMatcher('/api/x/:id(\\d+)').test('/api/x/abc'), '路径匹配：带正则的参数');
  check(routeMatcher('/^\\/z\\/[a-z]+$/').test('/z/abc') && !routeMatcher('/^\\/z\\/[a-z]+$/').test('/z/1'), '路径匹配：正则路由');
  const step = (id, route, cls, method, path, status) => ({ id, route, class: cls, request: { method, path }, ...(status === undefined ? {} : { response: { status } }) });
  const withSteps = (steps, extra = {}) => ({ domain: 'x', routes: ['GET /api/x'], scenarios: [{ name: 's', steps }], ...extra });
  const [a, b, c] = [step('a', 'GET /api/x', 'unauthorized', 'GET', '/api/x', 401), step('b', 'GET /api/x', 'invalid', 'GET', '/api/x?q=1', 400), step('c', 'GET /api/x', 'normal', 'GET', '/api/x', 200)];
  const full = withSteps([a, b, c]);
  check(checkCassette(full, known, 1).length === 0, '覆盖检查：三类齐全，通过');
  check(checkCassette(withSteps([b, c]), known).some((p) => p.includes('缺 未授权')), '覆盖检查：少一类，点名缺哪一类');
  check(checkCassette({ ...full, routes: ['GET /api/x', 'GET /api/gone'] }, known).some((p) => p.includes('/api/gone')), '覆盖检查：路由不在快照里，点名');
  check(checkCassette(full, known, 2).some((p) => p.includes('注册了 2 条')), '覆盖检查：域模块里的路由比列出来的多，失败');
  {
    const seeded = (seed) => ({ ...full, scenarios: full.scenarios.map((sc) => ({ ...sc, seed })) });
    const good = checkCassette(seeded([{ table: 'principals', row: { id: 'user:x', kind: 'person' } }]), known, 1).length === 0;
    const bad = [{ table: 'x; DROP TABLE y', row: { a: 1 } }, { table: 'principals', row: {} }, { table: 'principals', row: { 'id = 1 --': 1 } }, { table: 'principals', row: { id: { $x: 1 } } }, { row: { id: 1 } }]
      .every((item) => checkCassette(seeded([item]), known, 1).some((p) => p.includes('seed')));
    check(good && bad && checkCassette(seeded('x'), known, 1).some((p) => p.includes('seed 要是数组')), '请求集：seed 只收 { table, row }，表名、列名只收小写字母、数字和下划线，值不能是对象');
  }
  check(checkCassette(withSteps([a, b, c, step('d', 'GET /api/x', 'normal', 'GET', '/api/other', 200)]), known).some((p) => p.includes('打不到')), '覆盖检查：请求没打在它声明的路由上，失败');
  check(countRouteCalls("app.get('/a', h);\n  app.all('/b', h);\n  r.post(`/c`, h);\n  app.use(x); app.set('etag', false);") === 3, '数路由：get、post、all 都算一条，use 和 set 不算');
  const anyKnown = snapshotRoutes({ apps: [['ALL /api/w/:id  <- <anonymous>']] });
  const anyMethod = (extra = []) => ({ domain: 'w', routes: ['ALL /api/w/:id'], scenarios: [{ name: 's', steps: [step('a', 'ALL /api/w/:id', 'unauthorized', 'DELETE', '/api/w/1', 403), step('b', 'ALL /api/w/:id', 'invalid', 'POST', '/api/w/1', 400), step('c', 'ALL /api/w/:id', 'normal', 'GET', '/api/w/1', 200), ...extra] }] });
  check(checkCassette(anyMethod(), anyKnown, 1).length === 0, '覆盖检查：用 all 注册的路由写成 ALL，什么方法的请求都算打在它上面');
  check(checkCassette(anyMethod([step('d', 'ALL /api/w/:id', 'normal', 'GET', '/api/other', 200)]), anyKnown).some((p) => p.includes('打不到')), '覆盖检查：ALL 的路由，路径对不上照样算打不到');
  // 类别按应答核对
  check([401, 403].every((s) => classOf(s) === 'unauthorized') && [400, 404, 409, 422].every((s) => classOf(s) === 'invalid') && [200, 201, 204, 302].every((s) => classOf(s) === 'normal') && classOf(500) === null, '类别：401、403 是未授权，其余 4xx 是参数非法，2xx、3xx 是正常，5xx 哪一类都不算');
  const mislabeled = checkCassette(withSteps([{ ...a, response: { status: 200 } }, b, c]), known);
  check(mislabeled.some((p) => p.includes('s/a') && p.includes('标的是「未授权」') && p.includes('200') && p.includes('按应答算「正常」')) && mislabeled.some((p) => p.includes('缺 未授权')), '类别：标成未授权、应答却是 200，点名这一条；这条路由也就缺未授权');
  check(checkCassette(withSteps([a, { ...b, response: { status: 201 } }, c]), known).some((p) => p.includes('s/b') && p.includes('标的是「参数非法」')), '类别：标成参数非法、应答却是 2xx，点名这一条');
  check(checkCassette(withSteps([a, { ...b, response: { status: 500 } }, c]), known).some((p) => p.includes('哪一类都不算')), '类别：应答是 5xx，哪一类都不算');
  const fresh = withSteps([a, b, step('c', 'GET /api/x', 'normal', 'GET', '/api/x')]);
  check(checkCassette(fresh, known).some((p) => p.includes('s/c') && p.includes('还没录过')) && checkCassette(fresh, known, null, false).length === 0, '类别：没录过的请求，回放前算不合格；开录之前只查结构，放行');
  // 豁免
  const exempt = (over = {}) => [{ route: 'GET /api/x', class: 'invalid', why: '这条路由不读任何参数', shown_by: 's/c', ...over }];
  const open = withSteps([a, c], { exempt: exempt() });
  check(checkCassette(open, known).length === 0, '豁免：写了理由、指给一条照常应答的请求，这一类可以没有');
  check(checkCassette(withSteps([a, c], { exempt: exempt({ why: ' ' }) }), known).some((p) => p.includes('要写理由')), '豁免：没写理由，不认');
  check(checkCassette(withSteps([a, c], { exempt: exempt({ shown_by: 's/nope' }) }), known).some((p) => p.includes('shown_by')) && checkCassette(withSteps([a, c], { exempt: exempt({ shown_by: 's/a' }) }), known).some((p) => p.includes('shown_by')), '豁免：没指给请求，或者指的那条不是照常应答的，不认');
  check(checkCassette(withSteps([a, b], { exempt: exempt({ class: 'normal', shown_by: 's/b', why: '退役的路由，一律回 4xx' }) }), known).length === 0 && checkCassette(withSteps([a, b, c], { exempt: exempt({ class: 'normal', shown_by: 's/c', why: 'x' }) }), known).some((p) => p.includes('shown_by') || p.includes('多余')), '豁免：退役的路由可以豁免正常这一类（指给一条不照常应答的请求）；有正常请求的不行');
  check(checkCassette(withSteps([a, b, c], { exempt: exempt({ class: 'weird' }) }), known).some((p) => p.includes('class 只能是')), '豁免：class 写错，不认');
  check(checkCassette(withSteps([a, b, c], { exempt: exempt() }), known).some((p) => p.includes('多余')), '豁免：这条路由其实有这一类的请求，豁免是多余的，失败');
  check(coverage(open).join() === 'GET /api/x：未授权 1，参数非法 豁免，正常 1' && coverage(full).join() === 'GET /api/x：未授权 1，参数非法 1，正常 1', '覆盖：每条路由三类各几条，豁免的写豁免');
  check(fill({ path: '/api/x/{{id}}', n: [1, '{{id}}'] }, { id: 7 }).path === '/api/x/7' && fill(['{{id}}'], { id: 7 })[0] === '7', '变量：路径和请求体里都能代入');
  let threw = false; try { fill('/api/x/{{nope}}', {}); } catch { threw = true; }
  check(threw, '变量：没存过的变量直接报错');
  check(steady({ at: '2026-01-02 03:04:05', n: 1 }).at === 'YYYY-MM-DD hh:mm:ss' && steady({ at: '2026-01-02 03:04:05', n: 1 }).n === 1 && steady('x 2026-01-02T03:04:05.678Z y') === 'x YYYY-MM-DDThh:mm:ss.fffZ y', '整理：只把时间里的数字换成占位，别的原样');
  const stamps = ['2026-01-02 03:04:05', '2026-01-02T03:04:05', '2026-01-02T03:04:05Z', '2026-01-02T03:04:05.6Z', '2026-01-02T03:04:05.678Z'];
  check(new Set(stamps.map(steady)).size === stamps.length && stamps.every((t) => steady(t).length === t.length) && steady('2026-01-02 03:04:05') === steady('1999-12-31 23:59:59'), '整理：时间的写法不同，占位也不同（空格还是 T、小数秒几位、带不带 Z）；写法相同的两个时间占位相同；长度不变');
  const heads = { 'set-cookie': ['sid=abc; HttpOnly', 'theme=dark'], vary: 'Origin' };
  const body = { a: 1, list: [{ k: 'v' }] };
  const recorded = { response: { status: 200, type: 'application/json', headers: heads, body } };
  const answer = (over = {}) => ({ status: 200, type: 'application/json', headers: heads, body, ...over });
  check(compareStep(recorded, answer()).length === 0, '比较：一样就是零差异');
  check(compareStep(recorded, answer({ status: 500 })).join().includes('200 → 500'), '比较：状态码变了，报出来');
  check(compareStep(recorded, answer({ body: { a: 1, list: [{ k: 'w' }] } })).join().includes('响应体.list[0].k'), '比较：响应体变了，报到字段');
  check(compareStep(recorded, answer({ body: { ...body, extra: true } })).join().includes('响应体.extra'), '比较：多了字段，报出来');
  check(compareStep(recorded, answer({ type: 'text/html' })).join().includes('内容类型'), '比较：内容类型变了，报出来');
  check(compareStep({ response: { status: 200, type: 'a', headers: {}, body: { a: 1, b: 2 } } }, { status: 200, type: 'a', headers: {}, body: { b: 2, a: 1 } }).join().includes('顺序'), '比较：字段顺序变了，报出来');
  check(compareStep({ ...recorded, compare: 'status' }, { status: 200, type: 'x', body: 'y' }).length === 0, '比较：只比状态码的请求不看响应头和响应体');
  const hv = { vary: { '$header:x-package-sha256': 'random', '$header:content-length': 'random' } };
  const hvRec = { ...hv, response: shapeOf(hv, answer({ headers: { ...heads, 'x-package-sha256': 'a'.repeat(64), 'content-length': '4134' } })) };
  check(compareStep(hvRec, shapeOf(hv, answer({ headers: { ...heads, 'x-package-sha256': 'b'.repeat(64), 'content-length': '4135' } }))).length === 0 && compareStep(hvRec, shapeOf(hv, answer({ headers: { ...heads, 'x-package-sha256': 'b'.repeat(63), 'content-length': '4135' } }))).join().includes('x-package-sha256') && compareStep(hvRec, shapeOf(hv, answer({ headers: { ...heads, 'content-length': '4135' } }))).join().includes('x-package-sha256') && compareStep(hvRec, shapeOf(hv, answer({ headers: { ...heads, vary: 'Cookie', 'x-package-sha256': 'b'.repeat(64), 'content-length': '4135' } }))).join().includes('响应头.vary'), 'vary：响应头点名的值只比类型和长度；长度变了、头没了、别的头变了都算差异');
  check(checkCassette(withSteps([a, b, c, { id: 'v', vary: { '$header:X-Big': 'random' }, request: { method: 'GET', path: '/api/x' } }]), known).some((p) => p.includes('vary')) && checkCassette(withSteps([a, b, c, { id: 'v', vary: { '$header:etag': 7 }, request: { method: 'GET', path: '/api/x' } }]), known).some((p) => p.includes('vary')), 'vary：响应头只收小写头名和 random，写错了静态检查拦下');
  // 打包的应答体：自己拼一个 tar（头块写名字、大小、修改时刻、校验和），看规范化之后什么算差异
  const mkTar = (files, mtime) => {
    const parts = [];
    for (const f of files) {
      const h = Buffer.alloc(512, 0); const body = Buffer.from(f.content);
      h.write(f.path, 0); h.write('0000644\0', 100); h.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
      h.write(mtime.toString(8).padStart(11, '0') + '\0', 136); h.write(' '.repeat(8), 148); h.write('0', 156); h.write('ustar\0', 257);
      let sum = 0; for (const x of h) sum += x; h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
      parts.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512, 0));
    }
    parts.push(Buffer.alloc(1024, 0)); return Buffer.concat(parts);
  };
  const FILES = [{ path: 'demo/SKILL.md', content: '# demo\n' }, { path: 'demo/run.sh', content: 'echo hi\n' }];
  const t1 = archiveBody('application/x-tar', mkTar(FILES, 1000)), t2 = archiveBody('application/x-tar', mkTar(FILES, 2000));
  const tByte = archiveBody('application/x-tar', mkTar([FILES[0], { ...FILES[1], content: 'echo ho\n' }], 1000));
  const tPath = archiveBody('application/x-tar', mkTar([{ ...FILES[0], path: 'ns:demo/SKILL.md' }, FILES[1]], 1000));
  const g1 = archiveBody('application/gzip', (await import('node:zlib')).gzipSync(mkTar(FILES, 1000))), g2 = archiveBody('application/gzip', (await import('node:zlib')).gzipSync(mkTar(FILES, 3000), { level: 1 }));
  check(JSON.stringify(t1) === JSON.stringify(t2) && t1.entries.length === 2 && t1.entries[0].path === 'demo/SKILL.md' && t1.entries[0].size === 7, '打包的应答体：只有 tar 头里的修改时刻不同（校验和跟着变），规范化之后一样');
  check(t1.normalized_sha256 !== tByte.normalized_sha256 && t1.entries[1].sha256 !== tByte.entries[1].sha256 && t1.normalized_sha256 !== tPath.normalized_sha256 && t1.entries[0].path !== tPath.entries[0].path, '打包的应答体：一个文件改一个字节、条目的路径（目录前缀）变了，都算差异');
  check(JSON.stringify(g1.entries) === JSON.stringify(t1.entries) && g1.normalized_sha256 === t1.normalized_sha256 && g1.archive === 'tar.gz' && JSON.stringify(g1.entries) === JSON.stringify(g2.entries) && g1.normalized_sha256 === g2.normalized_sha256, '打包的应答体：tar.gz 先解压再规范化；压缩级别、里面的时刻不同照样一样');
  const meta = (at) => [{ path: 'demo/.wm-skill.json', content: JSON.stringify({ published_at: at, v: 1 }) }, FILES[1]];
  const m1 = archiveBody('application/x-tar', mkTar(meta('2026-11-11 07:00:01'), 1000)), m2 = archiveBody('application/x-tar', mkTar(meta('2026-11-11 07:00:59'), 1000)), m3 = archiveBody('application/x-tar', mkTar([{ ...meta('2026-11-11 07:00:01')[0], content: JSON.stringify({ published_at: '2026-11-11 07:00:01', v: 2 }) }, FILES[1]], 1000));
  check(JSON.stringify(m1) === JSON.stringify(m2) && m1.entries[0].sha256 !== m3.entries[0].sha256 && m1.normalized_sha256 !== m3.normalized_sha256, '打包的应答体：文本条目里的时间换成占位（发布时刻不同算一样），别的字变了照样算差异');
  check(archiveBody('application/json', Buffer.from('{}')) === null && archiveBody('text/plain', Buffer.from('x')) === null && archiveBody('application/gzip', Buffer.from('不是 gzip')).error, '打包的应答体：别的内容类型不管；说是 gzip 却解不开，记下来（照样比）');
  check(compareStep({}, answer()).join().includes('还没录过'), '比较：没录过的请求算差异');
  // verify
  await loadVerifiers(['a2a-card']);
  const { generateKeyPairSync } = await import('node:crypto');
  const require2 = createRequire(join(ROOT, 'server', 'package.json'));
  const { signCard } = await import(pathToFileURL(require2.resolve('@nelsonlongxiang/dsh-open-a2a-net/card')).href);
  const signed = signCard({ capabilities: {}, expiresAt: Date.now() + 3600000, name: 'n', session: 's', team: 't' }, generateKeyPairSync('ed25519').privateKey);
  const vs = { verify: 'a2a-card', vary: { publicKey: 'random', signature: 'random' } };
  const good = shapeOf(vs, { status: 200, type: 'a', headers: {}, body: signed });
  const sig = String(signed.signature); const tampered = sig.slice(0, -2) + (sig.at(-2) === 'A' ? 'B' : 'A') + sig.at(-1);
  const bad = shapeOf(vs, { status: 200, type: 'a', headers: {}, body: { ...signed, signature: tampered } });
  const otherField = shapeOf(vs, { status: 200, type: 'a', headers: {}, body: { ...signed, name: 'x' } });
  check(good.verified['a2a-card'] === true && bad.verified['a2a-card'] === false && otherField.verified['a2a-card'] === false && bad.body.signature === good.body.signature, 'verify：签名对就是 true；换成等长的另一串、或者改了签进去的字段，都是 false（vary 之后看不出来的，这里看得出来）');
  check(compareStep({ ...vs, response: good }, bad).join().includes('验') && compareStep({ ...vs, response: good }, good).length === 0, 'verify：验的结果变了算差异');
  check(checkCassette(withSteps([a, b, c, { id: 'v', verify: 'nope', request: { method: 'GET', path: '/api/x' } }]), known).some((p) => p.includes('verify')), 'verify：没有的验法，静态检查拦下');
  // vary
  const card = { publicKey: 'abcd', signature: 'xyz12', expiresAt: 1893456123456, name: 'm', nested: { k: 'q' } };
  const varied = applyVary(card, { publicKey: 'random', signature: 'random', expiresAt: 60000, 'nested.k': 'random', gone: 'random' });
  check(varied.publicKey === '<每个实例随机·string·4>' && varied.signature === '<每个实例随机·string·5>' && varied.expiresAt === 1893456120000 && varied.name === 'm' && varied.nested.k === '<每个实例随机·string·1>' && !('gone' in varied) && card.publicKey === 'abcd', 'vary：随机的值换成占位、留类型和长度；带毫秒的数往下取整；别的字段不动；不改原对象');
  const html = '<meta name="t" content="' + 'a'.repeat(64) + '"><script>x="' + 'b'.repeat(64) + '";y="' + 'c'.repeat(65) + '";</script>';
  const maskedHtml = applyVary(html, { $text: 'hex64' });
  check(maskedHtml === '<meta name="t" content="<每个实例随机·hex64>"><script>x="<每个实例随机·hex64>";y="' + 'c'.repeat(65) + '";</script>' && applyVary(html, { other: 'random' }) === html && compareStep({ response: steadyResponse({ status: 200, type: 'text/html', headers: {}, body: maskedHtml }) }, shapeOf({ vary: { $text: 'hex64' } }, { status: 200, type: 'text/html', headers: {}, body: html.replace('a'.repeat(64), 'd'.repeat(64)) })).length === 0 && compareStep({ response: steadyResponse({ status: 200, type: 'text/html', headers: {}, body: maskedHtml }) }, shapeOf({ vary: { $text: 'hex64' } }, { status: 200, type: 'text/html', headers: {}, body: html.replace('x=', 'z=') })).length === 1, 'vary：文本应答体里独立的 64 位十六进制换成占位（65 位的不动）；令牌换了不算差异，别的字变了算');
  check(checkCassette(withSteps([a, b, c, { id: 'v', vary: { $text: 'random' }, request: { method: 'GET', path: '/api/x' } }]), known).some((p) => p.includes('vary')), 'vary：$text 只收 hex64，写错了静态检查拦下');
  const vstep = { vary: { signature: 'random' } };
  const vrec = { ...vstep, response: shapeOf(vstep, { status: 200, type: 'a', headers: {}, body: { signature: 'aaaa', name: 'm' } }) };
  check(compareStep(vrec, shapeOf(vstep, { status: 200, type: 'a', headers: {}, body: { signature: 'bbbb', name: 'm' } })).length === 0 && compareStep(vrec, shapeOf(vstep, { status: 200, type: 'a', headers: {}, body: { signature: 'bbbbb', name: 'm' } })).length === 1 && compareStep(vrec, shapeOf(vstep, { status: 200, type: 'a', headers: {}, body: { name: 'm' } })).length === 1 && compareStep(vrec, shapeOf(vstep, { status: 200, type: 'a', headers: {}, body: { signature: 'bbbb', name: 'n' } })).length === 1, 'vary：随机字段换了值不算差异；长度变了、字段没了、别的字段变了都算');
  check(checkCassette(withSteps([a, b, c, { id: 'v', vary: { x: 'sometimes' }, request: { method: 'GET', path: '/api/x' } }]), known).some((p) => p.includes('vary')) && checkCassette(withSteps([a, b, c, { id: 'v', vary: [], request: { method: 'GET', path: '/api/x' } }]), known).some((p) => p.includes('vary')), 'vary：写得不对，静态检查拦下');
  // $location、$cookies：只遮点名的那几个字节
  const loc = 'http://127.0.0.1:61234/authorize?client_id=c1&redirect_uri=http%3A%2F%2F127.0.0.1%3A61200%2Fcb&state=abcdefgh';
  const lv = { $location: ['port', 'query:state'], $cookies: { st: ['value', 'max-age'], sess: ['value'] } };
  const hraw = (o = {}) => ({ status: 302, type: 'text/plain', selfPort: o.selfPort ?? '61200', headers: { location: o.location ?? loc, 'set-cookie': o.cookies ?? ['st=AAAA; Max-Age=599; Path=/cb; HttpOnly; SameSite=Lax', 'sess=BBBBBB; Max-Age=43200; Path=/; HttpOnly; SameSite=Lax', 'other=x; Path=/'] }, body: `Found. Redirecting to ${o.location ?? loc}` });
  const ls = { vary: lv };
  const hrec = { ...ls, response: shapeOf(ls, hraw()) };
  check(hrec.response.headers.location === 'http://127.0.0.1:<别的端口>/authorize?client_id=c1&redirect_uri=http%3A%2F%2F127.0.0.1%3A<市场端口>%2Fcb&state=<每个实例随机·8>' && hrec.response.body.endsWith('state=<每个实例随机·8>')
    && hrec.response.headers['set-cookie'][0] === 'st=<每个实例随机·4>; Max-Age=<约10分>; Path=/cb; HttpOnly; SameSite=Lax' && hrec.response.headers['set-cookie'][1] === 'sess=<每个实例随机·6>; Max-Age=43200; Path=/; HttpOnly; SameSite=Lax' && hrec.response.headers['set-cookie'][2] === 'other=x; Path=/',
    '$location、$cookies：端口分市场自己的和别的、state、cookie 的值换成占位，点名的 Max-Age 按分钟取整，别的原样');
  const same = hraw({ selfPort: '5001', location: loc.replace('61234', '5000').replace('61200', '5001').replace('abcdefgh', 'zyxwvuts'), cookies: ['st=CCCC; Max-Age=600; Path=/cb; HttpOnly; SameSite=Lax', 'sess=DDDDDD; Max-Age=43200; Path=/; HttpOnly; SameSite=Lax', 'other=x; Path=/'] });
  check(compareStep(hrec, shapeOf(ls, same)).length === 0, '$location、$cookies：只是端口号、随机值变了，Max-Age 差一秒（599/600）：零差异');
  const redHeaders = {
    '跳转到别的路径': hraw({ location: loc.replace('/authorize', '/elsewhere') }),
    '跳转到别的主机': hraw({ location: loc.replace('127.0.0.1:61234', 'evil.invalid') }),
    '别的参数变了': hraw({ location: loc.replace('client_id=c1', 'client_id=c2') }),
    '去掉 HttpOnly': hraw({ cookies: ['st=AAAA; Max-Age=599; Path=/cb; SameSite=Lax', 'sess=BBBBBB; Max-Age=43200; Path=/; HttpOnly; SameSite=Lax', 'other=x; Path=/'] }),
    '去掉 SameSite': hraw({ cookies: ['st=AAAA; Max-Age=599; Path=/cb; HttpOnly; SameSite=Lax', 'sess=BBBBBB; Max-Age=43200; Path=/; HttpOnly', 'other=x; Path=/'] }),
    '换 cookie 名': hraw({ cookies: ['st2=AAAA; Max-Age=599; Path=/cb; HttpOnly; SameSite=Lax', 'sess=BBBBBB; Max-Age=43200; Path=/; HttpOnly; SameSite=Lax', 'other=x; Path=/'] }),
    '没有 Max-Age 了': hraw({ cookies: ['st=AAAA; Path=/cb; HttpOnly; SameSite=Lax', 'sess=BBBBBB; Max-Age=43200; Path=/; HttpOnly; SameSite=Lax', 'other=x; Path=/'] }),
    '没点名的 Max-Age 变了': hraw({ cookies: ['st=AAAA; Max-Age=599; Path=/cb; HttpOnly; SameSite=Lax', 'sess=BBBBBB; Max-Age=60; Path=/; HttpOnly; SameSite=Lax', 'other=x; Path=/'] }),
    '回调地址写死成别的端口': hraw({ location: loc.replace('127.0.0.1%3A61200', '127.0.0.1%3A61999') }),
    'Max-Age 从 10 分钟变成一小时': hraw({ cookies: ['st=AAAA; Max-Age=3599; Path=/cb; HttpOnly; SameSite=Lax', 'sess=BBBBBB; Max-Age=43200; Path=/; HttpOnly; SameSite=Lax', 'other=x; Path=/'] }),
    '值的长度变了': hraw({ cookies: ['st=AAAAA; Max-Age=599; Path=/cb; HttpOnly; SameSite=Lax', 'sess=BBBBBB; Max-Age=43200; Path=/; HttpOnly; SameSite=Lax', 'other=x; Path=/'] }),
  };
  const silent = Object.entries(redHeaders).filter(([, r]) => compareStep(hrec, shapeOf(ls, r)).length === 0).map(([k]) => k);
  check(silent.length === 0, `$location、$cookies：跳转落点、别的参数、cookie 名和属性、值的长度变了都报出来（${Object.keys(redHeaders).length} 种）`);
  check(checkCassette(withSteps([a, b, c, { id: 'v', vary: { $location: ['host'] }, request: { method: 'GET', path: '/api/x' } }]), known).some((p) => p.includes('vary'))
    && checkCassette(withSteps([a, b, c, { id: 'v', vary: { $cookies: { st: ['httponly'] } }, request: { method: 'GET', path: '/api/x' } }]), known).some((p) => p.includes('vary'))
    && !checkCassette(withSteps([a, b, c, { id: 'v', vary: lv, request: { method: 'GET', path: '/api/x' } }]), known).some((p) => p.includes('vary')),
    '$location 只收 port 和 query:<名>，$cookies 只收 value 和 max-age，写别的静态检查就拦');
  // 只比点名的字段
  const wb = { id: 2, name: '台', cookie_set_id: 0, last_status: 'unknown', nested: { at: '2026-01-02 03:04:05' } };
  const picking = { compare: ['cookie_set_id', 'nested.at', 'gone'] };
  const pickedNow = shapeOf(picking, { status: 200, type: 'application/json', headers: {}, body: wb });
  check(JSON.stringify(pickedNow) === JSON.stringify({ status: 200, picked: { cookie_set_id: 0, 'nested.at': 'YYYY-MM-DD hh:mm:ss' } }), '点名的字段：只录状态码和点名的字段；带点的路径往里取；时间照样换占位；没有的字段不录');
  const pickedStep = { ...picking, response: JSON.parse(JSON.stringify(pickedNow)) };
  check(compareStep(pickedStep, shapeOf(picking, { status: 200, body: { ...wb, last_status: 'down', name: '改了' } })).length === 0, '点名的字段：没点名的字段变了不算差异');
  check(compareStep(pickedStep, shapeOf(picking, { status: 200, body: { ...wb, cookie_set_id: 7 } })).join().includes('点名的字段.cookie_set_id') && compareStep(pickedStep, shapeOf(picking, { status: 404, body: wb })).join().includes('200 → 404') && compareStep(pickedStep, shapeOf(picking, { status: 200, body: { ...wb, gone: 1 } })).join().includes('点名的字段.gone'), '点名的字段：点名的字段变了、状态码变了、原来没有的字段冒出来了，都算差异');
  check(checkCassette(withSteps([a, b, c, { id: 'p', compare: [], request: { method: 'GET', path: '/api/other' } }]), known).some((p) => p.includes('compare')) && checkCassette(withSteps([a, b, c, { id: 'p', compare: 'body', request: { method: 'GET', path: '/api/other' } }]), known).some((p) => p.includes('compare')), '点名的字段：compare 写得不对，静态检查拦下');
  // 响应头
  check(compareStep(recorded, answer({ headers: { ...heads, vary: 'Origin, Cookie' } })).join().includes('响应头.vary'), '比较：响应头的值变了，报到哪个头');
  check(compareStep(recorded, answer({ headers: { 'set-cookie': heads['set-cookie'] } })).join().includes('响应头.vary') && compareStep(recorded, answer({ headers: { ...heads, location: '/login' } })).join().includes('响应头.location'), '比较：少了一个头、多了一个头，都报出来');
  check(compareStep(recorded, answer({ headers: { ...heads, 'set-cookie': ['sid=abc; HttpOnly', 'theme=light'] } })).join().includes('响应头.set-cookie[1]') && compareStep(recorded, answer({ headers: { ...heads, 'set-cookie': ['sid=abc; HttpOnly'] } })).join().includes('响应头.set-cookie[1]'), '比较：Set-Cookie 一条一条比，改了一条、少了一条都报出来');
  check(compareStep({ response: { status: 200, type: 'application/json', body } }, answer()).join().includes('没有响应头'), '比较：录制里没有响应头，算差异');
  const tidy = steadyHeaders({ 'x-powered-by': 'Express', date: 'Tue, 10 Nov 2026 20:02:56 GMT', connection: 'keep-alive', 'keep-alive': 'timeout=5', etag: 'W/"83e-NgDEcHvAZzNtVqpIBxcCIGdU4Fc"', expires: 'Wed, 21 Oct 2026 07:28:00 GMT', 'set-cookie': ['sid=abc; Expires=Wed, 21 Oct 2026 07:28:00 GMT; HttpOnly', 'theme=dark'], 'content-length': '2110' });
  check(Object.keys(tidy).join() === 'content-length,etag,expires,set-cookie,x-powered-by', '整理响应头：Date、Connection、Keep-Alive 不要，其余按名字排好');
  check(tidy.etag === 'W/"83e-<指纹>"' && steadyHeaders({ etag: '"1a2b-19c0ffee"' }).etag === '"1a2b-<指纹>"' && steadyHeaders({ etag: '"0123abcd"' }).etag === '"0123abcd"', '整理响应头：按内容算的 ETag 只留长度；别的写法的 ETag 原样比');
  check(tidy.expires === '<时间>' && tidy['set-cookie'][0] === 'sid=abc; Expires=<时间>; HttpOnly' && tidy['set-cookie'][1] === 'theme=dark' && tidy['content-length'] === '2110', '整理响应头：时间换成占位，别的原样');
  // 发请求的那一段是真的：起一个只在回环上听的小服务，看 3xx、Set-Cookie、内容类型各录成什么
  const wire = createServer((req, res) => {
    if (req.url === '/moved') { res.setHeader('Set-Cookie', ['sid=abc; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT; HttpOnly', 'theme=dark; Path=/']); res.writeHead(302, { Location: '/landing', 'Cache-Control': 'no-store' }); res.end(); return; }
    if (req.url === '/landing') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('followed'); return; }
    if (req.url.startsWith('/echo/')) { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ url: req.url, x: req.headers['x-echo'] ?? null })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ETag: 'W/"2f-AAAAAAAAAAAAAAAAAAAAAAAAAAA"' });
    res.end(JSON.stringify({ at: '2026-01-02 03:04:05', echo: req.headers['x-echo'] ?? null }));
  });
  await new Promise((r) => wire.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${wire.address().port}`;
    const moved = steadyResponse(await send(base, { method: 'GET', path: '/moved' }, {}));
    check(moved.status === 302 && moved.headers.location === '/landing' && moved.body === '', '发请求：不跟着跳转走，录下 3xx 和它的 Location');
    check(moved.headers['set-cookie']?.length === 2 && moved.headers['set-cookie'][0] === 'sid=abc; Path=/; Expires=<时间>; HttpOnly' && moved.headers['set-cookie'][1] === 'theme=dark; Path=/' && moved.headers['cache-control'] === 'no-store', '发请求：两条 Set-Cookie 各录一条，Cache-Control 原样录下');
    const json = steadyResponse(await send(base, { method: 'GET', path: '/json', headers: { 'x-echo': '{{v}}' } }, { v: 'hi' }));
    check(json.type === 'application/json; charset=utf-8' && !('content-type' in json.headers) && !('date' in json.headers) && !('connection' in json.headers), '发请求：内容类型记在 type 里；Date、Connection 不录');
    check(json.headers.etag === 'W/"2f-<指纹>"' && json.body.at === 'YYYY-MM-DD hh:mm:ss' && json.body.echo === 'hi', '发请求：请求头里的变量代入了；应答里的时间和 ETag 的后半段换成了占位');
    const odd = '/echo/a/../b/%2e%2e/c%2f..%2fd/..\\e//f';
    const viaFetch = await send(base, { method: 'GET', path: odd }, {});
    const viaRaw = await send(base, { method: 'GET', path: odd, raw: true, headers: { 'x-echo': '{{v}}' } }, { v: 'hi' });
    check(viaFetch.body.url !== odd && viaRaw.body.url === odd && viaRaw.body.x === 'hi' && viaRaw.status === 200 && viaRaw.type === 'application/json; charset=utf-8' && !('content-type' in viaRaw.headers), '原样发路径：fetch 把 ..、%2e%2e、反斜杠规范掉了，raw 一个字不改地发到服务端；请求头的变量照样代入，应答整理成同样的形状');
    const rawMoved = steadyResponse(await send(base, { method: 'GET', path: '/moved', raw: true }, {}));
    check(rawMoved.status === 302 && rawMoved.headers.location === '/landing' && rawMoved.headers['set-cookie']?.length === 2 && rawMoved.headers['set-cookie'][0] === 'sid=abc; Path=/; Expires=<时间>; HttpOnly', '原样发路径：不跟跳转，Set-Cookie 一条一条录');
  } finally { wire.closeAllConnections(); wire.close(); }
  check(checkCassette(withSteps([a, b, c, { id: 'r', request: { method: 'GET', path: '/api/x', raw: 'yes' } }]), known).some((p) => p.includes('raw')) && checkCassette(withSteps([a, b, c, { id: 'r', request: { method: 'GET', path: '/api/x', raw: true } }]), known).length === 0, '原样发路径：raw 只收 true，写别的静态检查拦下');
  const sample = { a: [{ id: 1, name: 'x' }], b: {}, c: [] };
  check(JSON.stringify(JSON.parse(render(sample))) === JSON.stringify(sample), '写文件：写出来的是同一份 JSON');
  // 整条链路，发请求的一段换成假的：建一个、读它、读一个不存在的
  const fake = (created) => async (request, vars) => {
    const path = fill(request.path, vars);
    if (request.method === 'POST') return { status: 201, type: 'application/json', body: created };
    return path === '/api/x/7' ? { status: 200, type: 'application/json', body: { id: 7, at: '2026-01-02 03:04:05' } } : { status: 404, type: 'application/json', body: { error: 'not found' } };
  };
  const steps = () => [
    { id: 'create', request: { method: 'POST', path: '/api/x' }, save: { id: 'id' } },
    { id: 'read', request: { method: 'GET', path: '/api/x/{{id}}' } },
    { id: 'missing', request: { method: 'GET', path: '/api/x/8' } },
  ];
  const tape = steps();
  await runSteps(tape, fake({ id: 7 }), true);
  check(tape.every((s) => s.response) && tape[1].response.body.at === 'YYYY-MM-DD hh:mm:ss' && tape[2].response.status === 404, '录制：每条请求都写进了应答，时间已换成占位');
  check((await runSteps(tape, fake({ id: 7 }))).every((r) => r.diffs.length === 0), '回放：行为没变，零差异');
  const moved = await runSteps(tape, fake({ id: 8 }));
  check(moved.filter((r) => r.diffs.length).map((r) => r.step.id).join() === 'create,read', '回放：行为变了，变了的那几条报出来，没变的不报');
  const lost = await runSteps(tape, fake({}));
  check(lost[1].diffs.join().includes('没存过的变量') && lost[2].diffs.length === 0, '回放：前一条没给出要存的值，用到它的那条算差异，后面的照跑');
  let refused = ''; try { await runSteps(steps(), fake({}), true); } catch (e) { refused = e.message; }
  check(refused.includes('create') && refused.includes('取不到'), '录制：要存的值没取到，直接报错，不写出半份录制');
  // 起实例时端口被占
  const starter = (failures, busy) => { let calls = 0; return Object.assign(async () => { calls++; if (calls <= failures) throw Object.assign(new Error('没起来'), { portBusy: busy }); return 'up'; }, { calls: () => calls }); };
  const notes = [];
  const twice = starter(2, true);
  check(await withPortRetry(twice, 3, (line) => notes.push(line)) === 'up' && twice.calls() === 3 && notes.length === 2, '起实例：端口被占就换一个再起，第三次起来了');
  const always = starter(9, true);
  let gaveUp = false; try { await withPortRetry(always, 3, () => {}); } catch { gaveUp = true; }
  check(gaveUp && always.calls() === 3, '起实例：三次都被占，报错，不再试');
  const broken = starter(9, false);
  let failedFast = false; try { await withPortRetry(broken, 3, () => {}); } catch { failedFast = true; }
  check(failedFast && broken.calls() === 1, '起实例：别的原因起不来，不重试，直接报');
  // 场景定时钟
  const plain = launchPlan(undefined), timed = launchPlan('2030-01-01T00:00:00Z');
  let badClock = false; try { launchPlan('tomorrow'); } catch { badClock = true; }
  const faked = launchPlan(undefined, ['identity-fake']); const both = launchPlan('2030-01-01T00:00:00Z', ['identity-fake']);
  let badFixture = false; try { launchPlan(undefined, ['nope']); } catch { badFixture = true; }
  check(faked.args.filter((x) => x === '--import').length === 1 && faked.env.IDENTITY_SEAM_ROOT === ROOT && both.args.filter((x) => x === '--import').length === 2 && both.args.at(-1) === 'src/index.ts' && badFixture && checkCassette(withSteps([a, b, c], { scenarios: [{ name: 's', fixtures: ['nope'], steps: [a, b, c] }] }), known).some((p) => p.includes('fixtures')), '夹具：场景可以带上假的登录提供方，和定时钟一起用；没有的夹具名起不来，静态检查也拦下');
  check(!plain.args.includes('--import') && Object.keys(plain.env).length === 0 && timed.args.includes('--import') && timed.args.at(-1) === 'src/index.ts' && timed.env.WM_REPLAY_CLOCK === '2030-01-01T00:00:00Z' && badClock, '定时钟：场景没写 clock 就照常起；写了才带上预加载；写得不是时刻直接报错');
  check(checkCassette(withSteps([a, b, c], { scenarios: [{ name: 's', clock: 'tomorrow', steps: [a, b, c] }] }), known).some((p) => p.includes('clock')) && checkCassette(withSteps([a, b, c], { scenarios: [{ name: 's', clock: '2030-01-01T00:00:00Z', steps: [a, b, c] }] }), known).length === 0, '定时钟：请求集里 clock 写得不对，静态检查就拦下');
  const probe = 'const t = Date.now(); console.log(JSON.stringify([new Date(t).toISOString().slice(0, 16), new Date().toISOString().slice(0, 16), Date().slice(0, 21) === new Date(t).toString().slice(0, 21), new Date(0).toISOString(), new Date() instanceof Date, new Date().constructor === Date]))';
  const shifted = spawnSync(process.execPath, ['--import', pathToFileURL(CLOCK_PRELOAD).href, '-e', probe], { env: { PATH: process.env.PATH, NODE_ENV: 'test', WM_REPLAY_CLOCK: '2030-01-01T00:00:00Z' }, encoding: 'utf8' });
  check(shifted.status === 0 && shifted.stdout.trim() === JSON.stringify(['2030-01-01T00:00', '2030-01-01T00:00', true, '1970-01-01T00:00:00.000Z', true, true]), `定时钟：Date.now()、new Date()、Date() 都从给的时刻开始走；带参数的 new Date(x) 照旧 ${shifted.stdout.trim()}${shifted.stderr.trim()}`);
  const refusedOutsideTest = spawnSync(process.execPath, ['--import', pathToFileURL(CLOCK_PRELOAD).href, '-e', 'console.log(1)'], { env: { PATH: process.env.PATH, NODE_ENV: 'production', WM_REPLAY_CLOCK: '2030-01-01T00:00:00Z' }, encoding: 'utf8' });
  const refusedBadClock = spawnSync(process.execPath, ['--import', pathToFileURL(CLOCK_PRELOAD).href, '-e', 'console.log(1)'], { env: { PATH: process.env.PATH, NODE_ENV: 'test' }, encoding: 'utf8' });
  check(refusedOutsideTest.status === 1 && refusedOutsideTest.stdout === '' && refusedBadClock.status === 1 && refusedBadClock.stdout === '', '定时钟：不是测试环境、或者没给时刻，预加载让进程直接退出，不带着假的时钟起来');
  console.log(failed ? `===== 录制回放自检：${failed} 项失败 =====` : '===== 录制回放自检：全过 =====');
  return failed ? 1 : 0;
}

// ---------- 主流程 ----------

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) return selftest();
  const record = argv.includes('--record');
  const only = argv.find((a) => !a.startsWith('--'));
  const cassettes = loadCassettes(only);
  if (only && cassettes.length === 0) { console.error(`没有 surfaces/replay/${only}.json`); return 2; }

  // 先做静态检查：请求集不合要求，回放结果就不算数。开录之前只查结构（应答马上要重录），录完再按新的应答查一遍
  const known = snapshotRoutes(JSON.parse(readFileSync(ROUTES_SNAPSHOT, 'utf8')));
  const problems = [];
  for (const { domain, cassette } of cassettes) for (const p of checkCassette(cassette, known, moduleRouteCount(domain), !record)) problems.push(`surfaces/replay/${domain}.json：${p}`);
  if (!only && existsSync(MODULES_DIR)) {
    for (const name of readdirSync(MODULES_DIR).filter((n) => n.endsWith('.ts')).sort()) {
      if (!cassettes.some((c) => c.domain === name.replace(/\.ts$/, ''))) problems.push(`server/src/routes/${name} 没有对应的 surfaces/replay/${name.replace(/\.ts$/, '.json')}`);
    }
  }
  if (problems.length) { for (const p of problems) console.error(`✗ ${p}`); console.error(`\n请求集不合要求，没有${record ? '录制' : '回放'}。`); return 1; }

  await loadVerifiers([...new Set(cassettes.flatMap(({ cassette }) => cassette.scenarios.flatMap((sc) => sc.steps.map((st) => st.verify).filter(Boolean))))]);
  let total = 0, changed = 0, refused = 0;
  for (const { file, domain, cassette } of cassettes) {
    if (!record) {
      // 豁免总是打印出来：它是「这条路由没有这一类」的声明，要一直看得见
      for (const item of cassette.exempt ?? []) console.log(`（豁免）${domain}：${item.route} 没有「${CLASS_NAME[item.class]}」——${item.why}（见 ${item.shown_by}）`);
      if (only) for (const line of coverage(cassette)) console.log(`（覆盖，按录下来的应答算）${line}`);
    }
    for (const scenario of cassette.scenarios) {
      const instance = await boot(`${domain}-${scenario.name}`, scenario.env ?? {}, scenario.clock, scenario.fixtures ?? []);
      let results;
      try { seedInstance(instance.data, scenario.seed); results = await runSteps(scenario.steps, (request, vars) => send(instance.base, request, vars).then((r) => ({ ...r, selfPort: new URL(instance.base).port })), record); }
      catch (err) { throw new Error(`${domain}/${scenario.name}/${err.message}`); }
      finally { await instance.stop(); }
      total += results.length;
      let diffs = 0;
      for (const { step, diffs: d } of results) {
        if (d.length === 0) continue;
        diffs++;
        console.log(`\n✗ ${domain}/${scenario.name}/${step.id}  ${step.request.method} ${step.request.path}`);
        for (const line of d.slice(0, 12)) console.log(`    ${line}`);
        if (d.length > 12) console.log(`    …共 ${d.length} 处`);
      }
      changed += diffs;
      if (!record) console.log(`${diffs ? '✗' : '✓'} ${domain}/${scenario.name}：${scenario.steps.length} 条请求，${diffs ? `${diffs} 条和录下来的不一样` : '和录下来的一样'}`);
    }
    if (record) {
      // 录完按新的应答再查一遍：标的类别和应答对不上，或者哪条路由缺一类，就不写文件
      const after = checkCassette(cassette, known, moduleRouteCount(domain));
      if (after.length) {
        refused++;
        for (const p of after) console.error(`✗ surfaces/replay/${domain}.json：${p}`);
        console.error(`\n${domain}：录下来的应答和请求集对不上，没有写文件。改请求集里标的类别（或者补请求、写豁免），再录。`);
        continue;
      }
      writeFileSync(file, `${render(canonical(cassette))}\n`);
      console.log(`已录制 surfaces/replay/${domain}.json：${cassette.scenarios.reduce((n, s) => n + s.steps.length, 0)} 条请求`);
      for (const line of coverage(cassette)) console.log(`  ${line}`);
    }
  }
  if (record) return refused ? 1 : 0;
  console.log(changed ? `\n===== 录制回放：${total} 条请求，${changed} 条有差异 =====\n行为变了。确认是有意的，就跑 node scripts/route-replay-test.mjs --record，把录制和代码一起提交。`
    : `===== 录制回放：${cassettes.length} 个域、${total} 条请求，零差异 =====`);
  return changed ? 1 : 0;
}

main().then((code) => process.exit(code), (err) => { console.error(`[route-replay] ${err.message}`); process.exit(2); });
