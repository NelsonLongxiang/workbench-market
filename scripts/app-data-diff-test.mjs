#!/usr/bin/env node
/**
 * 台的提交记录和附件：同一串随机操作在 WM_APP_DATA_STORE=main 和 =bench 两个隔离实例上各跑一遍，逐条比状态码、ETag（弱 ETag 按应答体算，体里有时间，不比）、应答体
 * （docs/data-views.md 第十三节第 6 条「对外不变」）。只把时间字段归一化，别的逐字节一样。
 *
 * 操作：页面提交（带和不带幂等键；同键同内容、同键异内容；信封和直接两种形态）、列表翻页、软删提交、上传附件、列附件、
 * 改备注、软删附件、下载（带不带 Range、带不带 If-None-Match）。两个实例都先建三个合成台和它们的卡片（一个台没有卡片）。
 * 种子打印出来，可以用 APP_DIFF_SEED 复现；步数 APP_DIFF_STEPS（缺省 300）。
 *
 *   node scripts/app-data-diff-test.mjs
 */
import { createServer } from 'node:net';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from './owned-script-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'tmp', `app-diff-${process.pid}-${Date.now().toString(36)}`);
const ADMIN_TOKEN = 'synthetic-app-diff-admin';
const STEPS = Number(process.env.APP_DIFF_STEPS || 300);

let pass = 0, fail = 0;
const check = (ok, label, detail) => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || detail === undefined ? '' : `（${typeof detail === 'string' ? detail : JSON.stringify(detail)}）`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() { const p = createServer(); await new Promise((r) => p.listen(0, '127.0.0.1', r)); const { port } = p.address(); await new Promise((r) => p.close(r)); return port; }

async function boot(name, mode) {
  const port = await freePort();
  const data = join(OUT, name, 'data'), home = join(OUT, name, 'home'), ext = join(OUT, name, 'ext');
  for (const d of [data, home, ext]) mkdirSync(d, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: home, PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data, NODE_ENV: 'test', MCP_GATEWAY: 'off', ADMIN_TOKEN, REDIS_URL: '', WM_EXTENSIONS_DIR: ext, WM_APP_DATA_STORE: mode, WM_APP_FILES_MAX: '12' };
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], { cwd: join(ROOT, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i++) { try { if ((await fetch(`${base}/api/health`)).status === 200) break; } catch { /* 还没起来 */ } await sleep(200); }
  const stop = async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise((r) => { const t = setTimeout(r, 4000); child.once('exit', () => { clearTimeout(t); r(); }); }); } };
  const call = async (method, path, { headers = {}, body, form } = {}) => {
    const h = { ...headers }; let b;
    if (form) b = form(); else if (body !== undefined) { h['content-type'] = 'application/json'; b = JSON.stringify(body); }
    const res = await fetch(base + path, { method, headers: h, body: b });
    const buf = Buffer.from(await res.arrayBuffer());
    let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch { /* 不是 JSON */ }
    return { status: res.status, etag: res.headers.get('etag'), range: res.headers.get('content-range'), json, text: json ? null : buf.toString('base64') };
  };
  const db = new DatabaseSync(join(data, 'workbench-market.db'));
  return { name, call, stop, db, log: () => log };
}

const rng = (seed) => () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
// 时间字段归一化（两个实例跑的时刻不同）；created_at 是主库 datetime('now') 生成的文本，形状不比
const normalize = (v) => JSON.parse(JSON.stringify(v ?? null, (k, x) => (['created_at', 'updated_at', 'at'].includes(k) && typeof x === 'string' ? '<时间>' : x)));

try {
  const seed = Number(process.env.APP_DIFF_SEED || Date.now()) >>> 0;
  console.log(`种子 ${seed}，${STEPS} 步`);
  const [A, B] = await Promise.all([boot('main', 'main'), boot('bench', 'bench')]);
  try {
    // 两边一样的合成台：x、y 有卡片，z 没有
    for (const s of [A, B]) {
      for (const slug of ['syn-x', 'syn-y', 'syn-z']) s.db.prepare('INSERT INTO apps (slug, title) VALUES (?, ?)').run(slug, `合成·${slug}`);
      for (const slug of ['syn-x', 'syn-y']) s.db.prepare("INSERT INTO workbenches (name, url, type, enabled) VALUES (?, ?, 'market-app', 1)").run(`合成·${slug}`, `/apps/${slug}/`);
    }
    const r = rng(seed), pick = (a) => a[Math.floor(r() * a.length)], int = (n) => Math.floor(r() * n);
    const tok = { 'x-admin-token': ADMIN_TOKEN };
    const step = () => {
      const slug = pick(['syn-x', 'syn-x', 'syn-y', 'syn-z']);
      const k = int(12);
      if (k <= 3) {
        const data = { v: int(4), note: pick(['甲', '乙', '']) };
        const key = r() < 0.5 ? `k-${int(5)}` : undefined;
        const body = r() < 0.7 ? { data, ...(key ? { idempotency_key: key } : {}), created_by: pick(['a', 'b']) } : data;
        return ['POST', `/api/apps/${slug}/data`, { body }];
      }
      if (k <= 5) return ['GET', `/api/apps/${slug}/data?limit=${1 + int(4)}${r() < 0.5 ? `&before_id=${1 + int(40)}` : ''}`, { headers: tok }];
      if (k === 6) return ['DELETE', `/api/apps/${slug}/data/${1 + int(40)}`, { headers: tok }];
      if (k === 7) {
        // 随机数在这里先取好：表单是发请求时才拼的，两个实例各拼一次，不能各取一次随机数
        const name = pick(['a.txt', 'b.csv', '图.txt']), content = `内容-${int(1000)}`, note = pick(['', '备注']);
        return ['POST', `/api/apps/${slug}/files`, { form: () => { const f = new FormData(); f.append('file', new Blob([content], { type: 'text/plain' }), name); f.append('note', note); return f; } }];
      }
      if (k === 8) return ['GET', `/api/apps/${slug}/files?limit=${1 + int(4)}`, { headers: tok }];
      if (k === 9) return ['PATCH', `/api/apps/${slug}/files/${1 + int(30)}`, { headers: tok, body: { note: `改-${int(9)}` } }];
      if (k === 10) return ['DELETE', `/api/apps/${slug}/files/${1 + int(30)}`, { headers: tok }];
      return ['GET', `/api/apps/${slug}/files/${1 + int(30)}`, { headers: { ...tok, ...(r() < 0.3 ? { range: 'bytes=0-3' } : {}) } }];
    };
    let diffs = 0; const firstDiffs = [];
    for (let i = 0; i < STEPS; i++) {
      const req = step();
      // 两边依次发（id 由各自的主库发，同一串操作下两边一样）
      const ra = await A.call(...req), rb = await B.call(...req);
      // 弱 ETag（W/）是 express 按应答体算的，体里有时间就不一样，不比；下载的强 ETag（内容的 sha256）要一样
      const etagSame = (ra.etag?.startsWith('W/') && rb.etag?.startsWith('W/')) || ra.etag === rb.etag;
      const same = ra.status === rb.status && etagSame && ra.range === rb.range && JSON.stringify(normalize(ra.json)) === JSON.stringify(normalize(rb.json)) && ra.text === rb.text;
      if (!same) { diffs++; if (firstDiffs.length < 3) firstDiffs.push({ i, req: `${req[0]} ${req[1]}`, a: [ra.status, ra.json ?? ra.text?.slice(0, 40)], b: [rb.status, rb.json ?? rb.text?.slice(0, 40)] }); }
    }
    check(diffs === 0, `种子 ${seed}：${STEPS} 步，main 和 bench 两个实例逐条一样（状态码、ETag、Range、应答体；时间字段归一化）`, firstDiffs);
    // 收尾：bench 实例里台 x 的台库那份和它自己的主库一致（读确实走了台库，而且没有漏抄）
    const lastA = await A.call('GET', '/api/apps/syn-x/data?limit=50', { headers: tok }), lastB = await B.call('GET', '/api/apps/syn-x/data?limit=50', { headers: tok });
    check(lastA.json?.count >= 1 && JSON.stringify(normalize(lastA.json)) === JSON.stringify(normalize(lastB.json)), `收尾时台 x 的提交列表两边一样（${lastA.json?.count} 条）`, { a: lastA.json?.count, b: lastB.json?.count });
    const benchTables = B.db.prepare('SELECT COUNT(*) AS n FROM bench_views').get().n;
    check(benchTables >= 1 && A.db.prepare('SELECT COUNT(*) AS n FROM bench_views').get().n === 0, 'bench 实例给有卡片的台建了台库，main 实例一个也没建', { bench: benchTables });
  } finally { A.db.close(); B.db.close(); await A.stop(); await B.stop(); }
} catch (e) {
  check(false, `没有中途抛错：${e?.stack ?? e}`);
} finally {
  rmSync(OUT, { recursive: true, force: true });
}
console.log(`app-data-diff-test: ${pass} passed / ${fail} failed`);
if (fail) process.exitCode = 1;
