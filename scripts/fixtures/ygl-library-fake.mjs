#!/usr/bin/env node
/**
 * 假的 ygl-trees 命令行（只认 library 出口，契约 ygl-library/1）：经验库的测试经 WM_YGL_CLI 指过来。
 * 数据在 $YGL_HOME/library-fixture.json：
 *   { contract?, page_size?, fail?, show_fail?, items: { claim: [...], note: [...], skill: [...], check: [...] }, bodies: { "<kind>:<id>": { body, evidence?, …多余字段 } } }
 *   · page_size：每页最多几条（比市场要的 limit 小时按它分页，用来测游标）；
 *   · fail：list 怎么坏（exit2 退出 2、timeout 一直不退、notjson 打一段不是 JSON 的字、unknowncmd 旧版本不认 library）；show_fail：show 怎么坏（exit2，或 gone = rc 1 加一个 {"error"}）；
 *   · contract：故意给错的契约版本；
 *   · delay_ms：每次调用先等这么久再应答（测「跑到一半停下」）；每次调用都在 $YGL_HOME/calls.log 追加一行参数（测「停了以后不再调」）。
 * 用法同真的：library list --kind K [--since ISO] [--limit N] [--cursor C] --json；library show <kind>:<id> --json
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const fx = JSON.parse(readFileSync(join(process.env.YGL_HOME ?? '.', 'library-fixture.json'), 'utf8'));
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const contract = fx.contract ?? 'ygl-library/1';
const out = (o, code = 0) => { process.stdout.write(JSON.stringify(o)); process.exit(code); };
appendFileSync(join(process.env.YGL_HOME ?? '.', 'calls.log'), `${argv.join(' ')}\n`);
if (fx.delay_ms) await new Promise((r) => setTimeout(r, fx.delay_ms));

if (argv[0] !== 'library') out({ error: 'unknown command' }, 2);
// 旧版本：还没有 library 出口——照旧版本的样子在 stderr 说不认识这个命令、退出 1，stdout 什么都没有
if (fx.fail === 'unknowncmd') { process.stderr.write("error: unknown command 'library'\n"); process.exit(1); }
if (argv[1] === 'list') {
  if (fx.fail === 'exit2') out({ error: 'synthetic failure' }, 2);
  if (fx.fail === 'timeout') setInterval(() => {}, 1000);
  else if (fx.fail === 'notjson') { process.stdout.write('not json at all'); process.exit(0); }
  else {
    const kind = opt('--kind'), since = opt('--since') ?? '', limit = Math.min(Number(opt('--limit') ?? 200), fx.page_size ?? 500);
    const start = opt('--cursor') ? Number(opt('--cursor')) : 0;
    const all = (fx.items?.[kind] ?? []).filter((it) => !since || (it.updated ?? '') > since)
      .sort((a, b) => (a.updated === b.updated ? (a.id < b.id ? 1 : -1) : a.updated < b.updated ? 1 : -1));
    const items = all.slice(start, start + limit);
    out({ contract, items, total: all.length, next_cursor: start + limit < all.length ? String(start + limit) : null });
  }
} else if (argv[1] === 'show') {
  const ref = argv[2] ?? '';
  if (fx.show_fail === 'exit2') out({ error: 'synthetic failure' }, 2);
  const [kind, id] = ref.split(':');
  const row = (fx.items?.[kind] ?? []).find((it) => it.id === id);
  if (!row || fx.show_fail === 'gone') out({ error: `not found: ${ref}` }, 1);
  out({ contract, ...row, ...(fx.bodies?.[ref] ?? { body: '' }) });
} else out({ error: 'unknown library action' }, 2);
