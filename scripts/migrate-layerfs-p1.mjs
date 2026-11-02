#!/usr/bin/env node
/** #94 P1 迁移编排脚本：对每台（或 --slug 指定）调 market 迁移端点（三门禁复验·幂等·sha256 对账）。
 *  用法：node scripts/migrate-layerfs-p1.mjs --api http://127.0.0.1:PORT --target-mode isolated [--slug xxx] [--dry]
 *  生产必须显式 --target-mode production --ack-production-target；确认旗标不替代属主授权。
 */
import { parseArgs } from 'node:util';
const options = { api: { type: 'string' }, token: { type: 'string' }, slug: { type: 'string' }, dry: { type: 'boolean' }, 'target-mode': { type: 'string' }, 'ack-production-target': { type: 'boolean' } };
const parsed = parseArgs({ options, strict: true, allowPositionals: false, tokens: true });
const seen = new Set();
for (const token of parsed.tokens) {
  if (token.kind === 'option' && seen.has(token.name)) throw Error('duplicate_script_option');
  if (token.kind === 'option') seen.add(token.name);
}
const args = parsed.values;
const raw = args.api ?? '';
const match = /^(https?):\/\/(\[[0-9A-Fa-f:]+\]|[A-Za-z0-9.-]+):([0-9]{1,5})\/?$/.exec(raw);
if (!match || !['isolated', 'production'].includes(args['target-mode'])) throw Error('explicit_target_and_mode_required');
const target = new URL(raw), port = Number(match[3]);
if (port < 1 || port > 65535) throw Error('invalid_target_port');
if (args['target-mode'] === 'isolated') {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(match[2].toLowerCase()) || [3080, 9800, 9801].includes(port)) throw Error('isolated_target_refused');
} else if (!args['ack-production-target']) throw Error('production_target_confirmation_required');
const API = target.origin;
const TOKEN = args.token ?? process.env.ADMIN_TOKEN ?? '';
const SLUG = args.slug ?? '';
const DRY = args.dry === true;
const H = { 'Content-Type': 'application/json', ...(TOKEN ? { 'X-Admin-Token': TOKEN } : {}) };

const apps = SLUG ? [SLUG] : (await (async () => { const r = await fetch(API + '/api/apps', { redirect: 'error', signal: AbortSignal.timeout(10000) }); if (!r.ok) throw Error('target_list_failed'); return r.json(); })()).map((a) => a.slug);
console.log(`迁移对象：${apps.length} 台${SLUG ? '（指定 ' + SLUG + '）' : ''}`);
let migrated = 0, anomalies = 0, skips = 0, errors = 0;
for (const slug of apps) {
  if (DRY) { console.log(`[dry] ${slug}`); continue; }
    const isSkill = slug.includes(':'); // S2：技能 slug 形 ns:name——走技能迁移面
  const r = await fetch(API + (isSkill ? '/api/skills/' : '/api/apps/') + encodeURIComponent(slug) + '/migrate-layerfs', { method: 'POST', headers: H, redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!r.ok) { console.log(`${slug}: HTTP ${r.status}`); errors++; continue; }
  const j = await r.json();
  for (const v of j.results ?? []) {
    const tag = v.result === 'migrated' ? 'v' + v.version + ' migrated' + (v.sha256_match ? ' sha256✓' : ' sha256✗') : v.result === 'skip' ? 'v' + v.version + ' skip（已迁·幂等）' : v.result === 'anomaly' ? 'v' + v.version + ' ANOMALY: ' + v.reason : v.result + ': ' + (v.reason ?? '');
    console.log(`${slug}: ${tag}`);
    if (v.result === 'migrated') migrated++;
    else if (v.result === 'anomaly') anomalies++;
    else if (v.result === 'skip') skips++;
    else errors++;
  }
}
console.log(`\n迁移汇总：migrated=${migrated} skip=${skips} anomaly=${anomalies}(留档) error=${errors}`);
process.exitCode = errors > 0 ? 1 : 0; // allow HTTP handles and output to finish before process teardown
