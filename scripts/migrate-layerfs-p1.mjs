#!/usr/bin/env node
/** #94 P1 迁移编排脚本：对每台（或 --slug 指定）调 market 迁移端点（三门禁复验·幂等·sha256 对账）。
 *  用法：node scripts/migrate-layerfs-p1.mjs [--api http://127.0.0.1:PORT] [--token ADMIN] [--slug xxx] [--dry]
 */
const args = process.argv.slice(2);
const get = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const API = get('api', 'http://127.0.0.1:9800');
const TOKEN = get('token', process.env.ADMIN_TOKEN ?? '');
const SLUG = get('slug', '');
const DRY = args.includes('--dry');
const H = { 'Content-Type': 'application/json', ...(TOKEN ? { 'X-Admin-Token': TOKEN } : {}) };

const apps = SLUG ? [SLUG] : (await (await fetch(API + '/api/apps')).json()).map((a) => a.slug);
console.log(`迁移对象：${apps.length} 台${SLUG ? '（指定 ' + SLUG + '）' : ''}`);
let migrated = 0, anomalies = 0, skips = 0, errors = 0;
for (const slug of apps) {
  if (DRY) { console.log(`[dry] ${slug}`); continue; }
  const r = await fetch(API + '/api/apps/' + encodeURIComponent(slug) + '/migrate-layerfs', { method: 'POST', headers: H });
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
process.exit(errors > 0 ? 1 : 0);
