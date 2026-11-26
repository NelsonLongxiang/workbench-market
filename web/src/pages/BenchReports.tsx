/** 报告页（/use/<卡片 id>/reports，报告第 1 步 PR D，#935）：看这个台上的报告，逐条论断回应。
 *  地址：没参数是清单（按事物分组）；?subject=<事物> 这件事的几个维度并排；?report=<编号> 只看这一份（被更正过的旧报告也能看）。
 *  入口里服务端说能看报告（can.reports）才进得来；能不能回应照 can.respond，回应框只在能回应时出。
 *  页面只消费接口，不另判：读、回应的规矩都在服务端（services/bench-report.ts），这里照它的应答画、照它的说法提示。 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Alert, Button, Empty, Image, Input, Radio, Result, Skeleton, Tag, Typography } from 'antd';
import { ArrowLeftOutlined, FileTextOutlined } from '@ant-design/icons';
import { getBenchEntry, getBenchReport, listBenchReports, respondBenchReport, type BenchEntry, type ReportListItem, type ReportListNames, type ReportNames, type ReportNode, type ReportRead, type ReportResponse } from '../api';
import { entryOutcome } from '../bench-page-view';
import { fmtNumber } from '../bench-blocks/blocks-view';
import { BarBlock } from '../bench-blocks/Chart';
import { REPORT_IMAGE_TEXT, loadReportImage, actorKindText, basisText, gateText, groupBySubject, headsOf, kindLabel, myHead, nameOr, positionText, replacedIds, reportError, reportImageSrc, reportImageState, reportRoute, respondProblem, sourceText, stanceText, timeText, type ReportImageLoad } from '../report-page-view';

type Load<T> = { phase: 'loading' } | { phase: 'ok'; data: T } | { phase: 'error'; text: string };

export default function BenchReports() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const [q] = useSearchParams();
  const route = reportRoute(q);
  const [entry, setEntry] = useState<Load<BenchEntry> | { phase: 'denied' }>({ phase: 'loading' });
  useEffect(() => {
    let live = true;
    setEntry({ phase: 'loading' });
    void getBenchEntry(id).then((r) => {
      if (!live) return;
      const out = entryOutcome(r.status, r.body);
      if (out.kind === 'bench') setEntry(out.entry.can.reports ? { phase: 'ok', data: out.entry } : { phase: 'denied' });
      else setEntry(out.kind === 'card' ? { phase: 'denied' } : { phase: 'error', text: '这会儿打不开' });
    });
    return () => { live = false; };
  }, [id]);
  useEffect(() => { if (entry.phase === 'ok') document.title = `报告 · ${entry.data.bench.title}`; }, [entry]);

  const back = () => (window.history.length > 1 ? nav(-1) : nav(`/use/${encodeURIComponent(id)}`));
  return (
    <div className="wm-use-wrap" data-testid="report-page">
      <div className="wm-use-bar">
        <Button type="text" icon={<ArrowLeftOutlined />} onClick={back} aria-label="返回" />
        <Typography.Title level={5} className="wm-use-title" data-testid="report-page-bench">{entry.phase === 'ok' ? entry.data.bench.title : '报告'}</Typography.Title>
        <div className="wm-bp-bar-extra">
          {route.kind !== 'list' ? <Link to={`/use/${encodeURIComponent(id)}/reports`} data-testid="report-page-all"><Button type="text" size="small">全部报告</Button></Link> : null}
          <Link to={`/use/${encodeURIComponent(id)}`} data-testid="report-page-bench-link"><Button type="text" size="small">回到台</Button></Link>
        </div>
      </div>
      <div className="wm-bp-body">
        {entry.phase === 'loading' ? <Skeleton active /> : null}
        {entry.phase === 'denied' ? <div data-testid="report-page-denied"><Result status="403" title="看不到这个台的报告" subTitle="要看的话，请管理层为你开通这个台的权限。" /></div> : null}
        {entry.phase === 'error' ? <div data-testid="report-page-error"><Result status="warning" title={entry.text} subTitle="稍后再试。" /></div> : null}
        {entry.phase === 'ok' ? (
          route.kind === 'list' ? <ReportList cardId={id} />
            : route.kind === 'subject' ? <SubjectReports cardId={id} subject={route.subject} entry={entry.data} />
              : <OneReport cardId={id} reportId={route.id} entry={entry.data} />
        ) : null}
      </div>
    </div>
  );
}

function SubjectName({ subject, name }: { subject: string; name?: string }) {
  return <span title={name ? subject : undefined}>{name || subject}</span>;
}

/** 清单：按事物分组，每组里各维度一份（被更正过的取更正后的那份） */
function ReportList({ cardId }: { cardId: string }) {
  const [s, setS] = useState<Load<{ list: ReportListItem[]; names: ReportListNames }>>({ phase: 'loading' });
  useEffect(() => {
    let live = true;
    void listBenchReports(cardId).then((r) => {
      if (!live) return;
      const b = r.body as { reports?: ReportListItem[]; names?: ReportListNames } | null;
      setS(r.status === 200 && Array.isArray(b?.reports) ? { phase: 'ok', data: { list: b.reports, names: b.names ?? { dimensions: {}, actors: {} } } } : { phase: 'error', text: reportError(r.status, r.body) });
    });
    return () => { live = false; };
  }, [cardId]);
  if (s.phase === 'loading') return <Skeleton active />;
  if (s.phase === 'error') return <Alert type="error" showIcon message={s.text} data-testid="report-page-msg" />;
  const groups = groupBySubject(s.data.list), names = s.data.names;
  if (!groups.length) return <div data-testid="report-page-empty"><Empty description="这个台上还没有报告" /></div>;
  const base = `/use/${encodeURIComponent(cardId)}/reports`;
  return (
    <div className="wm-rp-groups">
      {groups.map((g) => (
        <section key={g.subject} className="wm-rp-group" data-testid="report-group" data-subject={g.subject}>
          <div className="wm-rp-group-head">
            <h2 className="wm-rp-group-title"><SubjectName subject={g.subject} name={s.data.list.find((r) => r.subject === g.subject && r.subject_name)?.subject_name} /></h2>
            {g.dims.length > 1 ? <Link to={`${base}?subject=${encodeURIComponent(g.subject)}`} data-testid="report-group-side">{g.dims.length} 个维度并排看</Link> : null}
          </div>
          <ul className="wm-rp-dims">
            {g.dims.map((d) => (
              <li key={d.dimension_id} data-testid="report-group-dim">
                <Link to={`${base}?report=${d.head.id}`}>{nameOr(names.dimensions[d.dimension_id])}</Link>
                <span className="wm-rp-meta">{timeText(d.head.created_at)} · 产出方 {names.actors[d.head.producer] || '未署名'}</span>
                {d.head.producer_kind === 'ai' ? <Tag color="purple">AI</Tag> : null}
                {d.head.supersedes !== null ? <Tag>更正版</Tag> : null}
                {d.others > 0 ? <span className="wm-rp-meta">另有 {d.others} 份</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** 同一事物的几个维度并排：每个维度一列（宽屏并排，窄屏上下排） */
function SubjectReports({ cardId, subject, entry }: { cardId: string; subject: string; entry: BenchEntry }) {
  const [s, setS] = useState<Load<{ ids: number[]; name?: string }>>({ phase: 'loading' });
  useEffect(() => {
    let live = true;
    void listBenchReports(cardId, subject).then((r) => {
      if (!live) return;
      const list = (r.body as { reports?: ReportListItem[] } | null)?.reports;
      setS(r.status === 200 && Array.isArray(list) ? { phase: 'ok', data: { ids: headsOf(list).map((d) => d.head.id), name: list.find((r) => r.subject_name)?.subject_name } } : { phase: 'error', text: reportError(r.status, r.body) });
    });
    return () => { live = false; };
  }, [cardId, subject]);
  if (s.phase === 'loading') return <Skeleton active />;
  if (s.phase === 'error') return <Alert type="error" showIcon message={s.text} data-testid="report-page-msg" />;
  if (!s.data.ids.length) return <div data-testid="report-page-empty"><Empty description="这件事还没有报告" /></div>;
  return (
    <>
      <h1 className="wm-bp-title wm-rp-subject" data-testid="report-subject"><SubjectName subject={subject} name={s.data.name} /></h1>
      <div className="wm-rp-cols" data-testid="report-cols">
        {s.data.ids.map((rid) => <OneReport key={rid} cardId={cardId} reportId={rid} entry={entry} column />)}
      </div>
    </>
  );
}

/** 一份报告：成品、来源、更正链、论断和回应 */
function OneReport({ cardId, reportId, entry, column }: { cardId: string; reportId: number; entry: BenchEntry; column?: boolean }) {
  const [s, setS] = useState<Load<ReportRead>>({ phase: 'loading' });
  const load = useCallback(async () => {
    const r = await getBenchReport(cardId, reportId);
    const body = r.body as ReportRead | null;
    setS(r.status === 200 && body?.report ? { phase: 'ok', data: body } : { phase: 'error', text: reportError(r.status, r.body) });
  }, [cardId, reportId]);
  useEffect(() => { setS({ phase: 'loading' }); void load(); }, [load]);
  if (s.phase === 'loading') return <div className="wm-rp-col"><Skeleton active /></div>;
  if (s.phase === 'error') return <div className="wm-rp-col"><Alert type="error" showIcon message={s.text} data-testid="report-page-msg" /></div>;
  const d = s.data, rep = d.report;
  const base = `/use/${encodeURIComponent(cardId)}/reports`;
  const canRespond = entry.can.respond;
  const names: ReportNames = d.names ?? { dimension: null, actors: {}, positions: {}, sources: [] };
  return (
    <article className={column ? 'wm-rp-col wm-rp-doc' : 'wm-rp-doc'} data-testid="report-doc" data-report={rep.id} data-dimension={rep.dimension_id}>
      <header className="wm-rp-doc-head">
        <div className="wm-rp-doc-dim" data-testid="report-dimension">{nameOr(names.dimension)}<span className="wm-rp-meta"> · 模板第 {rep.template_version} 版 · <SubjectName subject={rep.subject} name={rep.subject_name} /></span></div>
        <div className="wm-rp-meta" data-testid="report-producer">
          {timeText(rep.created_at)} 生成 · 产出方 {(names.producer === undefined ? names.actors[rep.producer] : names.producer) || '未署名'} <Tag color={rep.producer_kind === 'ai' ? 'purple' : undefined}>{actorKindText(rep.producer_kind)}</Tag>
        </div>
        {rep.superseded_by !== null ? <Alert type="warning" showIcon data-testid="report-superseded" message={<>这份报告已被更正，<Link to={`${base}?report=${rep.superseded_by}`}>看更正后的那份</Link></>} /> : null}
        {rep.supersedes !== null ? <div className="wm-rp-meta" data-testid="report-supersedes">更正了 <Link to={`${base}?report=${rep.supersedes}`}>报告 #{rep.supersedes}</Link></div> : null}
        <div className="wm-rp-status">
          <Tag color={d.open_disputes > 0 ? 'error' : 'success'} data-testid="report-open-disputes">{d.open_disputes > 0 ? `未处理的反驳 ${d.open_disputes} 处` : '没有未处理的反驳'}</Tag>
          {gateText(d.gate) ? <span className="wm-rp-meta" data-testid="report-gate">{gateText(d.gate)}</span> : null}
        </div>
      </header>
      <div className="wm-rp-body"><Nodes nodes={rep.body.body} level={1} img={{ bench: entry.bench.slug, report: rep.id }} /></div>
      <footer className="wm-rp-meta wm-rp-sources" data-testid="report-sources">
        来源：{rep.sources.map((x, i) => sourceText(names.sources[i], x)).join('；')}
      </footer>
      <section className="wm-rp-claims" aria-label="论断">
        <h2 className="wm-rp-h">论断</h2>
        {d.claims.map((c, ci) => (
          <div key={c.claim_key} className={c.open_dispute ? 'wm-rp-claim wm-rp-open' : 'wm-rp-claim'} data-testid="report-claim" data-claim={c.claim_key}>
            <div className="wm-rp-claim-head">
              <Tag>{kindLabel(d.template.claims, c.kind)}</Tag>
              <span className="wm-rp-claim-key">第 {ci + 1} 条</span>
              {c.open_dispute ? <Tag color="error" data-testid="report-claim-open">有未处理的反驳</Tag> : null}
            </div>
            <p className="wm-rp-claim-text">{c.text}</p>
            {c.basis.length ? <div className="wm-rp-meta">依据：{c.basis.map((b) => basisText(names.sources, b)).join('；')}</div> : null}
            <Responses list={c.responses} names={names} />
            {canRespond ? <RespondBox cardId={cardId} reportId={rep.id} claimKey={c.claim_key} stances={d.template.stances} mine={myHead(c.responses, c.claim_key)} onDone={load} /> : null}
          </div>
        ))}
        <div className="wm-rp-claim" data-testid="report-whole" data-claim="">
          <div className="wm-rp-claim-head"><Tag>整份报告</Tag></div>
          <Responses list={d.responses} names={names} />
          {canRespond ? <RespondBox cardId={cardId} reportId={rep.id} claimKey="" stances={d.template.stances} mine={myHead(d.responses, '')} onDone={load} /> : null}
        </div>
      </section>
    </article>
  );
}

/** 回应列表：改过主意的旧回应划掉；AI 的回应另外标出 */
function Responses({ list, names }: { list: ReportResponse[]; names: ReportNames }) {
  if (!list.length) return null;
  const replaced = replacedIds(list);
  return (
    <ul className="wm-rp-responses">
      {list.map((r) => (
        <li key={r.id} className={replaced.has(r.id) ? 'wm-rp-resp wm-rp-replaced' : 'wm-rp-resp'} data-testid="report-response" data-stance={r.stance} data-kind={r.responder_kind} data-replaced={replaced.has(r.id) ? 'true' : 'false'}>
          <Tag color={r.stance === 'dispute' ? 'error' : r.stance === 'agree' ? 'success' : 'processing'}>{stanceText(r.stance)}</Tag>
          {r.responder_kind === 'ai' ? <Tag color="purple" data-testid="report-response-ai">AI</Tag> : null}
          <span className="wm-rp-reason">{r.reason}</span>
          <span className="wm-rp-meta"> — {nameOr(names.actors[r.responder])}{positionText(names.positions[r.position]) ? `（${positionText(names.positions[r.position])}）` : ''} · {timeText(r.created_at)}{r.mine ? ' · 我' : ''}</span>
        </li>
      ))}
    </ul>
  );
}

/** 回应框：立场只能选模板允许的；理由必填；自己已经回应过就接在自己的链头后面（改主意） */
function RespondBox({ cardId, reportId, claimKey, stances, mine, onDone }: { cardId: string; reportId: number; claimKey: string; stances: string[]; mine: ReportResponse | null; onDone: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [stance, setStance] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const problem = respondProblem(stances, stance, reason);
  if (!open) return <Button size="small" className="wm-rp-respond-btn" onClick={() => { setOpen(true); setMsg(''); }} data-testid="report-respond-open">{mine ? `改主意（现在是${stanceText(mine.stance)}）` : '回应'}</Button>;
  const send = async () => {
    setBusy(true);
    const r = await respondBenchReport(cardId, reportId, { ...(claimKey ? { claim_key: claimKey } : {}), stance, reason, ...(mine ? { supersedes: mine.id } : {}) });
    setBusy(false);
    if (r.status === 201) { setOpen(false); setStance(''); setReason(''); await onDone(); return; }
    setMsg(reportError(r.status, r.body));
  };
  return (
    <div className="wm-rp-respond" data-testid="report-respond">
      {mine ? <div className="wm-rp-meta">接在你上一条（{stanceText(mine.stance)}）后面，旧的会划掉、仍然留着</div> : null}
      <Radio.Group value={stance} onChange={(e) => setStance(e.target.value)} data-testid="report-respond-stance">
        {stances.map((x) => <Radio key={x} value={x}>{stanceText(x)}</Radio>)}
      </Radio.Group>
      <Input.TextArea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={4000} showCount autoSize={{ minRows: 2, maxRows: 6 }} placeholder="理由（必填）" aria-label="理由" data-testid="report-respond-reason" />
      {msg ? <Alert type="error" showIcon message={msg} data-testid="report-respond-msg" /> : null}
      <div className="wm-rp-respond-actions">
        <Button size="small" onClick={() => setOpen(false)} disabled={busy}>取消</Button>
        <Button size="small" type="primary" loading={busy} disabled={!!problem} title={problem || undefined} onClick={() => void send()} data-testid="report-respond-send">提交</Button>
      </div>
    </div>
  );
}

/** 冻结的正文：封面、小节、文字、栅格、统计、表格、柱状图、图片（图片经代取，来源是这份报告） */
type ImgFrom = { bench: string; report: number };
function Nodes({ nodes, level, img }: { nodes: ReportNode[]; level: number; img: ImgFrom }) {
  return <>{nodes.map((n) => {
    if (n.type === 'cover') return <header key={n.id} className="wm-rp-cover" data-node={n.id}><h1>{n.title}</h1>{n.content ? <p>{n.content}</p> : null}</header>;
    if (n.type === 'section') { const H = level <= 1 ? 'h2' : 'h3'; return <section key={n.id} data-node={n.id}><H className="wm-rp-h">{n.title}</H><Nodes nodes={n.children ?? []} level={level + 1} img={img} /></section>; }
    if (n.type === 'image') return <ReportImage key={n.id} node={n} img={img} />;
    if (n.type === 'text') return <p key={n.id} data-node={n.id} className="wm-rp-text">{n.content}</p>;
    if (n.type === 'grid') return <div key={n.id} data-node={n.id} className="wm-rp-grid"><Nodes nodes={n.children ?? []} level={level} img={img} /></div>;
    if (n.type === 'data-view' && n.data) {
      const p = n.props ?? {};
      if (n.component === 'stat') {
        const name = String(p.value ?? ''), col = n.data.columns.find((c) => c.name === name);
        return <div key={n.id} className="wm-rp-stat" data-node={n.id}><span>{nameOr(col?.label)}</span><strong>{fmtNumber(n.data.rows[0]?.[name])}{p.unit ? <small> {String(p.unit)}</small> : null}</strong></div>;
      }
      if (n.component === 'bar') return <div key={n.id} data-node={n.id}><BarBlock frame="none" data={n.data as never} x={String(p.x ?? '')} y={(p.y as string[] | undefined) ?? []} /></div>;
      const names = Array.isArray(p.columns) ? (p.columns as string[]) : n.data.columns.map((c) => c.name);
      const cols = names.map((nm) => n.data!.columns.find((c) => c.name === nm)).filter((c): c is NonNullable<typeof c> => !!c);
      const num = (t: string) => t === 'integer' || t === 'decimal';
      return (
        <table key={n.id} className="wm-rp-table" data-node={n.id}>
          <thead><tr>{cols.map((c) => <th key={c.name}>{nameOr(c.label)}</th>)}</tr></thead>
          <tbody>{n.data.rows.map((r, i) => <tr key={i}>{cols.map((c) => <td key={c.name} className={num(c.type) ? 'wm-rp-num' : undefined}>{num(c.type) ? fmtNumber(r[c.name]) : String(r[c.name] ?? '—')}</td>)}</tr>)}</tbody>
        </table>
      );
    }
    return null;
  })}</>;
}

/**
 * 报告里的一张图：取一次代取地址，按应答码画——200 显示取到的这份字节（就是服务端按冻结哈希核过的那份），409「图片已变」、其余「图片取不到」，
 * 都不显示链接原文。显示用 blob 地址（主界面现在没有 CSP；以后加 CSP 时 img-src 要放 blob:）。样式只用 token 类名
 */
function ReportImage({ node, img }: { node: ReportNode; img: ImgFrom }) {
  const src = reportImageSrc(img.bench, img.report, node.src);
  const [s, setS] = useState<{ phase: 'loading' } | ReportImageLoad>({ phase: 'loading' });
  useEffect(() => {
    let live = true, url = '';
    setS({ phase: 'loading' });
    // loadReportImage 从不拒绝：请求、读 body、建 blob 地址任一失败都给「图片取不到」（报告图片 PR 评审 B1）
    void loadReportImage(src, (u) => fetch(u, { credentials: 'same-origin' }), (b) => URL.createObjectURL(b)).then((out) => {
      if (!live) { if (out.phase === 'shown') URL.revokeObjectURL(out.url); return; }
      if (out.phase === 'shown') url = out.url;
      setS(out);
    });
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [src]);
  const alt = node.alt ?? '';
  return (
    <figure className="wm-rp-figure" data-node={node.id} data-testid="report-image">
      {s.phase === 'shown' ? <Image src={s.url} alt={alt} className="wm-rp-img" rootClassName="wm-rp-img-root" preview={{ mask: '查看原图' }} data-testid="report-image-shown" />
        : s.phase === 'loading' ? <span className="wm-img-missing wm-rp-img-missing" role="img" aria-label="图片加载中" aria-busy="true" />
        : <span className="wm-img-missing wm-rp-img-missing" role="img" aria-label={REPORT_IMAGE_TEXT[s.phase]} data-testid={`report-image-${s.phase}`}>{REPORT_IMAGE_TEXT[s.phase]}</span>}
      {alt ? <figcaption className="wm-rp-figcaption">{alt}</figcaption> : null}
    </figure>
  );
}

/** 台页面顶栏的「报告」：服务端说能看报告（can.reports）才出 */
export function ReportsLink({ cardId, entry }: { cardId: string; entry: BenchEntry }) {
  if (!entry.can.reports) return null;
  return <Link to={`/use/${encodeURIComponent(cardId)}/reports`} data-testid="bench-page-reports"><Button type="text" size="small" icon={<FileTextOutlined />}>报告</Button></Link>;
}
