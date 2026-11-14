#!/usr/bin/env node
/**
 * 对照：同一串随机操作，在 WM_VARS_STORE=main 和 =bench 两个隔离实例上各跑一遍，逐条比状态码、ETag（版本号那种；按应答体算的弱指纹含时间，不比）、应答体。
 * 只把时间字段（created_at、updated_at、at）归一化，别的必须逐字节一样（docs/data-views.md 第十三节第 5 条第 5 步）。
 *
 * 操作：新建、改、删、读一个、列表（带前缀）、审计；常量的锁定、作者修订、override 和 reason；乐观锁冲突、缺 revision；
 * 改 kind（冻结、转回）；不合法的键、超大的值。身份：本机命令行（属主）、管理口令（写的人是 admin-token、不是常量作者）。
 * 每轮换一个随机种子并打印出来，失败时用 VARS_DIFF_SEED=<种子> 复现。
 *
 *   node scripts/vars-store-diff-test.mjs              跑 1 轮 400 步
 *   VARS_DIFF_ROUNDS=3 node scripts/vars-store-diff-test.mjs
 */
import { createServer } from 'node:net';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from './owned-script-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'tmp', `vars-diff-${process.pid}-${Date.now().toString(36)}`);
const ADMIN_TOKEN = 'synthetic-vars-diff-admin';
const STEPS = Number(process.env.VARS_DIFF_STEPS || 400), ROUNDS = Number(process.env.VARS_DIFF_ROUNDS || 1);

let pass = 0, fail = 0;
const check = (ok, label, detail) => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || detail === undefined ? '' : `（${typeof detail === 'string' ? detail : JSON.stringify(detail)}）`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() { const p = createServer(); await new Promise((r) => p.listen(0, '127.0.0.1', r)); const { port } = p.address(); await new Promise((r) => p.close(r)); return port; }

async function boot(name, mode) {
  const port = await freePort();
  const data = join(OUT, name, 'data'), home = join(OUT, name, 'home'), ext = join(OUT, name, 'ext');
  for (const d of [data, home, ext]) mkdirSync(d, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: home, PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data, NODE_ENV: 'test', MCP_GATEWAY: 'off', ADMIN_TOKEN, REDIS_URL: '', WM_EXTENSIONS_DIR: ext, WM_VARS_STORE: mode };
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], { cwd: join(ROOT, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i++) { try { if ((await fetch(`${base}/api/health`)).status === 200) break; } catch { /* 还没起来 */ } await sleep(200); }
  const stop = async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise((r) => { const t = setTimeout(r, 4000); child.once('exit', () => { clearTimeout(t); r(); }); }); } };
  const call = async (method, path, { headers = {}, body } = {}) => {
    const h = { ...headers }; if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
    return { status: res.status, etag: res.headers.get('etag'), json, text };
  };
  return { name, call, stop, log: () => log };
}

/** 可复现的随机数（mulberry32） */
const rng = (seed) => () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const normalize = (v) => JSON.parse(JSON.stringify(v ?? null, (k, x) => (['created_at', 'updated_at', 'at'].includes(k) && typeof x === 'string' ? '<时间>' : x)));

try {
  for (let round = 0; round < ROUNDS; round++) {
    const seed = Number(process.env.VARS_DIFF_SEED || (Date.now() ^ (round * 7919))) >>> 0;
    console.log(`第 ${round + 1} 轮：种子 ${seed}，${STEPS} 步`);
    const [A, B] = await Promise.all([boot(`main-${round}`, 'main'), boot(`bench-${round}`, 'bench')]);
    try {
      const tok = { 'x-admin-token': ADMIN_TOKEN, 'x-forwarded-for': '192.0.2.71' };
      // 两边建一样的卡片（id 1、2）
      for (const s of [A, B]) for (const n of ['甲', '乙']) await s.call('POST', '/api/workbenches', { headers: tok, body: { name: `合成${n}`, url: `http://127.0.0.1:9/${n}`, type: 'web' } });
      // 固定的几步：作者那一列（随机序列里的身份都当不了常量作者，作者几乎总是空的，这几步专门走作者的各种变化）
      const fixed = [
        ['PUT', '/api/workbenches/2/vars/own', { headers: {}, body: { value: 1, kind: 'const', owner: 'mcp:someone' } }],
        ['PUT', '/api/workbenches/2/vars/own', { headers: tok, body: { value: 2, revision: 1, override: true, reason: '合成' } }],
        ['PUT', '/api/workbenches/2/vars/own', { headers: {}, body: { value: 3, kind: 'var', revision: 1, override: true, reason: '转回变量' } }],
        ['PUT', '/api/workbenches/2/vars/own', { headers: {}, body: { value: 4, kind: 'const', revision: 2 } }],
        ['PUT', '/api/workbenches/2/vars/own', { headers: {}, body: { value: 5, revision: 3, override: true, reason: '交给公共', owner: '*' } }],
        ['GET', '/api/workbenches/2/vars/own', { headers: {} }],
        ['GET', '/api/workbenches/2/vars/own/audit', { headers: {} }],
        ['DELETE', '/api/workbenches/2/vars/own?revision=4&override=1&reason=%E5%90%88%E6%88%90', { headers: {} }],
      ];
      let fixedDiffs = 0; const fixedFirst = [];
      for (const req of fixed) {
        const [ra, rb] = await Promise.all([A.call(...req), B.call(...req)]);
        if (ra.status !== rb.status || JSON.stringify(normalize(ra.json)) !== JSON.stringify(normalize(rb.json))) { fixedDiffs++; if (fixedFirst.length < 2) fixedFirst.push({ req: req.slice(0, 2), main: ra.text.slice(0, 200), bench: rb.text.slice(0, 200) }); }
      }
      // bench 档先判权：没过判权的读写不替卡片代建台库、不对同步点（#698 的次序）。卡片 3 只在 bench 实例上建；写入要是先于判权，PUT 就会替它建出台库
      await B.call('POST', '/api/workbenches', { headers: tok, body: { name: '合成丙', url: 'http://127.0.0.1:9/c', type: 'web' } });
      // 带一个不属于这张卡片的按台令牌：穿过外层的门、走到变量接口自己的判权（不带令牌的远程请求在外层就被挡了，碰不到这里）
      const remote = { 'x-forwarded-for': '192.0.2.72', origin: 'null', 'x-app-token': 'synthetic-not-this-card' };
      const denied = [];
      for (const [m, p, body] of [['GET', '/api/workbenches/3/vars'], ['GET', '/api/workbenches/3/vars/k'], ['PUT', '/api/workbenches/3/vars/k', { value: 1 }], ['DELETE', '/api/workbenches/3/vars/k?revision=1']]) denied.push(`${m} ${(await B.call(m, p, { headers: remote, body })).status}`);
      const store3 = existsSync(join(OUT, `bench-${round}`, 'data', 'bench-stores', 'wb-3.sqlite'));
      check(denied.every((d) => /\s403$/.test(d)) && !store3, 'bench 档没过判权的读写（别的台的令牌）：403，不替卡片代建台库', { denied, store3 });
      check(fixedDiffs === 0, '固定的几步（指定作者的常量、管理口令改不了、转回变量、再冻结、交给公共、读、审计、删）两边一样', fixedFirst);
      const R = rng(seed), pick = (a) => a[Math.floor(R() * a.length)];
      const KEYS = ['a', 'b', 'c.d', 'c:e', 'hot.x', 'z'];
      const rev = new Map(); // 主库实例那边看到的 revision（两边应当一样）
      const actors = [{}, tok]; // 本机命令行；管理口令
      let diffs = 0; const firstDiffs = [];
      for (let i = 0; i < STEPS; i++) {
        const wb = pick([1, 2]), key = R() < 0.03 ? pick(['bad key', '', 'x'.repeat(129)]) : pick(KEYS), who = pick(actors), k = `${wb}/${key}`;
        const known = rev.get(k) ?? 0;
        const kind = R(), op = R();
        let req;
        if (op < 0.4) {
          const body = { value: R() < 0.02 ? 'v'.repeat(70 * 1024) : pick([1, 'x', null, { n: Math.floor(R() * 9) }, [1, 2], true]) };
          if (kind < 0.25) body.kind = 'const'; else if (kind < 0.35) body.kind = 'var';
          const rr = R(); if (rr < 0.7) body.revision = known; else if (rr < 0.85) body.revision = known + 1;
          if (R() < 0.3) { body.override = true; body.reason = pick(['', '合成修订']); }
          if (R() < 0.1) body.owner = pick(['*', 'mcp:someone', '', 'bad owner']);
          req = ['PUT', `/api/workbenches/${wb}/vars/${encodeURIComponent(key)}`, { headers: who, body }];
        } else if (op < 0.55) {
          const q = new URLSearchParams(); const rr = R(); if (rr < 0.7) q.set('revision', String(known)); else if (rr < 0.8) q.set('revision', String(known + 2));
          if (R() < 0.3) { q.set('override', '1'); q.set('reason', pick(['', '合成删除'])); }
          req = ['DELETE', `/api/workbenches/${wb}/vars/${encodeURIComponent(key)}?${q}`, { headers: who }];
        } else if (op < 0.75) req = ['GET', `/api/workbenches/${wb}/vars/${encodeURIComponent(key)}`, { headers: who }];
        else if (op < 0.92) req = ['GET', `/api/workbenches/${wb}/vars${R() < 0.5 ? `?prefix=${pick(['c', 'h', 'zz', 'a'])}` : ''}`, { headers: who }];
        else req = ['GET', `/api/workbenches/${wb}/vars/${encodeURIComponent(key)}/audit`, { headers: who }];
        const [ra, rb] = await Promise.all([A.call(...req), B.call(...req)]);
        // 版本号 ETag（"3"）照比；Express 按应答体算的弱指纹（W/...）里含时间，不比——应答体本身下面照比
        const etagSame = (ra.etag ?? '').startsWith('W/') && (rb.etag ?? '').startsWith('W/') ? true : ra.etag === rb.etag;
        const same = ra.status === rb.status && etagSame && JSON.stringify(normalize(ra.json)) === JSON.stringify(normalize(rb.json)) && (ra.json !== null || ra.text === rb.text);
        if (!same) { diffs++; if (firstDiffs.length < 3) firstDiffs.push({ step: i, req: req.slice(0, 2), main: [ra.status, ra.text.slice(0, 200)], bench: [rb.status, rb.text.slice(0, 200)] }); }
        if (ra.json && typeof ra.json.revision === 'number' && ra.status < 300) rev.set(k, ra.json.deleted ? 0 : ra.json.revision);
        if (ra.json && ra.json.current_revision !== undefined) rev.set(k, ra.json.current_revision);
        if (ra.status === 404 && req[0] !== 'PUT') rev.set(k, 0);
      }
      check(diffs === 0, `种子 ${seed}：${STEPS} 步，主库和台库两个实例逐条一样（状态码、ETag、应答体；时间字段归一化）`, firstDiffs);
      const listA = await A.call('GET', '/api/workbenches/1/vars'), listB = await B.call('GET', '/api/workbenches/1/vars');
      check(listA.json?.count >= 1 && JSON.stringify(normalize(listA.json)) === JSON.stringify(normalize(listB.json)), `收尾时卡片 1 的列表两边一样（${listA.json?.count} 个键）`, { a: listA.json?.count, b: listB.json?.count });
    } finally { await A.stop(); await B.stop(); }
  }
} finally { rmSync(OUT, { recursive: true, force: true }); }
console.log(`vars-store-diff-test: ${pass} passed / ${fail} failed`);
if (fail) process.exitCode = 1;
