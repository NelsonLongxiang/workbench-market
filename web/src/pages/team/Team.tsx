/**
 * 「团队」页（规范 14 第一、二、五、十节；骨架和密度照产品化原型 3fbfd0b 的 #/team：按部门分块、成员卡片）。
 *
 * 数据只来自 GET /api/teams：服务端已经按看的人裁好（部门 → 团队 → 成员；待认领的单列，只给管理员）。页面只渲染，
 * 不自己拼部门、名册、分配，也不自己判谁能做什么。判断逻辑（整形、说法、校验）在 team-view.ts。
 *
 * 操作：
 *   · 管理员（应答里有「待认领的团队」这一栏）：把待认领的团队挂到部门、顺带指定一位负责人；没有部门时先建部门。
 *     关系确认制（#638）：不是属主、管理层的人认领、指定负责人，服务端只记成提议（202）——页面说「已提出，等〈谁〉确认」，
 *     那一项标「待确认」，不当成已生效；按钮照服务端的 can（claim / propose_claim、add_lead / propose_lead）出现。确认、撤回不在这一版。
 *   · 负责人在成员卡上「分配给…」「收回」：接口还没给「当前的人能不能分配」，这一版只读，等服务端给了再接。
 * 不做：工作方式开关、本周办结和通过率、技能、招 AI 员工（没有数据，不放占位）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Empty, Input, Select, Skeleton, Tag } from 'antd';
import WmPage from '../../components/WmPage';
import { addTeamLead, approveRelationProposal, attentionChanged, claimTeam, getRelationProposals, getTeamDepartments, getTeamPeople, getTeams, putDepartment, rejectRelationProposal } from '../../api';
import RelTime from '../../components/RelTime';
import { subscribeAdminToken } from '../../admin-token';
import {
  actionProblem, pendingText, proposedText, claimButtonText, LEAD_SKIPPED_TEXT, proposalsOf, knownNames, proposalTitle, proposerText, proposalGroups, rejectLabel, outcomeLabel, outcomeReasonText, assignedText, memberlessText, departmentsOf, emptyText, isAdminView, leadsOf, newDeptProblem, personName, memberLabel, nodeLabel, rosterStaleText, sourceProblem,
  teamCounts, teamStatusLabel, teamTitle, teamsOf,
} from '../../team-view';
import type { Department, KnownNames, Member, Proposal, SourceResult, Team as TeamT, TeamsCan, Tone } from '../../team-view';

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
    <div className="wm-team-member" data-testid={chief ? 'team-router' : 'team-member'}>
      <div className="wm-team-member-head">
        <span className={m.online ? 'wm-team-dot on' : 'wm-team-dot'} title={m.online ? '在线' : '不在线'} />
        <b className="wm-team-member-name">{memberLabel(m)}</b>
        {chief && <span className="wm-team-kind">总工</span>}
      </div>
      <div className="wm-team-member-meta">
        <span>{m.active_items > 0 ? `在办 ${m.active_items} 件` : '手上没有在办的'}</span>
        <span className={m.assigned_to ? 'wm-team-assigned' : 'wm-team-shared'} data-testid="team-assigned">{chief ? '只对负责人' : assignedText(m)}</span>
      </div>
    </div>
  );
}

function TeamBlock({ t, nameOf }: { t: TeamT; nameOf: (id: string) => string }) {
  const s = teamStatusLabel(t.status);
  const leads = leadsOf(t);
  const n = teamCounts(t);
  const stale = rosterStaleText(t, Date.now());
  return (
    <div className="wm-team-team" data-testid="team-team">
      <div className="wm-team-head">
        <div className="wm-team-head-top"><b>{teamTitle(t)}</b><Tag color={TAG[s.tone]} className="wm-team-st">{s.text}</Tag></div>
        <div className="wm-team-head-meta">
          <span>负责人：{leads.length ? leads.map((l) => l.name + (l.viaDepartment ? '（部门负责人）' : '')).join('、') : '没有在职的负责人'}</span>
          <span>总工：{t.router ? memberLabel(t.router) : '名册里没有总工'}</span>
          <span>{n.members} 个成员 · 在办 {n.active} 件</span>
        </div>
        {stale && <div className="wm-team-stale" data-testid="team-roster-stale">{stale}</div>}
        {(t.pending_leads ?? []).map((p) => (
          <div key={p.id} className="wm-team-pending" data-testid="team-lead-pending">负责人待确认：{p.principal ? nameOf(p.principal) : '（没写是谁）'}，{pendingText(p)}</div>
        ))}
      </div>
      {t.router && <MemberCard m={t.router} chief />}
      {t.members.map((m) => <MemberCard key={`${m.seat}-${m.seat_id}`} m={m} />)}
      {t.members.length === 0 && <div className="wm-team-none">{memberlessText(t)}</div>}
    </div>
  );
}

/** 待认领的团队：挂到部门，顺带指定一位负责人（可不选：部门负责人自动是团队负责人） */
function ClaimCard({ t, depts, people, can, onDone, onNotice }: { t: TeamT; depts: Department[]; people: Person[]; can: TeamsCan | null; onDone: () => void; onNotice: (text: string) => void }) {
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
    const claimProposed = p ? null : proposedText(r);
    // 认领只是提议时，团队还没挂上，负责人这一步做不了（等认领确认之后再指定）
    if (claimProposed) onNotice(`认领「${teamTitle(t)}」${claimProposed}。${lead ? LEAD_SKIPPED_TEXT : ''}`);
    else if (!p && lead) {
      const lr = await addTeamLead(t.host, t.team, lead);
      p = actionProblem(lr);
      const leadProposed = p ? null : proposedText(lr);
      if (leadProposed) onNotice(`「${teamTitle(t)}」已认领；负责人${leadProposed}。`);
    }
    setBusy(false);
    if (p) setErr(p); else onDone();
  };
  const pending = t.pending_claim;
  const claimText = claimButtonText(can);
  const canClaim = claimText !== null;
  // 认领是直接生效还是只记成提议，服务端按接收部门定（接收部门的负责人能直接认领），页面事先不知道：
  // 负责人照旧可选；结果是提议时，负责人这一步跳过，提示里说清楚（LEAD_SKIPPED_TEXT）
  const canLead = !can || can.add_lead || can.propose_lead;
  return (
    <div className="wm-team-claim" data-testid="team-unclaimed">
      <div className="wm-team-head-top"><b>{teamTitle(t)}</b><Tag color="warning" className="wm-team-st" data-testid="team-claim-state">{pending ? '待确认' : '待认领'}</Tag></div>
      <div className="wm-team-head-meta">
        <span>总工：{t.router ? memberLabel(t.router) : '名册里没有总工'}</span>
        <span>{n.members} 个成员{nodeLabel(t) ? ` · 来自 ${nodeLabel(t)}` : ''}</span>
      </div>
      {pending ? (
        <div className="wm-team-pending" data-testid="team-claim-pending">挂到{depts.find((d) => d.id === pending.department)?.name ?? pending.department ?? '部门'}：{pendingText(pending)}</div>
      ) : !canClaim ? null : depts.length === 0 ? <div className="wm-team-none">先建部门，才能把团队挂上去。</div> : (
        <div className="wm-team-claim-form">
          <Select size="small" placeholder="挂到哪个部门" value={dept} onChange={setDept} options={depts.map((d) => ({ value: d.id, label: d.lead ? `${d.name}（负责人 ${personName(d.lead)}）` : d.name }))} data-testid="team-claim-dept" className="wm-team-select" />
          {canLead && <Select size="small" allowClear placeholder={can && !can.add_lead ? '另外提议负责人（可不选）' : '另外指定负责人（可不选）'} value={lead} onChange={setLead} options={people.map((p) => ({ value: p.id, label: p.name }))} showSearch optionFilterProp="label" data-testid="team-claim-lead" className="wm-team-select" />}
          <Button size="small" type="primary" disabled={!dept} loading={busy} onClick={submit} data-testid="team-claim" autoInsertSpace={false}>{claimText}</Button>
        </div>
      )}
      {err && <Alert className="wm-team-err" type="warning" showIcon message={err} />}
    </div>
  );
}

function NewDepartment({ depts, people, onDone, onCancel, onNotice }: { depts: Department[]; people: Person[]; onDone: () => void; onCancel: () => void; onNotice: (text: string) => void }) {
  const [name, setName] = useState('');
  const [id, setId] = useState('');
  const [lead, setLead] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const problem = newDeptProblem(id, name, depts);
  const submit = async () => {
    if (problem) return;
    setBusy(true); setErr(null);
    const r = await putDepartment(id.trim(), name.trim(), lead ?? null);
    const p = actionProblem(r);
    const leadProposed = p ? null : proposedText(r);
    // 部门建好了；指定的负责人只记成提议时，说清楚还没生效
    if (leadProposed) onNotice(`部门「${name.trim()}」已建好；负责人${leadProposed}。`);
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

/** 一条待确认的关系提议：照服务端给的 can_approve、can_reject 出「确认」「驳回 / 撤回」；不能确认的写服务端的说法 */
function ProposalCard({ p, names, onDone }: { p: Proposal; names: KnownNames; onDone: () => void }) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const rl = rejectLabel(p);
  const pend = p.outcome === 'pending';
  const ol = outcomeLabel(p), why = outcomeReasonText(p);
  const canConfirm = pend && p.can_approve && p.mine !== true;
  const act = async (fn: () => Promise<SourceResult>) => {
    setBusy(true); setErr(null);
    const e = actionProblem(await fn());
    setBusy(false);
    if (e) { setErr(e); return; }
    attentionChanged(); // 「等你拍板」里同一条提议跟着消失，侧栏角标重读
    onDone();
  };
  return (
    <div className="wm-team-prop" data-testid="team-proposal" data-kind={p.kind}>
      <div className="wm-team-head-top"><b>{proposalTitle(p, names)}</b><Tag color={TAG[ol.tone]} className="wm-team-st" data-testid="team-proposal-outcome">{ol.text}</Tag></div>
      <div className="wm-team-head-meta">
        <span>{p.mine === true ? '你提的' : `${proposerText(p, names)} 提的`}{p.proposed_at > 0 && <> · <RelTime value={new Date(p.proposed_at).toISOString()} /></>}</span>
        {pend && <span>等{p.confirm_by_text}确认</span>}
        {why && <span data-testid="team-proposal-reason-text">{why}</span>}
        {pend && !p.can_approve && p.mine !== true && p.approve_denied_text && <span data-testid="team-proposal-denied">{p.approve_denied_text}</span>}
      </div>
      {rejecting ? (
        <div className="wm-team-prop-reject">
          <Input.TextArea size="small" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} autoSize={{ minRows: 1, maxRows: 3 }} placeholder={p.mine === true ? '为什么撤回（可不写）' : '为什么不同意（可不写，会留痕）'} data-testid="team-proposal-reason" />
          <div className="wm-team-prop-ops">
            <Button size="small" danger loading={busy} onClick={() => act(() => rejectRelationProposal(p.id, reason.trim()))} data-testid="team-proposal-reject-confirm">确认{rl}</Button>
            <Button size="small" autoInsertSpace={false} type="text" disabled={busy} onClick={() => { setRejecting(false); setReason(''); }}>算了</Button>
          </div>
        </div>
      ) : canConfirm || rl ? (
        <div className="wm-team-prop-ops">
          {canConfirm && <Button size="small" type="primary" loading={busy} onClick={() => act(() => approveRelationProposal(p.id))} data-testid="team-proposal-approve" autoInsertSpace={false}>确认</Button>}
          {rl && <Button size="small" disabled={busy} onClick={() => setRejecting(true)} data-testid="team-proposal-reject" autoInsertSpace={false}>{rl}</Button>}
        </div>
      ) : null}
      {err && <Alert className="wm-team-err" type="warning" showIcon message={err} />}
    </div>
  );
}

/** 待确认的关系：等你确认的、你提的、别的（管理员看得到的）三组；每组没有就不出 */
function ProposalsSection({ list, names, onDone }: { list: Proposal[]; names: KnownNames; onDone: () => void }) {
  const g = proposalGroups(list);
  const group = (key: string, title: string, cap: string, items: Proposal[]) => items.length === 0 ? null : (
    <section className="wm-team-props" data-testid={`team-proposals-${key}`}>
      <div className="wm-team-sec"><h3>{title}</h3><span className="wm-team-n">{items.length}</span><span className="wm-team-cap">{cap}</span></div>
      <div className="wm-team-claims">{items.map((p) => <ProposalCard key={p.id} p={p} names={names} onDone={onDone} />)}</div>
    </section>
  );
  return (
    <>
      {group('for-me', '等你确认', '认领、指定负责人会带来权限，要能确认的人点头才生效；「等你拍板」里的同一条，这里办了那边就没了。', g.forMe)}
      {group('mine', '你提的', '还没确认之前关系不生效，不带来权限；不需要了可以撤回。处理过的留几天，看得到结局和原因。', g.mine)}
      {group('others', '还在等别人确认', '你看得到，但不归你确认。', g.others)}
    </>
  );
}

export default function Team() {
  const [src, setSrc] = useState<{ teams: SourceResult | null; depts: SourceResult | null; people: SourceResult | null; proposals: SourceResult | null }>({ teams: null, depts: null, people: null, proposals: null });
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => subscribeAdminToken(reload), [reload]);
  useEffect(() => {
    let live = true;
    setLoading(true);
    void Promise.all([getTeams(), getTeamDepartments(), getRelationProposals()]).then(async ([teams, depts, proposals]) => {
      // 人的列表只有管理员读得到，也只在管理员的操作里用：是管理员的视图才去读
      const admin = ok(teams) && isAdminView(teamsOf(teams.body));
      const people = admin ? await getTeamPeople() : null;
      if (!live) return;
      setSrc({ teams, depts, people, proposals });
      setLoading(false);
    });
    return () => { live = false; };
  }, [tick]);

  const t = useMemo(() => teamsOf(ok(src.teams) ? src.teams!.body : null), [src]);
  const depts = useMemo(() => (ok(src.depts) ? departmentsOf(src.depts!.body) : null), [src]);
  const people = useMemo(() => (ok(src.people) ? peopleOf(src.people!.body) : []), [src]);
  const nameOf = (id: string) => people.find((p) => p.id === id)?.name ?? '一位同事';
  const proposals = useMemo(() => (ok(src.proposals) ? proposalsOf(src.proposals!.body) : []), [src]);
  const names = useMemo(() => knownNames(t, depts, people), [t, depts, people]);
  const admin = isAdminView(t);
  const done = () => { setCreating(false); reload(); };

  const problem = sourceProblem('团队', src.teams);
  const empty = problem || loading ? null : emptyText(t, depts, admin);
  const canCreateDept = admin && depts !== null;

  return (
    <WmPage wide loading={loading} extra={canCreateDept && depts!.length > 0 && !creating ? <Button onClick={() => setCreating(true)} data-testid="team-newdept-open">建部门</Button> : undefined}>
      <p className="wm-team-intro">每个部门有负责的人，部门下面挂着 AI 团队。团队的负责人直接对接它的总工；成员可以分配给某位员工直接用，没分配的是团队公用，由总工分派。</p>
      {problem && <Alert className="wm-team-alert" type={problem.type} showIcon message={problem.text} />}
      {notice && <Alert className="wm-team-alert" type="info" showIcon closable onClose={() => setNotice(null)} message={notice} data-testid="team-notice" />}
      {!loading && proposals.length > 0 && <ProposalsSection list={proposals} names={names} onDone={reload} />}
      {creating && depts && <NewDepartment depts={depts} people={people} onDone={done} onCancel={() => setCreating(false)} onNotice={setNotice} />}
      {empty && (
        <Empty className="wm-team-empty" image={Empty.PRESENTED_IMAGE_SIMPLE} description={<span data-testid="team-empty">{empty}</span>}>
          {canCreateDept && depts!.length === 0 && !creating && <Button type="primary" onClick={() => setCreating(true)} data-testid="team-newdept-cta">建部门</Button>}
        </Empty>
      )}
      {t.departments.length > 0 && (
        <div className="wm-team-depts">{t.departments.map((d) => (
          <section key={d.id} className="wm-team-dept" data-testid="team-dept" data-id={d.id}>
            <div className="wm-team-dept-head"><h3>{d.name}</h3><span className="wm-team-cap">{d.lead ? `负责人 ${personName(d.lead)}` : '部门还没有负责人'}</span>
              {d.pending_lead && <span className="wm-team-pending" data-testid="team-dept-lead-pending">负责人待确认：{d.pending_lead.principal ? nameOf(d.pending_lead.principal) : '（没写是谁）'}，{pendingText(d.pending_lead)}</span>}</div>
            <div className="wm-team-cap wm-team-dept-n">{d.teams.length} 个团队</div>
            {d.teams.map((x) => <TeamBlock key={`${x.host}-${x.team}`} t={x} nameOf={nameOf} />)}
          </section>
        ))}</div>
      )}
      {admin && (t.unclaimed?.length ?? 0) > 0 && (
        <section className="wm-team-unclaimed">
          <div className="wm-team-sec"><h3>待认领的团队</h3><span className="wm-team-n">{t.unclaimed!.length}</span><span className="wm-team-cap">只有管理员看得到。挂到部门之后，部门负责人就是团队的负责人，部门里的人才能往这个团队安排事情。</span></div>
          <div className="wm-team-claims">{t.unclaimed!.map((x) => <ClaimCard key={`${x.host}-${x.team}`} t={x} depts={depts ?? []} people={people} can={t.can} onDone={reload} onNotice={setNotice} />)}</div>
        </section>
      )}
    </WmPage>
  );
}
