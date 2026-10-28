// #159 task intake: one seed, one published task per completed run.
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { db } from './db.ts';

export const taskCenterSteps = [
  { key: 'title', title: '任务标题' }, { key: 'intent', title: '任务意图' },
  { key: 'references', title: '基准材料' }, { key: 'deliverable', title: '提交物要求' },
  { key: 'target', title: '目标 SOP 台' }, { key: 'due', title: '截止日期' },
];
export function initializeTaskCenter(appsRoot: string) {
  const cols = db.prepare('PRAGMA table_info(tasks)').all() as {name:string}[];
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
export function publishTaskIntake(body: any) {
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
    db.exec('COMMIT');
    return {ok:true,id,status:'published',intake_run_id:runId,template_version:run.sop_version,material_sha256:hash};
  } catch(e) {db.exec('ROLLBACK');throw e;}
}
