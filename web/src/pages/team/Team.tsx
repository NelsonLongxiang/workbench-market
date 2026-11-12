/**
 * 「团队」页（规范 14 第一、二、五、十节；骨架和密度照产品化原型 3fbfd0b 的 #/team：按部门分块、成员卡片）。
 *
 * 数据只来自 GET /api/teams：服务端已经按看的人裁好（部门 → 团队 → 成员；待认领的单列，只给管理员）。页面只渲染，
 * 不自己拼部门、名册、分配，也不自己判谁能做什么。判断逻辑（整形、说法、校验）在 team-view.ts。
 *
 * 操作：
 *   · 管理员（应答里有「待认领的团队」这一栏）：把待认领的团队挂到部门、顺带指定一位负责人；没有部门时先建部门。
 *   · 负责人在成员卡上「分配给…」「收回」：接口还没给「当前的人能不能分配」，这一版只读，等服务端给了再接。
 * 不做：工作方式开关、本周办结和通过率、技能、招 AI 员工（没有数据，不放占位）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Empty, Input, Select, Skeleton, Tag } from 'antd';
import WmPage from '../../components/WmPage';
import { seatLabel } from '../../people';
import { addTeamLead, claimTeam, getTeamDepartments, getTeamPeople, getTeams, putDepartment } from '../../api';
import { subscribeAdminToken } from '../../admin-token';
import {
  actionProblem, assignedText, memberlessText, departmentsOf, emptyText, isAdminView, leadsOf, newDeptProblem, personName, seatRaw, sourceProblem,
  teamCounts, teamStatusLabel, teamTitle, teamsOf,
} from '../../team-view';
import type { Department, Member, SourceResult, Team as TeamT, Tone } from '../../team-view';

const TAG: Record<Tone, string> = { success: 'success', warning: 'warning', danger: 'error', default: 'default' };
const ok = (r: SourceResult | null) => !!r && r.status >= 200 && r.status < 300;
type Person = { id: string; name: string };

function peopleOf(body: unknown): Person[] {
  const list = body && typeof body === 'object' && Array.isArray((body as { principals?: unknown }).principals) ? (body as { principals: unknown[] }).principals : [];
  return list.flatMap((p) => {
    const o = p as { id?: unknown; kind?: unknown; status?: unknown; display_name?: unknown };
    if (typeof o?.id !== 'string' || o.kind !== 'person' || o.status !== 'active') return [];
    return [{ id: o.id, name: personName({ principal: o.id, display_name: typeof o.display_name === 'string' ? o.display_name : '' }) }];
  }).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

function MemberCard({ m, chief }: { m: Member; chief?: boolean }) {
  return (
    <div className="wm-team-member" data-testid={chief ? 'team-router' : 'team-member'} data-seat={m.seat}>
      <div className="wm-team-member-head">
        <span className={m.online ? 'wm-team-dot on' : 'wm-team-dot'} title={m.online ? '在线' : '不在线'} />
        <b className="wm-team-member-name">{seatLabel(seatRaw(m))}</b>
        {chief && <span className="wm-team-kind">总工</span>}
      </div>
      <div className="wm-team-member-meta">
        <span>{m.active_items > 0 ? `在办 ${m.active_items} 件` : '手上没有在办的'}</span>
        <span className={m.assigned_to ? 'wm-team-assigned' : 'wm-team-shared'} data-testid="team-assigned">{chief ? '只对负责人' : assignedText(m)}</span>
      </div>
    </div>
  );
}

function TeamBlock({ t }: { t: TeamT }) {
  const s = teamStatusLabel(t.status);
  const leads = leadsOf(t);
  const n = teamCounts(t);
  return (
    <div className="wm-team-team" data-testid="team-team" data-team={t.team} data-status={t.status}>
      <div className="wm-team-head">
        <div className="wm-team-head-top"><b>{teamTitle(t)}</b><Tag color={TAG[s.tone]} className="wm-team-st">{s.text}</Tag></div>
        <div className="wm-team-head-meta">
          <span>负责人：{leads.length ? leads.map((l) => l.name + (l.viaDepartment ? '（部门负责人）' : '')).join('、') : '没有在职的负责人'}</span>
          <span>总工：{t.router ? seatLabel(seatRaw(t.router)) : '名册里没有总工'}</span>
          <span>{n.members} 个成员 · 在办 {n.active} 件</span>
        </div>
      </div>
      {t.router && <MemberCard m={t.router} chief />}
      {t.members.map((m) => <MemberCard key={`${m.seat}-${m.seat_id}`} m={m} />)}
      {t.members.length === 0 && <div className="wm-team-none">{memberlessText(t)}</div>}
    </div>
  );
}

/** 待认领的团队：挂到部门，顺带指定一位负责人（可不选：部门负责人自动是团队负责人） */
function ClaimCard({ t, depts, people, onDone }: { t: TeamT; depts: Department[]; people: Person[]; onDone: () => void }) {
  const [dept, setDept] = useState<string | undefined>();
  const [lead, setLead] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const n = teamCounts(t);
  const submit = async () => {
    if (!dept) return;
    setBusy(true); setErr(null);
    const r = await claimTeam(t.host, t.team, dept);
    let p = actionProblem(r);
    if (!p && lead) p = actionProblem(await addTeamLead(t.host, t.team, lead));
    setBusy(false);
    if (p) setErr(p); else onDone();
  };
  return (
    <div className="wm-team-claim" data-testid="team-unclaimed" data-team={t.team}>
      <div className="wm-team-head-top"><b>{teamTitle(t)}</b><Tag color="warning" className="wm-team-st">待认领</Tag></div>
      <div className="wm-team-head-meta">
        <span>总工：{t.router ? seatLabel(seatRaw(t.router)) : '名册里没有总工'}</span>
        <span>{n.members} 个成员 · 节点 {t.host}</span>
      </div>
      {depts.length === 0 ? <div className="wm-team-none">先建部门，才能把团队挂上去。</div> : (
        <div className="wm-team-claim-form">
          <Select size="small" placeholder="挂到哪个部门" value={dept} onChange={setDept} options={depts.map((d) => ({ value: d.id, label: d.lead ? `${d.name}（负责人 ${personName(d.lead)}）` : d.name }))} data-testid="team-claim-dept" className="wm-team-select" />
          <Select size="small" allowClear placeholder="另外指定负责人（可不选）" value={lead} onChange={setLead} options={people.map((p) => ({ value: p.id, label: p.name }))} showSearch optionFilterProp="label" data-testid="team-claim-lead" className="wm-team-select" />
          <Button size="small" type="primary" disabled={!dept} loading={busy} onClick={submit} data-testid="team-claim">认领</Button>
        </div>
      )}
      {err && <Alert className="wm-team-err" type="warning" showIcon message={err} />}
    </div>
  );
}

function NewDepartment({ depts, people, onDone, onCancel }: { depts: Department[]; people: Person[]; onDone: () => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [id, setId] = useState('');
  const [lead, setLead] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const problem = newDeptProblem(id, name, depts);
  const submit = async () => {
    if (problem) return;
    setBusy(true); setErr(null);
    const p = actionProblem(await putDepartment(id.trim(), name.trim(), lead ?? null));
    setBusy(false);
    if (p) setErr(p); else onDone();
  };
  return (
    <div className="wm-team-newdept" data-testid="team-newdept">
      <b>建一个部门</b>
      <div className="wm-team-newdept-row">
        <Input size="small" placeholder="部门名称，比如 运营部" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} data-testid="team-newdept-name" />
        <Input size="small" placeholder="标识，比如 ops（以后不能改）" value={id} onChange={(e) => setId(e.target.value)} maxLength={48} data-testid="team-newdept-id" />
        <Select size="small" allowClear placeholder="部门负责人（可以以后再定）" value={lead} onChange={setLead} options={people.map((p) => ({ value: p.id, label: p.name }))} showSearch optionFilterProp="label" data-testid="team-newdept-lead" className="wm-team-select" />
      </div>
      <div className="wm-team-newdept-row">
        <span className="wm-team-hint">{(name || id) && problem ? problem : '部门负责人会自动成为挂在这个部门下的团队的负责人。'}</span>
        <Button size="small" type="primary" disabled={!!problem} loading={busy} onClick={submit} data-testid="team-newdept-save">建部门</Button>
        <Button size="small" type="text" disabled={busy} onClick={onCancel}>算了</Button>
      </div>
      {err && <Alert className="wm-team-err" type="warning" showIcon message={err} />}
    </div>
  );
}

export default function Team() {
  const [src, setSrc] = useState<{ teams: SourceResult | null; depts: SourceResult | null; people: SourceResult | null }>({ teams: null, depts: null, people: null });
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const [creating, setCreating] = useState(false);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => subscribeAdminToken(reload), [reload]);
  useEffect(() => {
    let live = true;
    setLoading(true);
    void Promise.all([getTeams(), getTeamDepartments()]).then(async ([teams, depts]) => {
      // 人的列表只有管理员读得到，也只在管理员的操作里用：是管理员的视图才去读
      const admin = ok(teams) && isAdminView(teamsOf(teams.body));
      const people = admin ? await getTeamPeople() : null;
      if (!live) return;
      setSrc({ teams, depts, people });
      setLoading(false);
    });
    return () => { live = false; };
  }, [tick]);

  const t = useMemo(() => teamsOf(ok(src.teams) ? src.teams!.body : null), [src]);
  const depts = useMemo(() => (ok(src.depts) ? departmentsOf(src.depts!.body) : null), [src]);
  const people = useMemo(() => (ok(src.people) ? peopleOf(src.people!.body) : []), [src]);
  const admin = isAdminView(t);
  const done = () => { setCreating(false); reload(); };

  const problem = sourceProblem('团队', src.teams);
  const empty = problem || loading ? null : emptyText(t, depts, admin);
  const canCreateDept = admin && depts !== null;

  return (
    <WmPage wide loading={loading} extra={canCreateDept && depts!.length > 0 && !creating ? <Button onClick={() => setCreating(true)} data-testid="team-newdept-open">建部门</Button> : undefined}>
      <p className="wm-team-intro">每个部门有负责的人，部门下面挂着 AI 团队。团队的负责人直接对接它的总工；成员可以分配给某位员工直接用，没分配的是团队公用，由总工分派。</p>
      {problem && <Alert className="wm-team-alert" type={problem.type} showIcon message={problem.text} />}
      {creating && depts && <NewDepartment depts={depts} people={people} onDone={done} onCancel={() => setCreating(false)} />}
      {empty && (
        <Empty className="wm-team-empty" image={Empty.PRESENTED_IMAGE_SIMPLE} description={<span data-testid="team-empty">{empty}</span>}>
          {canCreateDept && depts!.length === 0 && !creating && <Button type="primary" onClick={() => setCreating(true)} data-testid="team-newdept-cta">建部门</Button>}
        </Empty>
      )}
      {t.departments.length > 0 && (
        <div className="wm-team-depts">{t.departments.map((d) => (
          <section key={d.id} className="wm-team-dept" data-testid="team-dept" data-id={d.id}>
            <div className="wm-team-dept-head"><h3>{d.name}</h3><span className="wm-team-cap">{d.lead ? `负责人 ${personName(d.lead)}` : '部门还没有负责人'}</span></div>
            <div className="wm-team-cap wm-team-dept-n">{d.teams.length} 个团队</div>
            {d.teams.map((x) => <TeamBlock key={`${x.host}-${x.team}`} t={x} />)}
          </section>
        ))}</div>
      )}
      {admin && (t.unclaimed?.length ?? 0) > 0 && (
        <section className="wm-team-unclaimed">
          <div className="wm-team-sec"><h3>待认领的团队</h3><span className="wm-team-n">{t.unclaimed!.length}</span><span className="wm-team-cap">只有管理员看得到。挂到部门之后，部门负责人就是团队的负责人，部门里的人才能往这个团队安排事情。</span></div>
          <div className="wm-team-claims">{t.unclaimed!.map((x) => <ClaimCard key={`${x.host}-${x.team}`} t={x} depts={depts ?? []} people={people} onDone={reload} />)}</div>
        </section>
      )}
    </WmPage>
  );
}
