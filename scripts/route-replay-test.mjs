#!/usr/bin/env node
/**
 * 路由的录制回放：搬路由之前录一遍，之后对同一组请求重放，状态码和响应体必须和录下来的一样。
 * 每个域一份 surfaces/replay/<域>.json，请求和录下来的应答放在一起，对应 server/src/routes/<域>.ts。
 * 每个场景起一个隔离实例：临时数据目录、临时 HOME、随机回环端口、固定的最小环境变量，再加场景自己声明的几个。
 *
 *   node scripts/route-replay-test.mjs                 回放全部域；有差异退出 1，逐条列出
 *   node scripts/route-replay-test.mjs types           只回放一个域
 *   node scripts/route-replay-test.mjs --record [域]   把当前的应答录进去：搬之前录；有意改了行为也用它，PR 里看得见改了什么
 *   node scripts/route-replay-test.mjs --selftest      比较与覆盖检查的自检（不起实例）
 *
 * 覆盖要求，不满足就直接失败、不起实例：
 *   · server/src/routes/ 下每个域模块都有一份；routes 的条数等于模块里注册的路由数，每条都在 surfaces/routes.json 里；
 *   · 每条路由都有未授权（unauthorized）、参数非法（invalid）、正常（normal）三类请求，请求确实打在那条路由上。
 * 请求只打全局中间件或本域路由会应答的路径。落空的路径由最后的兜底应答，兜底随有没有 web/dist 而不同，不放进来。
 */
import { spawn } from './owned-script-fixture.mjs';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const REPLAY_DIR = join(ROOT, 'surfaces', 'replay');
const ROUTES_SNAPSHOT = join(ROOT, 'surfaces', 'routes.json');
const MODULES_DIR = join(ROOT, 'server', 'src', 'routes');
const CLASSES = ['unauthorized', 'invalid', 'normal'];
const CLASS_NAME = { unauthorized: '未授权', invalid: '参数非法', normal: '正常' };
// 和 scripts/tech-route-check.mjs 数路由用的是同一个写法
const ROUTE_CALL = /\b(?:app|router|r|api)\.(?:get|post|put|patch|delete)\(\s*['"`\/\[]/g;

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

/** 一份请求集哪里不合要求。返回问题清单，空就是合格。 */
export function checkCassette(cassette, known, moduleRouteCount = null) {
  const problems = [];
  const routes = Array.isArray(cassette?.routes) ? cassette.routes : [];
  const scenarios = Array.isArray(cassette?.scenarios) ? cassette.scenarios : [];
  if (!cassette?.domain) problems.push('缺 domain');
  if (routes.length === 0) problems.push('routes 是空的');
  if (scenarios.length === 0) problems.push('scenarios 是空的');
  for (const route of routes) {
    const [method, ...rest] = String(route).split(' ');
    if (!known.some((k) => k.path === rest.join(' ') && k.methods.includes(method))) problems.push(`路由不在 surfaces/routes.json 里：${route}`);
  }
  if (moduleRouteCount !== null && moduleRouteCount !== routes.length) problems.push(`域模块里注册了 ${moduleRouteCount} 条路由，routes 列了 ${routes.length} 条`);
  const seen = new Set();
  const covered = new Map(routes.map((r) => [r, new Set()]));
  for (const scenario of scenarios) {
    if (!scenario?.name) problems.push('有场景没有 name');
    for (const step of scenario?.steps ?? []) {
      const where = `${scenario.name}/${step?.id ?? '?'}`;
      if (!step?.id) problems.push(`${scenario.name} 里有请求没有 id`);
      if (seen.has(where)) problems.push(`请求 id 重复：${where}`);
      seen.add(where);
      const method = String(step?.request?.method ?? '');
      const path = String(step?.request?.path ?? '');
      if (!method || !path.startsWith('/')) { problems.push(`${where}：request 要有 method 和以 / 开头的 path`); continue; }
      if (step.route === undefined) continue;
      if (!covered.has(step.route)) { problems.push(`${where}：route 不在 routes 里：${step.route}`); continue; }
      if (!CLASSES.includes(step.class)) { problems.push(`${where}：class 只能是 ${CLASSES.join(' / ')}`); continue; }
      const [routeMethod, ...rest] = step.route.split(' ');
      const pathname = path.split('?')[0].replace(/\{\{[A-Za-z0-9_]+\}\}/g, '0');
      if (routeMethod !== method.toUpperCase() || !routeMatcher(rest.join(' ')).test(pathname)) { problems.push(`${where}：请求 ${method} ${path} 打不到它声明的路由 ${step.route}`); continue; }
      covered.get(step.route).add(step.class);
    }
  }
  for (const [route, classes] of covered) {
    const missing = CLASSES.filter((c) => !classes.has(c));
    if (missing.length) problems.push(`${route} 缺 ${missing.map((c) => CLASS_NAME[c]).join('、')} 的请求`);
  }
  return problems;
}

// ---------- 发请求、整理应答、比较 ----------

/** 把 {{名字}} 换成前面请求存下来的值。没存过就报错，不悄悄发出一个带花括号的请求。 */
export function fill(value, vars) {
  if (typeof value === 'string') return value.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (_, name) => { if (!(name in vars)) throw new Error(`用了没存过的变量 {{${name}}}`); return String(vars[name]); });
  if (Array.isArray(value)) return value.map((v) => fill(v, vars));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, vars)]));
  return value;
}

const DATETIME = /\b\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g;
/** 应答里每次都不一样的东西只有时间：换成占位。别的一律原样比较。 */
export function steady(value) {
  if (typeof value === 'string') return value.replace(DATETIME, '<时间>');
  if (Array.isArray(value)) return value.map(steady);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, steady(v)]));
  return value;
}

const pick = (value, path) => String(path).split('.').reduce((v, key) => (v == null ? undefined : v[key]), value);

async function send(base, request, vars) {
  const headers = fill(request.headers ?? {}, vars);
  let body;
  if ('json' in request) { body = JSON.stringify(fill(request.json, vars)); if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json'; }
  else if ('text' in request) body = fill(request.text, vars);
  const res = await fetch(base + fill(request.path, vars), { method: request.method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  const type = res.headers.get('content-type') ?? '';
  let parsed = text;
  if (/json/i.test(type)) { try { parsed = JSON.parse(text); } catch { /* 说是 JSON 但解析不了：按文本比 */ } }
  return { status: res.status, type, body: parsed };
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

/** 录下来的应答和这次的应答比。compare 是 'status' 的请求只比状态码（借别的域布置现场用）。 */
export function compareStep(step, actual) {
  const recorded = step.response;
  if (!recorded) return ['还没录过（跑一次 --record）'];
  const out = [];
  if (recorded.status !== actual.status) out.push(`状态码：${recorded.status} → ${actual.status}`);
  if (step.compare === 'status') return out;
  if (recorded.type !== actual.type) out.push(`内容类型：${JSON.stringify(recorded.type)} → ${JSON.stringify(actual.type)}`);
  return differences(recorded.body, actual.body, '响应体', out);
}

/**
 * 依次跑一个场景的请求。sendRequest(request, vars) 负责发出去并返回 { status, type, body }（自检时换成假的）。
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
      actual = step.compare === 'status' ? { status: raw.status } : steady(raw);
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

async function boot(tag, env) {
  const port = await freePort();
  const root = join(ROOT, 'tmp', `route-replay-${process.pid}-${tag}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, 'data'), { recursive: true });
  mkdirSync(join(root, 'home'), { recursive: true });
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], {
    cwd: join(ROOT, 'server'),
    env: { PATH: process.env.PATH, HOME: join(root, 'home'), MCP_GATEWAY: 'off', NODE_ENV: 'test', PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: join(root, 'data'), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += String(d); });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await new Promise((r) => { child.once('exit', r); setTimeout(r, 5000); }); }
    rmSync(root, { recursive: true, force: true });
  };
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30000;
  let ready = false;
  while (!ready && Date.now() < deadline && child.exitCode === null) {
    try { ready = (await fetch(`${base}/api/health`)).status === 200; } catch { /* 还没起来 */ }
    if (!ready) await new Promise((r) => setTimeout(r, 200));
  }
  if (!ready) { await stop(); throw new Error(`隔离实例没起来（${tag}）：${stderr.trim().split('\n').slice(-3).join(' | ') || '没有输出'}`); }
  return { base, stop };
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
      steps: s.steps.map((step) => order({ ...step, request: order(step.request, ['method', 'path', 'headers', 'json', 'text']) }, ['id', 'route', 'class', 'what', 'compare', 'request', 'save', 'response'])),
    }, ['name', 'what', 'env', 'steps'])),
  }, ['domain', 'what', 'routes', 'scenarios']);
}

function loadCassettes(only) {
  const names = existsSync(REPLAY_DIR) ? readdirSync(REPLAY_DIR).filter((n) => n.endsWith('.json')).sort() : [];
  const all = names.map((name) => ({ file: join(REPLAY_DIR, name), domain: name.replace(/\.json$/, ''), cassette: JSON.parse(readFileSync(join(REPLAY_DIR, name), 'utf8')) }));
  return only ? all.filter((c) => c.domain === only) : all;
}

function moduleRouteCount(domain) {
  const file = join(MODULES_DIR, `${domain}.ts`);
  return existsSync(file) ? (readFileSync(file, 'utf8').match(ROUTE_CALL) || []).length : null;
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
  const step = (id, route, cls, method, path) => ({ id, route, class: cls, request: { method, path } });
  const full = { domain: 'x', routes: ['GET /api/x'], scenarios: [{ name: 's', steps: [step('a', 'GET /api/x', 'unauthorized', 'GET', '/api/x'), step('b', 'GET /api/x', 'invalid', 'GET', '/api/x?q=1'), step('c', 'GET /api/x', 'normal', 'GET', '/api/x')] }] };
  check(checkCassette(full, known, 1).length === 0, '覆盖检查：三类齐全，通过');
  const thin = { ...full, scenarios: [{ name: 's', steps: full.scenarios[0].steps.slice(1) }] };
  check(checkCassette(thin, known).some((p) => p.includes('缺 未授权')), '覆盖检查：少一类，点名缺哪一类');
  check(checkCassette({ ...full, routes: ['GET /api/x', 'GET /api/gone'] }, known).some((p) => p.includes('/api/gone')), '覆盖检查：路由不在快照里，点名');
  check(checkCassette(full, known, 2).some((p) => p.includes('注册了 2 条')), '覆盖检查：域模块里的路由比列出来的多，失败');
  const stray = { ...full, scenarios: [{ name: 's', steps: [...full.scenarios[0].steps, step('d', 'GET /api/x', 'normal', 'GET', '/api/other')] }] };
  check(checkCassette(stray, known).some((p) => p.includes('打不到')), '覆盖检查：请求没打在它声明的路由上，失败');
  check(fill({ path: '/api/x/{{id}}', n: [1, '{{id}}'] }, { id: 7 }).path === '/api/x/7' && fill(['{{id}}'], { id: 7 })[0] === '7', '变量：路径和请求体里都能代入');
  let threw = false; try { fill('/api/x/{{nope}}', {}); } catch { threw = true; }
  check(threw, '变量：没存过的变量直接报错');
  check(steady({ at: '2026-01-02 03:04:05', iso: 'x 2026-01-02T03:04:05.678Z y', n: 1 }).at === '<时间>' && steady('x 2026-01-02T03:04:05.678Z y') === 'x <时间> y', '整理：只把时间换成占位');
  const recorded = { response: { status: 200, type: 'application/json', body: { a: 1, list: [{ k: 'v' }] } } };
  check(compareStep(recorded, { status: 200, type: 'application/json', body: { a: 1, list: [{ k: 'v' }] } }).length === 0, '比较：一样就是零差异');
  check(compareStep(recorded, { status: 500, type: 'application/json', body: { a: 1, list: [{ k: 'v' }] } }).join().includes('200 → 500'), '比较：状态码变了，报出来');
  check(compareStep(recorded, { status: 200, type: 'application/json', body: { a: 1, list: [{ k: 'w' }] } }).join().includes('响应体.list[0].k'), '比较：响应体变了，报到字段');
  check(compareStep(recorded, { status: 200, type: 'application/json', body: { a: 1, list: [{ k: 'v' }], extra: true } }).join().includes('响应体.extra'), '比较：多了字段，报出来');
  check(compareStep(recorded, { status: 200, type: 'text/html', body: { a: 1, list: [{ k: 'v' }] } }).join().includes('内容类型'), '比较：内容类型变了，报出来');
  check(compareStep({ response: { status: 200, type: 'a', body: { a: 1, b: 2 } } }, { status: 200, type: 'a', body: { b: 2, a: 1 } }).join().includes('顺序'), '比较：字段顺序变了，报出来');
  check(compareStep({ ...recorded, compare: 'status' }, { status: 200, type: 'x', body: 'y' }).length === 0, '比较：只比状态码的请求不看响应体');
  check(compareStep({}, { status: 200, type: '', body: '' }).join().includes('还没录过'), '比较：没录过的请求算差异');
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
  check(tape.every((s) => s.response) && tape[1].response.body.at === '<时间>' && tape[2].response.status === 404, '录制：每条请求都写进了应答，时间已换成占位');
  check((await runSteps(tape, fake({ id: 7 }))).every((r) => r.diffs.length === 0), '回放：行为没变，零差异');
  const moved = await runSteps(tape, fake({ id: 8 }));
  check(moved.filter((r) => r.diffs.length).map((r) => r.step.id).join() === 'create,read', '回放：行为变了，变了的那几条报出来，没变的不报');
  const lost = await runSteps(tape, fake({}));
  check(lost[1].diffs.join().includes('没存过的变量') && lost[2].diffs.length === 0, '回放：前一条没给出要存的值，用到它的那条算差异，后面的照跑');
  let refused = ''; try { await runSteps(steps(), fake({}), true); } catch (e) { refused = e.message; }
  check(refused.includes('create') && refused.includes('取不到'), '录制：要存的值没取到，直接报错，不写出半份录制');
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

  // 先做静态检查：请求集不合要求，回放结果就不算数
  const known = snapshotRoutes(JSON.parse(readFileSync(ROUTES_SNAPSHOT, 'utf8')));
  const problems = [];
  for (const { domain, cassette } of cassettes) for (const p of checkCassette(cassette, known, moduleRouteCount(domain))) problems.push(`surfaces/replay/${domain}.json：${p}`);
  if (!only && existsSync(MODULES_DIR)) {
    for (const name of readdirSync(MODULES_DIR).filter((n) => n.endsWith('.ts')).sort()) {
      if (!cassettes.some((c) => c.domain === name.replace(/\.ts$/, ''))) problems.push(`server/src/routes/${name} 没有对应的 surfaces/replay/${name.replace(/\.ts$/, '.json')}`);
    }
  }
  if (problems.length) { for (const p of problems) console.error(`✗ ${p}`); console.error('\n请求集不合要求，没有回放。'); return 1; }

  let total = 0, changed = 0;
  for (const { file, domain, cassette } of cassettes) {
    for (const scenario of cassette.scenarios) {
      const instance = await boot(`${domain}-${scenario.name}`, scenario.env ?? {});
      let results;
      try { results = await runSteps(scenario.steps, (request, vars) => send(instance.base, request, vars), record); }
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
    if (record) { writeFileSync(file, `${render(canonical(cassette))}\n`); console.log(`已录制 surfaces/replay/${domain}.json：${cassette.scenarios.reduce((n, s) => n + s.steps.length, 0)} 条请求`); }
  }
  if (record) return 0;
  console.log(changed ? `\n===== 录制回放：${total} 条请求，${changed} 条有差异 =====\n行为变了。确认是有意的，就跑 node scripts/route-replay-test.mjs --record，把录制和代码一起提交。`
    : `===== 录制回放：${cassettes.length} 个域、${total} 条请求，零差异 =====`);
  return changed ? 1 : 0;
}

main().then((code) => process.exit(code), (err) => { console.error(`[route-replay] ${err.message}`); process.exit(2); });
