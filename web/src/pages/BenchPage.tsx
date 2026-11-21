/** 视图台页面：从市场打开一张视图台卡片（入口 200）后画这一页。
 *  顶栏：返回、台名、右边「详情」；下面一排视图页签（一份视图就不出），地址带 ?v=<键>，筛选值带 p.<字段>，链接发给别人看到的是同一份。
 *  正文：带外框的 BenchView（和驾驶舱里同一套组件，驾驶舱里是不带外框的紧凑版）。表单在这里能交：交上去之后整页重新取数；没交上去在表单里说原因。
 *  台标识、视图键都不写在页面的字上（键只在地址里）。
 *  改台名（#927）：服务端说能改（入口的 can.rename，只有管理层）才在台名旁边出「改名」；改成了重新问入口，顶部换成新名，地址不变。 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, Button, Empty, Input, Modal, Result, Skeleton, Typography } from 'antd';
import { ArrowLeftOutlined, EditOutlined, InfoCircleOutlined, ReloadOutlined } from '@ant-design/icons';
import { BenchView, type ViewResult } from '../bench-blocks/BenchView';
import { getBenchView, renameBenchTitle, submitBenchForm, type BenchEntry } from '../api';
import { BENCH_VIEWS_OFF, benchViewError, isBenchViewsOff } from '../cockpit-frame-view';
import { formError, pageTitle, paramsFromQuery, renameChoices, renameError, titleProblem, toQuery, viewFromQuery } from '../bench-page-view';

type State = { phase: 'loading' } | { phase: 'ok'; result: ViewResult; requestKey: string } | { phase: 'off' } | { phase: 'error'; text: string };

export default function BenchPage({ cardId, entry, refreshEntry }: { cardId: string; entry: BenchEntry; refreshEntry: () => void }) {
  const nav = useNavigate();
  const [q, setQ] = useSearchParams();
  const view = viewFromQuery(entry, q);
  const params = paramsFromQuery(q);
  const key = JSON.stringify([cardId, view, params]);
  const [s, setS] = useState<State>({ phase: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  const seq = useRef(0);

  useEffect(() => { document.title = pageTitle(entry); }, [entry]);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    const r = await getBenchView({ bench: cardId, view }, params);
    if (mine !== seq.current) return; // 连着换了几次视图或筛选：只认最后一次
    setRefreshing(false);
    if (r.status === 200 && r.body) setS({ phase: 'ok', result: r.body as ViewResult, requestKey: key });
    else if (isBenchViewsOff(r.status, r.error)) setS({ phase: 'off' });
    else setS({ phase: 'error', text: benchViewError(r.status, r.error) });
  // key 是视图和筛选值的指纹
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardId, key]);
  // 换了视图：先回骨架，免得新数据回来前正文还是上一份视图的、看错；只改筛选（同一份视图）时留着现在的数据，刷新按钮转着
  const shownView = useRef(view);
  useEffect(() => {
    const switched = shownView.current !== view;
    shownView.current = view;
    setS((cur) => (cur.phase === 'ok' && !switched ? cur : { phase: 'loading' }));
    setRefreshing(true); void load();
  // view 已经在 load 的 key 里，换视图一定会走到这里
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const go = (v: string, p: Record<string, string>) => setQ(new URLSearchParams(toQuery(entry, v, p)), { replace: false });
  const submit = async (block: number, values: Record<string, unknown>) => {
    const version = s.phase === 'ok' ? s.result.version : entry.version;
    const r = await submitBenchForm(cardId, { view, block, version, values });
    if (r.status !== 200) throw formError(r.status, r.body);
    void load(); // 交上去了：整页按现在的视图和筛选重新取数
  };

  const back = () => (window.history.length > 1 ? nav(-1) : nav('/'));
  const { canRename, syncTo } = renameChoices(entry);
  const [renaming, setRenaming] = useState(false);
  return (
    <div className="wm-use-wrap" data-testid="bench-page">
      <div className="wm-use-bar">
        <Button type="text" icon={<ArrowLeftOutlined />} onClick={back} aria-label="返回" />
        <Typography.Title level={5} className="wm-use-title" data-testid="bench-page-name">{entry.bench.title}</Typography.Title>
        {canRename ? <Button type="text" size="small" icon={<EditOutlined />} onClick={() => setRenaming(true)} aria-label="改台名" data-testid="bench-page-rename">改名</Button> : null}
        <div className="wm-bp-bar-extra">
          <Link to={`/market/wb/${encodeURIComponent(cardId)}`} data-testid="bench-page-detail"><Button type="text" size="small" icon={<InfoCircleOutlined />}>详情</Button></Link>
        </div>
      </div>
      <div className="wm-bp-head">
        <h1 className="wm-bp-title" data-testid="bench-page-title">{entry.title}</h1>
        {entry.views.length > 1 ? (
          <div className="wm-bp-tabs" role="tablist" aria-label="视图">
            {entry.views.map((v) => (
              <button key={v.key} type="button" role="tab" aria-selected={v.key === view} className={v.key === view ? 'wm-ck-tab on' : 'wm-ck-tab'} onClick={() => { if (v.key !== view) go(v.key, {}); }} data-testid="bench-page-tab">
                {v.title}
              </button>
            ))}
          </div>
        ) : null}
        <Button size="small" type="text" icon={<ReloadOutlined />} loading={refreshing && s.phase === 'ok'} onClick={() => { setRefreshing(true); refreshEntry(); void load(); }} className="wm-bp-refresh" data-testid="bench-page-refresh">刷新</Button>
      </div>
      <main className="wm-bp-body">
        {s.phase === 'loading' ? <div className="wm-dash-card" data-testid="bench-page-loading"><Skeleton active paragraph={{ rows: 6 }} /></div>
          : s.phase === 'off' ? <div className="wm-bp-state" data-testid="bench-page-off"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={BENCH_VIEWS_OFF} /></div>
            : s.phase === 'error' ? <div className="wm-bp-state" data-testid="bench-page-error"><Result status="warning" title={s.text} extra={<Button onClick={() => { setS({ phase: 'loading' }); void load(); }}>再试一次</Button>} /></div>
              : <BenchView result={s.result} tableBench={cardId} tableDisabled={refreshing || s.requestKey !== key} frame="card" onParams={(p) => go(view, p)} onSubmit={submit} />}
      </main>
      {canRename && renaming ? <RenameDialog cardId={cardId} current={entry.bench.title} syncTo={syncTo} refreshEntry={refreshEntry} onClose={() => setRenaming(false)} /> : null}
    </div>
  );
}

/**
 * 改台名的对话框（打开时才挂上，关掉就卸下，下次打开从现在的名字重新开始）：填新名字保存，或者「跟卡片同名」。
 * 提交时带上看到的名字（base_title）：被别人先改过就 409，照服务端说，并重新问入口，顶部和输入框都换成现在的名字
 */
function RenameDialog({ cardId, current, syncTo, refreshEntry, onClose }: { cardId: string; current: string; syncTo: string | null; refreshEntry: () => void; onClose: () => void }) {
  const [text, setText] = useState(current);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // 409 之后重新问入口回来，名字变了：base_title 用的就是 current，跟着变。
  // 输入框只在用户没动过（还是原来那个名字）时跟着换成现在的名字；用户填过的新名字留着，不替他丢掉（#928 浏览器用例抓到的）
  const shown = useRef(current);
  useEffect(() => {
    if (shown.current === current) return;
    const before = shown.current;
    shown.current = current;
    setText((t) => (t.trim() === before ? current : t));
  }, [current]);
  const send = async (req: { title: string } | { from_card: true }) => {
    setBusy(true); setErr(null);
    const r = await renameBenchTitle(cardId, { ...req, base_title: current });
    setBusy(false);
    if (r.status === 200) { refreshEntry(); onClose(); return; }
    setErr(renameError(r.status, r.body));
    if (r.status === 409) refreshEntry();
  };
  const problem = titleProblem(text);
  const unchanged = text.trim() === current;
  return (
    <Modal open title="改台名" onCancel={onClose}
      footer={[
        <Button key="cancel" onClick={onClose}>取消</Button>,
        ...(syncTo ? [<Button key="sync" disabled={busy} onClick={() => void send({ from_card: true })} data-testid="bench-rename-sync">跟卡片同名：{syncTo}</Button>] : []),
        <Button key="save" type="primary" loading={busy} disabled={!!problem || unchanged} onClick={() => void send({ title: text.trim() })} data-testid="bench-rename-save">保存</Button>,
      ]}>
      <div data-testid="bench-rename-dialog">
        <Typography.Paragraph type="secondary">只改这个台显示的名字；台里的数据、视图、谁能看都不变，卡片的名字也不跟着改。</Typography.Paragraph>
        <Input value={text} maxLength={80} onChange={(e) => setText(e.target.value)} onPressEnter={() => { if (!problem && !unchanged && !busy) void send({ title: text.trim() }); }} aria-label="新的台名" data-testid="bench-rename-input" />
        {problem && text !== '' ? <Typography.Text type="danger" data-testid="bench-rename-problem">{problem}</Typography.Text> : null}
        {err ? <Alert type="warning" showIcon message={err} data-testid="bench-rename-error" /> : null}
      </div>
    </Modal>
  );
}
