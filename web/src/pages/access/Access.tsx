/**
 * 谁能做什么（照产品化原型 3fbfd0b 的 #/access）：两个页签。
 *  · 人和权限：上面是「待你核准的授予」卡片（当场核准，或者不给并写理由），下面是给出去的全部权限，按人排。
 *  · 角色预设：每个角色一张卡（几条生效中的授予在用），选一个看它在七大块上能看、能做、能拍板、能管什么；矩阵由服务端算。
 * 第三个页签「以某人的身份看」、红线清单、AI 员工遇到动作怎么办、全部留痕，等身份线的接口，现在不出现（不放占位）。
 * 谁能看：照接口实际返回的来，页面不自己判。授予、主体、角色、矩阵几个接口只给管理员；别人读不到授予时，「人和权限」改用
 * /api/auth/me 带的本人角色显示「你的权限」，下面一句别人的权限谁能看。
 * 判断逻辑在 web/src/access-view.ts（有单测）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Alert, Button, Empty, Input, Skeleton, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import WmPage from '../../components/WmPage';
import { actorLabel } from '../../people';
import { approveAccessGrant, declineAccessGrant, getAccessGrants, getAccessMatrix, getAccessPrincipals, getAccessRoles, getAuthMe } from '../../api';
import { subscribeAdminToken } from '../../admin-token';
import {
  ACCESS_TABS, CELL_LEGEND, actionProblem, cellLabel, declineReasonOk, grantActorRaw, grantRows, grantsOf, indexPrincipals, kindLabel, matrixOf,
  pendingGrants, principalName, responsibleOf, roleName, roleUsage, rolesOf, scopeLabel, scopeNotYetEffective, sourceProblem, statusLabel, tabFromQuery, termLabel, SCOPE_PENDING,
  OTHERS_ONLY_ADMINS, myRolesOf, summaryDo, approvalText, approveState,
} from '../../access-view';
import type { AccessTab, Grant, Principal, RoleInfo, SourceResult, Tone } from '../../access-view';

const TAG: Record<Tone, string> = { success: 'success', warning: 'warning', danger: 'error', default: 'default' };
const ok = (r: SourceResult | null) => !!r && r.status >= 200 && r.status < 300;

type Sources = { grants: SourceResult | null; principals: SourceResult | null; roles: SourceResult | null; matrix: SourceResult | null; me: unknown };
const NONE: Sources = { grants: null, principals: null, roles: null, matrix: null, me: null };

function PendingCard({ g, who, kind, role, by, scope, approval, onDone }: { g: Grant; who: string; kind: string; role: string; by: string; scope: string; approval: string | null; onDone: () => void }) {
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const can = approveState(g);
  const act = async (fn: () => Promise<SourceResult>) => {
    setBusy(true); setErr(null);
    const r = await fn();
    setBusy(false);
    const p = actionProblem(r);
    if (p) setErr(p); else onDone();
  };
  return (
    <div className="wm-acc-ask" data-testid="acc-pending" data-id={g.id}>
      <div className="wm-acc-ask-head">
        <b>{by} 想给 {who} 加一项权限</b>
        {kind && <span className="wm-acc-kind">{kind}</span>}
        <Tag color="warning" className="wm-acc-ask-st">待核准</Tag>
      </div>
      <div className="wm-acc-ask-role">{role}</div>
      <div className="wm-acc-ask-meta">范围：{scope} · 期限：{termLabel(g.expires_at, Date.now())}{g.expires_at !== null ? '，到期自动收回' : ''}{g.reason ? ` · 理由：${g.reason}` : ''}</div>
      {approval && <div className="wm-acc-ask-approval" data-testid="acc-approval">这一项{approval}</div>}
      {declining ? (
        <div className="wm-acc-decline">
          <Input.TextArea data-testid="acc-decline-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} autoSize={{ minRows: 2, maxRows: 4 }} placeholder="写一句为什么不给（会留痕）" />
          <div className="wm-acc-ask-ops">
            <Button size="small" danger disabled={!declineReasonOk(reason)} loading={busy} data-testid="acc-decline-confirm" onClick={() => act(() => declineAccessGrant(g.id, reason.trim()))}>确认不给</Button>
            <Button size="small" type="text" disabled={busy} onClick={() => { setDeclining(false); setReason(''); }}>算了</Button>
          </div>
        </div>
      ) : (
        <div className="wm-acc-ask-ops">
          <Button size="small" type="primary" loading={busy} disabled={!can.enabled} title={can.note ?? undefined} data-testid="acc-approve" onClick={() => act(() => approveAccessGrant(g.id))}>核准</Button>
          <Button size="small" disabled={busy} data-testid="acc-decline" onClick={() => setDeclining(true)}>不给</Button>
          {can.note && <span className="wm-acc-ask-denied" data-testid="acc-approve-denied">{can.note}</span>}
        </div>
      )}
      {err && <Alert className="wm-acc-ask-err" type="warning" showIcon message={err} />}
    </div>
  );
}

export default function Access() {
  const [params, setParams] = useSearchParams();
  const tab = tabFromQuery(params.get('tab'));
  const [src, setSrc] = useState<Sources>(NONE);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const [roleSel, setRoleSel] = useState<string | null>(null);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => subscribeAdminToken(reload), [reload]);
  useEffect(() => {
    let live = true;
    setLoading(true);
    void Promise.all([getAccessGrants(), getAccessPrincipals(), getAccessRoles(), getAccessMatrix(), getAuthMe()]).then(([grants, principals, roles, matrix, me]) => {
      if (!live) return;
      setSrc({ grants, principals, roles, matrix, me });
      setLoading(false);
    });
    return () => { live = false; };
  }, [tick]);

  const grants = useMemo(() => (ok(src.grants) ? grantsOf(src.grants!.body) : []), [src]);
  const people = useMemo<Map<string, Principal>>(() => (ok(src.principals) ? indexPrincipals(src.principals!.body) : new Map()), [src]);
  const roles = useMemo<Map<string, RoleInfo>>(() => (ok(src.roles) ? rolesOf(src.roles!.body) : new Map()), [src]);
  const matrix = useMemo(() => (ok(src.matrix) ? matrixOf(src.matrix!.body) : null), [src]);
  const pending = pendingGrants(grants);
  const rows = grantRows(grants, people);
  const usage = roleUsage(grants);
  const selected = matrix?.roles.find((r) => r.id === roleSel) ?? matrix?.roles[0] ?? null;
  const blocks = useMemo(() => new Map((matrix?.blocks ?? []).map((b) => [b.key, b.name])), [matrix]);
  const byLabel = (raw: unknown) => actorLabel(grantActorRaw(raw, people), '');
  const scopeText = (s: string, name?: unknown) => scopeLabel(s, blocks, name);
  const pick = (t: AccessTab) => setParams(t === 'people' ? {} : { tab: t }, { replace: true });

  const columns: ColumnsType<Grant> = [
    { title: '状态', dataIndex: 'status', width: 120, render: (_v, g) => {
      const s = statusLabel(g.status);
      return <span className="wm-acc-st"><Tag color={TAG[s.tone]}>{s.text}</Tag>{scopeNotYetEffective(g) && <span className="wm-acc-note" title={SCOPE_PENDING}>尚未生效</span>}</span>;
    } },
    { title: '谁', dataIndex: 'principal_id', render: (_v, g) => <span className="wm-acc-who"><b>{principalName(g.principal_id, people)}</b>{kindLabel(people.get(g.principal_id)?.kind) && <span className="wm-acc-kind">{kindLabel(people.get(g.principal_id)?.kind)}</span>}</span> },
    { title: '角色', dataIndex: 'role', render: (_v, g) => roleName(g.role, roles) },
    { title: '范围', dataIndex: 'scope', render: (_v, g) => scopeText(g.scope, g.scope_name) },
    { title: '期限', dataIndex: 'expires_at', render: (_v, g) => termLabel(g.expires_at, Date.now()) },
    { title: '谁给的', dataIndex: 'approved_by', render: (_v, g) => byLabel(g.approved_by ?? g.created_by) },
    { title: '负责人', dataIndex: 'principal_id', key: 'resp', render: (_v, g) => <span className={responsibleOf(g.principal_id, people) === '本人' ? 'wm-acc-muted' : ''}>{responsibleOf(g.principal_id, people)}</span> },
  ];

  const peopleTab = (() => {
    const p = sourceProblem('给出去的权限', src.grants);
    const mine = src.grants && (src.grants.status === 401 || src.grants.status === 403) ? myRolesOf(src.me) : null;
    if (mine) return (
      <div className="wm-acc-mine" data-testid="acc-mine">
        <div className="wm-acc-sec"><h3>你的权限</h3><span className="wm-acc-n">{mine.length}</span><span className="wm-acc-cap">什么角色 · 在什么范围 · 到什么时候</span></div>
        {mine.length === 0
          ? <p className="wm-acc-mine-empty">你现在还没有生效中的角色。需要权限时找你的负责人或管理员，他们起草、核准之后会出现在这里。</p>
          : <ul className="wm-acc-mine-list">{mine.map((r, i) => (
            <li key={`${r.id}-${r.scope}-${i}`} data-testid="acc-mine-role">
              <b>{r.name}</b>
              <span>{scopeText(r.scope, r.scope_name)}</span>
              <span>{termLabel(r.expires_at, Date.now())}</span>
              {scopeNotYetEffective({ scope: r.scope, status: 'active' }) && <span className="wm-acc-note" title={SCOPE_PENDING}>尚未生效</span>}
            </li>
          ))}</ul>}
        <p className="wm-acc-mine-cap">{OTHERS_ONLY_ADMINS}</p>
      </div>
    );
    if (p) return <Alert className="wm-acc-alert" type={p.type} showIcon message={p.text} />;
    return (
      <>
        <p className="wm-acc-intro">一个人或一个 AI 员工能做什么，看四样：是谁、给了什么角色、在什么范围里、到什么时候。AI 员工、工作台和外部节点都要挂在一个负责的人名下；那个人被停用，名下的权限也一起不能用。</p>
        {pending.length > 0 && (
          <>
            <div className="wm-acc-sec"><h3>待你核准</h3><span className="wm-acc-n">{pending.length}</span></div>
            <div className="wm-acc-asks">{pending.map((g) => (
              <PendingCard key={g.id} g={g} who={principalName(g.principal_id, people)} kind={kindLabel(people.get(g.principal_id)?.kind)} role={roleName(g.role, roles)} by={byLabel(g.created_by)} scope={scopeText(g.scope, g.scope_name)} approval={approvalText(g.role, roles)} onDone={reload} />
            ))}</div>
          </>
        )}
        <div className="wm-acc-sec"><h3>给出去的权限</h3><span className="wm-acc-n">{rows.length}</span><span className="wm-acc-cap">谁 · 什么角色 · 什么范围 · 到什么时候 · 谁给的</span></div>
        {rows.some(scopeNotYetEffective) && <div className="wm-acc-pending-cap">标「尚未生效」的是按范围给的权限：按范围的授予要等对象范围接进判定，现在先按没有算。</div>}
        {sourceProblem('人的名字', src.principals) && <Alert className="wm-acc-alert" type="info" showIcon message="读不到人的名字，先用标识显示。" />}
        {rows.length === 0
          ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有给出去的权限。管理员起草一项授予、提交之后，会出现在这里等核准。" />
          : <Table<Grant> className="wm-acc-table" size="middle" rowKey="id" columns={columns} dataSource={rows} pagination={rows.length > 20 ? { pageSize: 20 } : false} />}
      </>
    );
  })();

  const rolesTab = (() => {
    const p = sourceProblem('角色', src.matrix);
    if (p) return <Alert className="wm-acc-alert" type={p.type} showIcon message={p.text} />;
    if (!matrix || matrix.roles.length === 0) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有角色。角色随系统带着，读不到说明服务还没就绪，稍后再看。" />;
    return (
      <>
        <p className="wm-acc-intro">预设是随系统带的一组现成的角色，装上就能用。内置的预设改不了，要调整就复制一份再改。一个人可以同时有几个角色，范围各管各的。</p>
        <div className="wm-acc-roles">{matrix.roles.map((r) => (
          <button key={r.id} type="button" className={r.id === selected?.id ? 'wm-acc-role on' : 'wm-acc-role'} data-testid="acc-role" data-id={r.id} onClick={() => setRoleSel(r.id)}>
            <span className="wm-acc-role-head"><b>{r.name}</b><span className="wm-acc-kind">{r.preset ? '内置' : '自定义'}</span></span>
            <span className="wm-acc-role-use">{usage.get(r.id) ?? 0} 条授予在用</span>
            {approvalText(r.id, roles) && <span className="wm-acc-role-approval" data-testid="acc-role-approval">{approvalText(r.id, roles)}</span>}
          </button>
        ))}</div>
        {selected && (
          <>
            <div className="wm-acc-sec"><h3>{selected.name}</h3><span className="wm-acc-cap">{selected.preset ? '内置预设' : '自定义角色'}</span></div>
            <div className="wm-acc-four">
              <div><b>能看</b>{selected.summary.see.replace(/^能看：/, '') || '—'}</div>
              <div><b>能做</b>{summaryDo(selected.summary.do) || '—'}</div>
              <div><b>能拍板</b>{selected.summary.decide.replace(/^能拍板：/, '') || '—'}</div>
              <div><b>不能</b>{selected.summary.cannot.replace(/^不能：/, '') || '—'}</div>
            </div>
            <table className="wm-acc-matrix" data-testid="acc-matrix">
              <thead><tr><th>系统里的哪一块</th>{matrix.kinds.map((k) => <th key={k.key}>{k.name}</th>)}</tr></thead>
              <tbody>{matrix.blocks.map((b) => (
                <tr key={b.key}><td><b>{b.name}</b></td>{matrix.kinds.map((k) => {
                  const cell = selected.cells?.[b.key]?.[k.key], c = cellLabel(cell);
                  return <td key={k.key}><span className={`wm-acc-cell wm-acc-cell-${c.tone}`} title={cell === 'scoped' ? SCOPE_PENDING : undefined}>{c.text}</span>{cell === 'scoped' && <span className="wm-acc-cell-mark" title={SCOPE_PENDING}>尚未生效</span>}</td>;
                })}</tr>
              ))}</tbody>
            </table>
            <div className="wm-acc-legend">
              {CELL_LEGEND.map((c) => { const l = cellLabel(c); return <span key={c} className={`wm-acc-cell wm-acc-cell-${l.tone}`}>{l.text}</span>; })}
              <span className="wm-acc-cap">能管什么看「管理」一列。「范围内」由给权限时选的范围决定。按范围给的权限现在尚未生效：要等对象范围接进判定，先按不能算。</span>
            </div>
          </>
        )}
      </>
    );
  })();

  return (
    <WmPage>
      <div className="wm-acc-tabs" role="tablist">
        {ACCESS_TABS.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={tab === t.key ? 'wm-acc-tab on' : 'wm-acc-tab'} data-testid={`acc-tab-${t.key}`} onClick={() => pick(t.key)}>{t.name}</button>
        ))}
      </div>
      {loading ? <Skeleton active /> : tab === 'people' ? peopleTab : rolesTab}
    </WmPage>
  );
}
