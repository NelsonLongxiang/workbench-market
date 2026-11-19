/** Page-owned table actions; the shared renderer still owns columns, pagination and cell formatting. */
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Collapse, Descriptions, Drawer, Spin, Typography } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import { TableBlock, type TableBlockProps } from './Table';
import { exportBenchTable, readBenchTableRow, type BenchTableDetail } from '../api';
import { tableReadError, type TableContext } from '../bench-table-view';

export function NativeTable({ bench, context, disabled, ...props }: TableBlockProps & { bench: string; context: TableContext; disabled?: boolean }) {
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const [open, setOpen] = useState(false), [detail, setDetail] = useState<BenchTableDetail | null>(null), [error, setError] = useState('');
  const [reading, setReading] = useState(false);
  const seq = useRef(0), exportSeq = useRef(0), exporting = useRef(false);
  const identity = JSON.stringify([bench, context, disabled === true]);
  const identityRef = useRef(identity); identityRef.current = identity;
  useEffect(() => { seq.current++; exportSeq.current++; setOpen(false); setDetail(null); setError(''); setNotice(''); setReading(false); return () => { seq.current++; exportSeq.current++; }; }, [identity]);
  const download = async () => {
    if (disabled || exporting.current) return;
    exporting.current = true; setBusy(true); setNotice(''); const mine = exportSeq.current;
    try {
      const r = await exportBenchTable(bench, context);
      if (mine !== exportSeq.current || identityRef.current !== identity) return;
      if (!r.blob) { setNotice(tableReadError(r.status, r.error)); return; }
      const url = URL.createObjectURL(r.blob), a = document.createElement('a');
      a.href = url; a.download = `table-${context.view}-v${context.version}-${r.count}.csv`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice(`已生成 ${r.count} 行完整匹配结果（另含表头，不受当前分页限制）。`);
    } finally { exporting.current = false; setBusy(false); }
  };
  const show = async (row: Record<string, unknown>) => {
    if (disabled) return;
    const index = props.data?.rows.indexOf(row) ?? -1; if (index < 0) return;
    const mine = ++seq.current; setOpen(true); setReading(true); setError(''); setDetail(null);
    const r = await readBenchTableRow(bench, context, index, row);
    if (mine !== seq.current || identityRef.current !== identity) return;
    setReading(false);
    if (r.status === 200 && r.body?.row && r.body.revision === context.revision && r.body.version === context.version) setDetail(r.body);
    else setError(tableReadError(r.status, r.body));
  };
  const fields = (row: Record<string, unknown>, columns: {name:string;label?:string}[]) => columns.map((c, i) => ({ key: c.name, label: c.label || `第 ${i + 1} 列`, children: <span style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{row[c.name] === null || row[c.name] === undefined ? '未提供' : String(row[c.name])}</span> }));
  return <>
    <TableBlock {...props} extra={<Button size="small" icon={<DownloadOutlined />} disabled={disabled || !!props.error || !props.data} loading={busy} onClick={() => void download()}>导出全部匹配结果</Button>} rowActions={row => <Button type="link" size="small" disabled={disabled} onClick={() => void show(row)}>原行／来源详情</Button>} />
    {notice && <div role="status" style={{gridColumn:'1 / -1'}}>{notice}</div>}
    <Drawer title="原行／来源详情" open={open} width={640} onClose={() => {seq.current++;setOpen(false);}}>
      {reading ? <Spin /> : error ? <Alert type="warning" showIcon message={error} /> : detail ? <>
        <Typography.Paragraph>视图第 {detail.version} 版 · {detail.dataset_title} · 当前筛选：{Object.keys(detail.params).length ? Object.entries(detail.params).map(([k,v]) => `${detail.filter_labels[k] ?? "筛选项"}=${v}`).join('；') : '全部'}</Typography.Paragraph>
        <Alert type={detail.source_status === 'original-row' ? 'info' : 'warning'} showIcon message={detail.source_message} />
        <Typography.Title level={5}>当前结果行（同一上下文）</Typography.Title>
        <Descriptions column={1} bordered size="small" items={fields(detail.row, detail.columns)} />
        {detail.source_row && <><Typography.Title level={5}>同上下文原行及来源定位</Typography.Title><Descriptions column={1} bordered size="small" items={fields(detail.source_row, detail.source_columns)} /></>}
        {detail.source_status === 'group-rows' && <><Typography.Title level={5}>本组来源原行</Typography.Title>{detail.source_truncated && <Alert type="warning" message="来源原行超过 200 行，这里只是前 200 行，不是全部原证。" />}<Collapse items={detail.source_rows.map((r,i) => ({key:String(i),label:`来源原行 ${i+1}`,children:<Descriptions column={1} bordered size="small" items={fields(r,detail.source_columns)} />}))} /></>}
        <Typography.Paragraph type="secondary">本次未取得原证文件：这里只展示当前原行及已保存的定位／公式，不是原证已核实。缺少原证请向原来源提供方索取；无权时不会代开权限，也不从文字定位猜测文件地址。</Typography.Paragraph>
      </> : null}
    </Drawer>
  </>;
}
