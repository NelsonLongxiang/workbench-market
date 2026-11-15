/**
 * 技能版本的影子副本（推进 LayerFS 的 wm-skills 项目，skill/<slug> 分支）：推一版、以及定时补推。
 *
 * 影子只是备份：市场读技能、下载、安装都走本地快照。原来只有三条路会推：发布（skill_publish 当场异步推）、
 * 管理接口 POST /api/skills/:slug/migrate-layerfs（手动）、每月整库重建（只推当前版本）。导入器
 * （scripts/skill-import.mjs）不连 LayerFS，它写的版本一直是 pending——意思是「没人推过」，不是「排着队」。
 *
 * 补推：每隔 WM_SKILL_SHADOW_EVERY_MS 一轮，找各技能**当前版本**里没有 commit_id、又不是 skipped 的，
 * 按 migrate-layerfs 同一套逻辑推（pushSkillVersion）：快照读出的摘要要和登记一致才推，推完从服务读回同一个 commit 重算，
 * 一致才记 succeeded；不一致记 failed，下一轮再试。每轮最多 WM_SKILL_SHADOW_BATCH 个。
 *  · LayerFS 没配置：什么都不做，不写库、不打日志。
 *  · LayerFS 连不上：这一轮推到第一个失败就停（不把一批都撞一遍），这一版记 failed；日志只在「通 → 不通」「不通 → 通」时各打一行。
 *  · 快照缺失、摘要和登记不符、空快照、读回不一致：记 failed 并写明原因；同一版在内存里退避——第 n 次失败后隔 2^n 轮再试（2、4、8……最多 64 轮），重启清零。
 *  · 含二进制文件：LayerFS 契约 v1 只收文本，记 skipped（和发布时一样），以后不再试。
 * 定时器挂在根上下文的 effect 上，卸载时一起停；第一轮在起来之后 min(周期, 2 分钟) 才跑，不挡启动。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './root-context.ts';
import { svc } from './context.ts';
import { SkillService } from './services/skill.ts';
import { defineConfig, loadConfig, str } from './config.ts';

export const Config = defineConfig((env) => {
  const num = (name: string, raw: string, dflt: number, min: number, max: number): number => {
    if (raw === '') return dflt;
    const n = Number(raw);
    if (!Number.isInteger(n) || (n !== 0 && (n < min || n > max))) throw new Error(`${name} 要是 0 或 ${min}～${max} 之间的整数，现在是 ${raw}`);
    return n;
  };
  return {
    /** 补推的周期（毫秒）；0 = 不补推。缺省 10 分钟 */
    everyMs: num('WM_SKILL_SHADOW_EVERY_MS', str(env.WM_SKILL_SHADOW_EVERY_MS), 600_000, 200, 86_400_000),
    /** 每轮最多推几个版本。缺省 20 */
    batch: num('WM_SKILL_SHADOW_BATCH', str(env.WM_SKILL_SHADOW_BATCH), 20, 1, 500) || 20,
  };
});

export type LayerfsPublish = (project: string, files: { path: string; content: string }[], message: string, branch?: string, opts?: { quiet?: boolean }) => Promise<{ commit_id: string; changed: boolean } | null>;
export interface ShadowDeps {
  layerfsPublish: LayerfsPublish;
  layerfsServiceBase: () => { base: string; token: string };
  LAYERFS_SKILLS_PROJECT: string;
  resolveSnap: (p: string) => string;
}

/** 推一版的结果，形状和 migrate-layerfs 应答里 results 的一项相同；kind 只给调用方区分异常，不进应答 */
export type PushResult =
  | { version: number; result: 'skip'; commit_id: string }
  | { version: number; result: 'anomaly'; reason: string; kind: 'missing' | 'binary' | 'empty' | 'digest' }
  | { version: number; result: 'error'; reason: string; unreachable: boolean; commit_id_unrecorded?: string }
  | { version: number; result: 'migrated'; commit_id: string; digest_match: true; readback_digest_match: true };

/**
 * 推一版（原样搬自 POST /api/skills/:slug/migrate-layerfs 的循环体，写库的地方不变）：
 * 已有 commit_id 跳过；快照缺失、含二进制、空快照、摘要和登记不符留档不迁（这里不写库）；
 * 推不上去记 failed；推上去了读回重算，一致才记 commit_id 和 succeeded，不一致记 failed 并写下孤立的 commit。
 */
export async function pushSkillVersion(slug: string, v: any, deps: ShadowDeps, opts: { quiet?: boolean } = {}): Promise<PushResult> {
  const S = svc<SkillService>('skill');
  const { resolveSnap, layerfsPublish, layerfsServiceBase, LAYERFS_SKILLS_PROJECT } = deps;
  if (v.commit_id) return { version: v.version, result: 'skip', commit_id: v.commit_id }; // 幂等
  if (!v.snapshot_path || !existsSync(resolveSnap(v.snapshot_path))) return { version: v.version, result: 'anomaly', reason: '快照目录缺失', kind: 'missing' };
  // 按字节读：LayerFS 契约 v1 的 content 是文本，非 UTF-8（二进制）文件转不了，点名留档不迁，不拿改坏的内容去算摘要
  const raw: { path: string; bytes: Buffer }[] = [];
  (function walk(d: string, rel = '') { for (const e of readdirSync(d, { withFileTypes: true })) { const fp = join(d, e.name); if (e.isDirectory()) walk(fp, rel + e.name + '/'); else raw.push({ path: rel + e.name, bytes: readFileSync(fp) }); } })(resolveSnap(v.snapshot_path));
  const binary = raw.find((f) => !Buffer.from(f.bytes.toString('utf8'), 'utf8').equals(f.bytes));
  if (binary) return { version: v.version, result: 'anomaly', reason: `含非 UTF-8（二进制）文件 ${binary.path}：LayerFS 契约只收文本，留档不迁`, kind: 'binary' };
  const files = raw.map((f) => ({ path: f.path, content: f.bytes.toString('utf8') }));
  // 0 字节文件是合法内容（如 Python 包的 __init__.py），照常迁移；整个快照一个文件都没有才算异常。
  // 判据改为摘要：快照读出的文件集必须与登记的 tree_digest 一致才发布（登记快照不可变，不改它），发布后再从服务读回同一 commit 重算
  if (files.length === 0) return { version: v.version, result: 'anomaly', reason: '空快照（留档不迁）', kind: 'empty' };
  const pre = SkillService.filesDigest(files).digest;
  if (pre !== v.tree_digest) return { version: v.version, result: 'anomaly', reason: '快照读出的摘要与登记不符（留档不迁）', kind: 'digest' };
  const out = await layerfsPublish(LAYERFS_SKILLS_PROJECT, files, `[skill-migrate] ${slug} v${v.version}`, `skill/${slug}`, opts);
  if (!out) { S.versionShadowPublishFailed(v.id); return { version: v.version, result: 'error', reason: 'layerfs 服务不可达（可重跑）', unreachable: true }; }
  // K13 摘要对账：从服务读回这个 commit 的文件集重算，与登记摘要一致才记 commit_id（0 字节文件读回也得是 0 字节、同路径）
  let back = '';
  try {
    const { base, token } = layerfsServiceBase();
    const fr = await fetch(base.replace(/\/+$/, '') + '/v1/projects/' + encodeURIComponent(LAYERFS_SKILLS_PROJECT) + '/branches/' + encodeURIComponent(`skill/${slug}`) + '/commits/' + encodeURIComponent(out.commit_id) + '/files', { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(10000) });
    const fj = await fr.json() as { files?: { path: string; content: string }[] };
    if (fr.ok && Array.isArray(fj.files)) back = SkillService.filesDigest(fj.files).digest;
  } catch { back = ''; }
  if (back !== v.tree_digest) {
    // 这个 commit 已在分支上但不登记（孤立）：记进 shadow_error 便于核对；月度整库重建（rebuildWmSkills）会清掉它
    S.versionShadowFailed(`LayerFS readback digest mismatch; orphan commit ${out.commit_id} (cleared by monthly rebuild); retry migrate-layerfs`, v.id);
    return { version: v.version, result: 'error', reason: back ? '读回摘要与登记不符（不记 commit_id·可重跑）' : '读回失败（不记 commit_id·可重跑）', unreachable: false, commit_id_unrecorded: out.commit_id };
  }
  S.versionMigrated(out.commit_id, v.id);
  return { version: v.version, result: 'migrated', commit_id: out.commit_id, digest_match: true, readback_digest_match: true };
}

/** 补推的状态（跨轮）：LayerFS 上一轮通不通（只在变化时打日志）、各版本的退避 */
export interface CatchUpState { down: boolean; backoff: Map<number, { fails: number; nextRound: number }>; round: number }
export const newCatchUpState = (): CatchUpState => ({ down: false, backoff: new Map(), round: 0 });
export type RoundResult = { configured: boolean; tried: number; succeeded: number; failed: number; skipped: number; stopped_unreachable: boolean };

/** 补推一轮（定时器调它；测试也可以直接调） */
export async function catchUpRound(deps: ShadowDeps, batch: number, state: CatchUpState): Promise<RoundResult> {
  state.round++;
  const res: RoundResult = { configured: true, tried: 0, succeeded: 0, failed: 0, skipped: 0, stopped_unreachable: false };
  let base = '';
  try { base = deps.layerfsServiceBase().base; } catch (e) {
    // 凭据文件坏了之类：当作连不上
    if (!state.down) { state.down = true; console.warn(`[skill-shadow] LayerFS 的配置读不出来，补推暂停：${String((e as Error)?.message ?? e).slice(0, 120)}`); }
    res.stopped_unreachable = true;
    return res;
  }
  if (!base) { res.configured = false; return res; }
  const S = svc<SkillService>('skill');
  // 多取几倍，跳过还在退避里的，免得几个一直失败的版本占满每一轮
  const rows = S.shadowCatchUpCandidates(batch * 5) as any[];
  for (const v of rows) {
    if (res.tried >= batch) break;
    const b = state.backoff.get(Number(v.id));
    if (b && b.nextRound > state.round) continue;
    res.tried++;
    const r = await pushSkillVersion(String(v.skill_slug), v, deps, { quiet: true });
    if (r.result === 'migrated' || r.result === 'skip') { res.succeeded++; state.backoff.delete(Number(v.id)); continue; }
    if (r.result === 'error' && r.unreachable) {
      res.failed++; res.stopped_unreachable = true;
      if (!state.down) { state.down = true; console.warn('[skill-shadow] LayerFS 连不上，技能影子补推暂停，恢复后接着推'); }
      break;
    }
    if (r.result === 'anomaly' && r.kind === 'binary') { S.versionShadowSkipped(r.reason, v.id); res.skipped++; continue; }
    if (r.result === 'anomaly') S.versionShadowFailed(r.reason, v.id);
    res.failed++;
    const fails = (b?.fails ?? 0) + 1;
    state.backoff.set(Number(v.id), { fails, nextRound: state.round + 2 ** Math.min(fails, 6) });
  }
  if (!res.stopped_unreachable && state.down && res.tried > 0) { state.down = false; console.log('[skill-shadow] LayerFS 恢复，技能影子补推继续'); }
  return res;
}

/** 起补推定时器：挂在根上下文的 effect 上，卸载时一起停。cfg 不给就从启动环境取 */
export function startSkillShadowCatchUp(deps: ShadowDeps, cfg: { everyMs: number; batch: number } = loadConfig(Config)): void {
  if (!cfg.everyMs) return;
  const state = newCatchUpState();
  root.effect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const tick = (ms: number) => {
      timer = setTimeout(() => {
        void catchUpRound(deps, cfg.batch, state)
          .catch((e) => console.error(`[skill-shadow] 补推出错：${String((e as Error)?.message ?? e).slice(0, 200)}`))
          .finally(() => { if (!stopped) tick(cfg.everyMs); });
      }, ms);
      timer.unref?.();
    };
    tick(Math.min(cfg.everyMs, 120_000));
    return () => { stopped = true; if (timer) clearTimeout(timer); timer = null; };
  }, 'skillShadow.catchUp');
}
