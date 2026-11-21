/**
 * 记录卡（records，#858）：查询的每一行一张卡片。标题、徽标、日期、主要字段一直可见；次要字段和长文字收在「展开」里。
 * 所有字段一律当纯文本显示（React 默认转义，这里不用任何 innerHTML，不解析 HTML、markdown）。
 * 来源链接只显示 label，不露网址；悬停和读屏给出目标主机名；只认 http(s)，不认的标「来源地址无效」、不渲染成链接。
 * 分页在页面上做（和表格同一个口径），卡片上方写「共 N 条」；查询被截断时不写这一行，只留框架那句截断提示（两处说同一件事）。
 */
import { useId, useState } from 'react';
import { Pagination, Tag } from 'antd';
import { BlockFrame, type BlockFrameProps } from './Frame';
import { isLongText, recordCards, type RecordCard, type RecordField, type RecordsSpec } from './blocks-view';

const TONE: Record<string, string> = { success: 'success', warning: 'warning', danger: 'error', default: 'default' };

export interface RecordsBlockProps extends BlockFrameProps {
  spec: RecordsSpec;
  /** 服务端核过的链接（取数应答的 link_targets） */
  linkTargets?: unknown;
  pageSize?: number;
  dense?: boolean;
}

function FieldRow({ f, open }: { f: RecordField; open: boolean }) {
  const clamp = !open && isLongText(f.text);
  return (
    <div className="wm-rec-field">
      <dt>{f.label}</dt>
      <dd className={`${f.empty ? 'wm-rec-empty' : ''}${clamp ? ' wm-rec-clamp' : ''}`}>{f.text}</dd>
    </div>
  );
}

function Card({ c }: { c: RecordCard }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const expandable = c.details.length > 0 || c.fields.some((f) => isLongText(f.text));
  return (
    <article className="wm-rec-card" data-testid="rec-card">
      <header className="wm-rec-head">
        <h4 className="wm-rec-title">{c.title}</h4>
        {c.date !== null && <span className={`wm-rec-date${c.date === '未填' ? ' wm-rec-empty' : ''}`}>{c.date}</span>}
      </header>
      {c.badges.length > 0 && (
        <div className="wm-rec-badges">
          {c.badges.map((b, i) => (
            <Tag key={i} color={TONE[b.tone]} title={b.undefinedValue ? '未定义的取值' : undefined}>{b.text}{b.undefinedValue ? '（未定义的取值）' : ''}</Tag>
          ))}
        </div>
      )}
      {c.fields.length > 0 && <dl className="wm-rec-fields">{c.fields.map((f) => <FieldRow key={f.name} f={f} open={open} />)}</dl>}
      {open && c.details.length > 0 && <dl className="wm-rec-fields wm-rec-details" id={id}>{c.details.map((f) => <FieldRow key={f.name} f={f} open={open} />)}</dl>}
      {(expandable || c.links.length > 0) && (
        <footer className="wm-rec-foot">
          {expandable && (
            <button type="button" className="wm-rec-toggle" aria-expanded={open} aria-controls={c.details.length ? id : undefined} onClick={() => setOpen((x) => !x)} data-testid="rec-toggle">
              {open ? '收起' : '展开'}
            </button>
          )}
          {c.links.map((l, i) => ('invalid' in l
            ? <span key={i} className="wm-rec-link-invalid" data-testid="rec-link-invalid">{l.label}：来源地址无效</span>
            : <a key={i} className="wm-rec-link" href={l.href} target="_blank" rel="noopener noreferrer" title={`打开 ${l.host}`} aria-label={`${l.label}（打开 ${l.host}）`} data-testid="rec-link">{l.label}</a>))}
        </footer>
      )}
    </article>
  );
}

export function RecordsBlock({ spec, linkTargets, pageSize = 20, dense, span = 12, empty, ...frame }: RecordsBlockProps) {
  const cards = recordCards(frame.data, spec, linkTargets);
  const [page, setPage] = useState(1);
  const pages = Math.max(1, Math.ceil(cards.length / pageSize));
  const cur = Math.min(page, pages);
  const shown = cards.slice((cur - 1) * pageSize, cur * pageSize);
  const truncated = frame.data?.truncated === true;
  return (
    <BlockFrame {...frame} span={span} kind="records" empty={empty ?? '暂无记录'}>
      <div className={`wm-rec${dense ? ' wm-rec-dense' : ''}`}>
        {/* 查询被截断时不写「共 N 条」（那不是总数）：框架已经说了「数据不止这些，只显示了前 N 行」，这里不再重复 */}
        {!truncated && <div className="wm-rec-count" data-testid="rec-count">共 {cards.length} 条</div>}
        <div className="wm-rec-grid">{shown.map((c) => <Card key={`${cur}-${c.key}`} c={c} />)}</div>
        {cards.length > pageSize && <Pagination size="small" current={cur} pageSize={pageSize} total={cards.length} showSizeChanger={false} onChange={setPage} />}
      </div>
    </BlockFrame>
  );
}
