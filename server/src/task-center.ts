// #159 task intake: one seed, one published task per completed run.
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { db, tableColumns } from './db.ts';
import { assignableTeams, initWorkbenchEvents, recordTaskCenterEvent } from './workbench-events.ts';
import { svc } from './context.ts';
import type { TaskCenterService } from './services/task-center.ts';
import type { SettingService } from './services/setting.ts';
import { COCKPIT_ID_MAX, itemIdForEvent, type WorkItemService } from './services/work-item.ts';
import type { CockpitService } from './services/cockpit.ts';
import { directedSeatsDeclared } from './a2a.ts';
import { peerRootOf, type A2aPeerService } from './services/a2a-peers.ts';
import { rosterHostOfRoot, rosterSeatById } from './services/a2a-roster.ts';
import { relationOf } from './team-relation.ts';

export const taskCenterSteps = [
  { key: 'title', title: '任务标题' }, { key: 'intent', title: '任务意图' },
  { key: 'references', title: '基准材料' }, { key: 'deliverable', title: '提交物要求' },
  { key: 'target', title: '目标 SOP 台' }, { key: 'due', title: '截止日期' },
];
export function initializeTaskCenter(appsRoot: string) {
  initWorkbenchEvents(); // 发布与工作台事件同事务：任务中心在哪里初始化，事件表就在哪里建
  const cols = tableColumns('tasks') as {name:string}[];
  if (!cols.some(c=>c.name==='intake_run_id')) db.exec('ALTER TABLE tasks ADD COLUMN intake_run_id INTEGER REFERENCES sop_runs(id)');
  if (!cols.some(c=>c.name==='template_version')) db.exec('ALTER TABLE tasks ADD COLUMN template_version INTEGER');
  db.exec('DROP INDEX IF EXISTS idx_tasks_material; CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_intake_run ON tasks(intake_run_id) WHERE intake_run_id IS NOT NULL');
  db.exec("CREATE TABLE IF NOT EXISTS task_center_events (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL DEFAULT (datetime('now')), actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL)");
  db.exec("CREATE TRIGGER IF NOT EXISTS task_events_no_update BEFORE UPDATE ON task_events BEGIN SELECT RAISE(ABORT,'task events append only'); END; CREATE TRIGGER IF NOT EXISTS task_events_no_delete BEFORE DELETE ON task_events BEGIN SELECT RAISE(ABORT,'task events append only'); END");
  const existing = db.prepare("SELECT * FROM apps WHERE slug='task-center'").get() as any;
  if (existing) {
    if (existing.kind !== 'sop') throw new Error('task-center seed slug is occupied by a non-SOP app');
    return; // manual versions/status are authoritative; never overwrite on restart
  }
  const manifest = JSON.stringify({ title: '任务中心', meta: 'task-center', steps: taskCenterSteps.map(s=>({...s,body:'<label>'+s.title+'<textarea data-field="value"></textarea></label>'})) }, null, 2);
  const dir = join(appsRoot,'task-center','v1');
  mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,'sop.yaml'),manifest); // no app record: repair an orphan initial seed file
  db.exec('BEGIN IMMEDIATE');
  try {
    const a=db.prepare("INSERT INTO apps(slug,title,description,created_by,kind,status,a2a_node8) VALUES('task-center','任务中心','人工发布录入任务','system:seed','sop','published',?)").run(randomBytes(4).toString('hex'));
    db.prepare("INSERT INTO app_versions(app_id,version,file_count,total_bytes,created_by,changelog) VALUES(?,1,1,?,'system:seed','内置任务录入模板 v1')").run(a.lastInsertRowid,Buffer.byteLength(manifest));
    db.exec('COMMIT');
  } catch(e) {db.exec('ROLLBACK');throw e;}
}
export function taskCenterPolicy() {
  const row = db.prepare("SELECT value FROM task_center_policy WHERE key='center_switch'").get() as {value:string}|undefined;
  return {agent_dispatch_enabled: row?.value === 'on'};
}
/** #309 phase2：公开任务列表/未授权详情只回显式元数据，不带 payload_json/内部路径/未来新增列。 */
export function taskListView(row: any) {
  const agent_dispatch = row.agent_dispatch_enabled === 1;
  return { id: row.id, title: row.title, kind: row.kind, status: row.status, enabled: row.enabled,
    created_at: row.created_at, updated_at: row.updated_at, published_at: row.published_at,
    intake_run_id: row.intake_run_id, template_version: row.template_version,
    agent_dispatch, agent_dispatch_effective: row.status === 'published' && agent_dispatch && taskCenterPolicy().agent_dispatch_enabled };
}
export function taskView(row: any) {
  const agent_dispatch = row.agent_dispatch_enabled === 1;
  return {...row, agent_dispatch, agent_dispatch_effective: row.status === 'published' && agent_dispatch && taskCenterPolicy().agent_dispatch_enabled};
}
export function canonicalTaskData(value: unknown): string {
  function sorted(x: any): any {
    if (Array.isArray(x)) return x.map(sorted);
    if (x && typeof x==='object') return Object.fromEntries(Object.keys(x).sort().map(k=>[k,sorted(x[k])]));
    return x;
  }
  return JSON.stringify(sorted(value));
}
export class TaskIntakeError extends Error { status: number; constructor(status: number,message: string){super(message);this.status=status;} }
/** publisherPrincipal：发布请求经身份服务认出来的人（路由给；认不出就不给），只留痕。
 *  事项的建立人取录入 run 上记的提需求人（requester_principal），没有就空着，不拿发布的人顶替。published_by 是请求体里自填的，只用于显示 */
export function publishTaskIntake(body: any, opts: { publisherPrincipal?: string | null } = {}) {
  const runId=body?.intake_run_id;
  if (!Number.isSafeInteger(runId)||runId<=0) throw new TaskIntakeError(400,'intake_run_id 必填（正整数）');
  const by=typeof body.published_by==='string'?body.published_by.trim():'';
  if (!by) throw new TaskIntakeError(400,'published_by 必填');
  if (body.agent_dispatch!==undefined&&typeof body.agent_dispatch!=='boolean') throw new TaskIntakeError(400,'agent_dispatch 必须是布尔值');
  db.exec('BEGIN IMMEDIATE');
  try {
    const run=db.prepare('SELECT * FROM sop_runs WHERE id=?').get(runId) as any;
    if (!run||run.sop_slug!=='task-center'||run.status!=='finished') throw new TaskIntakeError(400,'录入必须是 task-center 已完成 run');
    if (db.prepare('SELECT id FROM tasks WHERE intake_run_id=?').get(runId)) throw new TaskIntakeError(409,'同一录入 run 只能发布一次');
    const data=JSON.parse(run.data);
    const stepValue = (key: string) => data[key] && typeof data[key] === 'object' && !Array.isArray(data[key]) && 'value' in data[key] ? data[key].value : data[key];
    for (const key of ['title','intent','deliverable']) {
      const value = stepValue(key);
      if (value === undefined || value === null || (typeof value === 'string' && !value.trim()) || (typeof value === 'object' && !Object.keys(value).length)) throw new TaskIntakeError(400,'录入缺必填步骤: '+key);
    }
    const frozen=canonicalTaskData(data);
    const hash=createHash('sha256').update(frozen,'utf8').digest('hex');
    const actor='human:'+by;
    const info=db.prepare("INSERT INTO tasks(title,kind,payload_json,status,intake_run_id,template_version,material_sha256,published_at,published_by,created_by,agent_dispatch_enabled) VALUES(?,'录入',?,'published',?,?,?,datetime('now'),?,?,?)").run(String(stepValue('title')),frozen,runId,run.sop_version,hash,actor,actor,body.agent_dispatch===true?1:0);
    const id=Number(info.lastInsertRowid);
    db.prepare("INSERT INTO task_events(task_id,type,actor,actor_kind,payload_json) VALUES(?,'published',?,'human',?)").run(id,actor,JSON.stringify({intake_run_id:runId,template_version:run.sop_version,material_sha256:hash}));
    // 工作台事件 v1：人工发布即 human 事件，与发布同一事务（不会出现发布了却没有事件）
    const event_id=recordTaskCenterEvent({id,data,stepValue,publishedBy:by,requesterPrincipal:typeof run.requester_principal==='string'?run.requester_principal:null,publisherPrincipal:opts.publisherPrincipal??null,templateVersion:run.sop_version,materialSha256:hash,agentDispatch:body.agent_dispatch===true,centerOn:taskCenterPolicy().agent_dispatch_enabled});
    db.exec('COMMIT');
    return {ok:true,id,status:'published',intake_run_id:runId,template_version:run.sop_version,material_sha256:hash,event_id};
  } catch(e) {db.exec('ROLLBACK');throw e;}
}

// ---------- 「安排一件事」：登录的人直接建一件事项（POST /api/work-items） ----------
/**
 * 和录入发布走同一个出口：建 tasks 行，同一事务里 recordTaskCenterEvent 记事件和投递；事项、held → 放行 → 派出、撤回全是现成的。
 * 建立人是本人（requester 记进 recorded，事项服务照 8f 的规则认）；不经录入 run、不要管理员代发。
 *   · 派给：只能是 assignableTeams()（绑在任务中心上的通知绑定），投递只发给这一个团队
 *   · 先过目：review 缺省 true，一律 held 等管理员放行；review:false 只在中心总开关开、并且设置 staff_direct_dispatch 是 on 时直接派出，
 *     否则照样 held，应答带原因 review_required_by_policy
 *   · 幂等：同一个人同一个 idempotency_key 再发回第一次的结果；键相同、请求体不同 409
 *   · 限流：每人每分钟 arrange_rate_per_minute（缺省 5）件、每天 arrange_rate_per_day（缺省 50）件，管理员在设置里调
 *   · 指名（规范 14 第 3 步，可选 seat_id = 名册里的 seatId）：带了才是指名，不带就是交给团队（总工分派），服务端不默认指名。
 *     只能指名派给的那个画布团队（team 是 <区>/canvas/<名>）里 role=member 的席位；团队和名册按（宿主节点键, 团队地址）对，
 *     节点键由这条通知绑定的根地址到名册里查。谁能指名谁用 team-relation 的 relationOf：成员的主人指名分给自己的席位（own-seat，
 *     缺省不过目，review:true 时由本人过目）；团队负责人指名本团队任何成员（lead-directed，不过目）；别人 403。总工不能被指名。
 *     对端宿主名片没声明 directedSeats：退回整队派发（不写指名），recorded 里记下 directed_fallback 留痕。
 * 调用方（路由）已经认过人：requester 是经身份服务认出来的、启用的人。
 */
export type ArrangeOutcome = { status: number; body: Record<string, unknown> };
const ARRANGE_KEY = /^[A-Za-z0-9_-]{16,64}$/;
const DUE = /^\d{4}-\d{2}-\d{2}$/;
const sqlTime = (d: Date) => d.toISOString().replace('T', ' ').slice(0, 19);
function settingInt(key: string, fallback: number): number {
  const v = (svc<SettingService>('setting').get(key) as { value?: unknown } | undefined)?.value;
  const n = typeof v === 'string' && /^\d{1,6}$/.test(v) ? Number(v) : NaN;
  return n >= 1 ? n : fallback;
}
export function arrangeLimits(): { perMinute: number; perDay: number; staffDirect: boolean } {
  const direct = (svc<SettingService>('setting').get('staff_direct_dispatch') as { value?: unknown } | undefined)?.value;
  return { perMinute: settingInt('arrange_rate_per_minute', 5), perDay: settingInt('arrange_rate_per_day', 50), staffDirect: direct === 'on' };
}

const SEAT_ID = /^seat-[0-9a-f]{8}$/;
const CANVAS_TEAM = /^([a-z0-9-]+)\/canvas\/([^/]+)$/i;

/**
 * 「安排一件事」带了 seat_id：核这个席位能不能被这个人指名，返回交给方式；不行返回 400 / 403。
 * fallback=true：对端宿主名片没声明 directedSeats，退回整队派发（调用方不写指名、留痕）。
 */
function directedSeat(team: string, notifyUrl: string, seatId: string, requester: string): { handoff: 'own-seat' | 'lead-directed'; fallback: boolean } | ArrangeOutcome {
  const no = (status: number, error: string): ArrangeOutcome => ({ status, body: { error } });
  if (!directedSeatsDeclared()) return no(400, 'directed_seats_off');
  const m = CANVAS_TEAM.exec(team);
  if (!m) return no(400, 'team_not_canvas');
  const teamKey = `${m[1].toLowerCase()}/canvas/${m[2]}`;
  const host = rosterHostOfRoot(peerRootOf(notifyUrl));
  if (!host) return no(400, 'roster_unavailable');
  const seat = rosterSeatById(host, teamKey, seatId);
  if (!seat) return no(400, 'seat_not_in_team');
  if (seat.role === 'router') return no(400, 'seat_is_router');
  if (seat.role !== 'member') return no(400, 'seat_not_member');
  const rel = relationOf({ principal: requester }, { seat: { host, team: teamKey, seat: seat.seat, seat_id: seatId } }).relations;
  const handoff = rel.includes('seat-owner') ? 'own-seat' as const : rel.includes('team-lead') ? 'lead-directed' as const : null;
  if (!handoff) return no(403, 'seat_not_directable');
  return { handoff, fallback: !svc<A2aPeerService>('a2aPeers').declares(notifyUrl, 'directedSeats') };
}

export function arrangeTask(raw: unknown, requester: string, now: Date = new Date()): ArrangeOutcome {
  const b = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const str = (k: string) => (typeof b[k] === 'string' ? (b[k] as string).trim() : b[k] === undefined || b[k] === null ? '' : null);
  const bad = (error: string, extra: Record<string, unknown> = {}): ArrangeOutcome => ({ status: 400, body: { error, ...extra } });
  const need: [string, number][] = [['title', 200], ['intent', 4000], ['deliverable', 2000]];
  const v: Record<string, string> = {};
  for (const [k, max] of need) {
    const x = str(k);
    if (x === null || x === '') return bad(`${k}_required`);
    if (x.length > max) return bad(`${k}_too_long`, { max });
    v[k] = x;
  }
  for (const k of ['object', 'phase']) {
    const x = str(k);
    if (x === null || x.length > 200) return bad(`${k}_invalid`, { max: 200 });
    v[k] = x;
  }
  const due = str('due');
  if (due === null || (due !== '' && !DUE.test(due))) return bad('due_invalid');
  if (b.review !== undefined && typeof b.review !== 'boolean') return bad('review_invalid');
  const review = b.review !== false;
  const key = typeof b.idempotency_key === 'string' ? b.idempotency_key : '';
  if (!ARRANGE_KEY.test(key)) return bad('idempotency_key_invalid');
  const team = str('team');
  if (team === null || team === '') return bad('team_required');
  // 从哪个驾驶舱安排的（可选，驾驶舱的 id）：形状不对、驾驶舱不存在都 400。算进幂等的请求体哈希（没给时不进，旧的哈希不变）
  let cockpitId: number | undefined;
  if (b.cockpit_id !== undefined && b.cockpit_id !== null) {
    if (typeof b.cockpit_id !== 'number' || !Number.isInteger(b.cockpit_id) || b.cockpit_id < 1 || b.cockpit_id > COCKPIT_ID_MAX) return bad('cockpit_id_invalid');
    if (!svc<CockpitService>('cockpit').byId(b.cockpit_id)) return bad('cockpit_not_found');
    cockpitId = b.cockpit_id;
  }
  const seatId = str('seat_id');
  if (seatId === null || (seatId !== '' && !SEAT_ID.test(seatId))) return bad('seat_id_invalid');
  const payload = JSON.stringify({ title: v.title, intent: v.intent, deliverable: v.deliverable, team, object: v.object, phase: v.phase, due, review, ...(cockpitId ? { cockpit_id: cockpitId } : {}), ...(seatId ? { seat_id: seatId } : {}) });
  const sha = createHash('sha256').update(payload, 'utf8').digest('hex');
  const tasks = svc<TaskCenterService>('taskCenter');
  const items = svc<WorkItemService>('workItems');
  const view = (taskId: number, eventId: string, duplicate: boolean, extra: Record<string, unknown> = {}) => {
    const item = items.get(itemIdForEvent(eventId));
    return { item_id: itemIdForEvent(eventId), task_id: taskId, event_id: eventId, state: item?.state ?? null, held: item?.state === 'held', duplicate, ...extra };
  };
  tasks.arrangeBegin();
  try {
    const prev = tasks.arrangeRequest(requester, key);
    if (prev) {
      tasks.arrangeRollback();
      if (prev.body_sha256 !== sha) return { status: 409, body: { error: 'idempotency_conflict' } };
      return { status: 200, body: view(prev.task_id, prev.event_id, true) };
    }
    const limits = arrangeLimits();
    if (tasks.arrangeCountSince(requester, sqlTime(new Date(now.getTime() - 60_000))) >= limits.perMinute) { tasks.arrangeRollback(); return { status: 429, body: { error: 'rate_limited', window: 'minute', limit: limits.perMinute } }; }
    if (tasks.arrangeCountSince(requester, sqlTime(new Date(now.getTime() - 86_400_000))) >= limits.perDay) { tasks.arrangeRollback(); return { status: 429, body: { error: 'rate_limited', window: 'day', limit: limits.perDay } }; }
    const target = assignableTeams().find((t) => t.agent_node === team);
    if (!target) { tasks.arrangeRollback(); return bad('team_not_assignable'); }
    const directed = seatId ? directedSeat(team, target.notify_url, seatId, requester) : null;
    if (directed && 'status' in directed) { tasks.arrangeRollback(); return directed; }
    // 指名自己的席位缺省不过目（review:true 才由本人过目）；负责人指名不过目；交给团队照旧（缺省先过目）
    const reviewNow = directed ? (directed.handoff === 'own-seat' ? b.review === true : false) : review;
    const centerOn = taskCenterPolicy().agent_dispatch_enabled;
    const direct = !reviewNow && centerOn && limits.staffDirect;
    const at = sqlTime(now);
    const taskId = tasks.insertArranged({ title: v.title, payload, sha256: sha, requester, dispatch: direct, at });
    const fields: Record<string, unknown> = { title: v.title, intent: v.intent, references: '', deliverable: v.deliverable, target: team, due };
    const eventId = recordTaskCenterEvent({
      id: taskId, data: fields, stepValue: (k) => fields[k], publishedBy: requester, requesterPrincipal: requester, publisherPrincipal: requester,
      templateVersion: null, materialSha256: sha, agentDispatch: direct, centerOn,
      arranged: { team, submitter: requester, ...(v.object ? { object: v.object } : {}), ...(v.phase ? { phase: v.phase } : {}), ...(cockpitId ? { cockpitId } : {}),
        ...(directed ? { handoff: directed.handoff, reviewBy: directed.handoff === 'own-seat' && reviewNow ? 'requester' as const : '' as const,
          ...(directed.fallback ? { directedFallback: { seat_id: seatId, reason: 'peer_not_declared' } } : { directedSeatId: seatId }) } : {}) },
    });
    tasks.insertArrangeRequest({ requester, key, sha256: sha, taskId, eventId, at });
    tasks.arrangeCommit();
    return { status: 201, body: view(taskId, eventId, false, { ...(!reviewNow && !direct ? { reason: 'review_required_by_policy' } : {}), ...(directed ? { handoff: directed.handoff, directed: directed.fallback ? 'fallback_team' : 'seat' } : {}) }) };
  } catch (e) {
    try { tasks.arrangeRollback(); } catch { /* 已经回滚 */ }
    throw e;
  }
}
