/**
 * 数据视图组件的演示页：只在开发时有（vite dev），正式构建里没有这个路由，也不进侧栏。
 * 数据是这个文件里造的，不读任何接口：用来在浏览器里逐个看八种组件和它们的四种状态。
 */
import { useMemo, useState } from 'react';
import { Button, Typography } from 'antd';
import { DashGrid } from '../../components/Dash';
import WmPage from '../../components/WmPage';
import {
  BarBlock, BenchView, FormBlock, LineBlock, PieBlock, ProgressBlock, StatBlock, TableBlock,
  type BlockData, type ViewResult,
} from '../../bench-blocks';

const REGIONS = ['东区', '南区', '西区', '北区'];
const STATUS = ['done', 'doing', 'late'];
const PEOPLE = ['周一', '吴二', '郑三'];
// 造 6 个月、4 个区、每格若干单：数是按下标算出来的，每次打开都一样
const ORDERS = Array.from({ length: 6 }, (_, m) => REGIONS.flatMap((region, r) => Array.from({ length: 3 + ((m + r) % 3) }, (_, k) => ({
  id: m * 100 + r * 10 + k, month: `2026-${String(m + 1).padStart(2, '0')}`, day: `2026-${String(m + 1).padStart(2, '0')}-${String(3 + k * 7).padStart(2, '0')}`,
  region, amount: 1200 + ((m * 37 + r * 53 + k * 71) % 9) * 310.5, qty: 4 + ((m + r * 2 + k) % 7),
  status: STATUS[(m + r + k) % 3], owner: PEOPLE[(r + k) % 3], updated_at: `2026-${String(m + 1).padStart(2, '0')}-${String(3 + k * 7).padStart(2, '0')}T08:30:00Z`,
})))).flat();

const col = (name: string, type: BlockData['columns'][number]['type'], label: string, display?: BlockData['columns'][number]['display']) => ({ name, type, label, display });
const sum = (rows: typeof ORDERS, f: (r: (typeof ORDERS)[number]) => number) => rows.reduce((a, r) => a + f(r), 0);
const groupBy = <K extends string>(rows: typeof ORDERS, key: (r: (typeof ORDERS)[number]) => K) => { const m = new Map<K, typeof ORDERS>(); for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r]); return m; };

function render(params: Record<string, string>): ViewResult {
  const rows = ORDERS.filter((r) => (!params.month || r.month === params.month) && (!params.region || r.region === params.region) && (!params.q || r.owner.includes(params.q)));
  const one = (name: string, label: string, v: number): BlockData => ({ columns: [col(name, 'decimal', label)], rows: rows.length ? [{ [name]: v }] : [] });
  const byMonthRegion: BlockData = { columns: [col('month', 'text', '月份'), col('region', 'text', '区'), col('amount', 'decimal', '金额')], rows: [...groupBy(rows, (r) => `${r.month}|${r.region}`).entries()].map(([k, g]) => ({ month: k.split('|')[0], region: k.split('|')[1], amount: sum(g, (r) => r.amount) })) };
  const byRegion: BlockData = { columns: [col('region', 'text', '区'), col('n', 'integer', '单数')], rows: [...groupBy(rows, (r) => r.region).entries()].map(([region, g]) => ({ region, n: g.length })) };
  return {
    title: '示例台', version: 1, view: { key: 'overview', title: '总览' }, params,
    blocks: [
      { type: 'filter-bar', fields: [{ name: 'month', kind: 'month', label: '月份' }, { name: 'region', kind: 'select', label: '区', options: REGIONS }, { name: 'q', kind: 'search', label: '负责人' }] },
      { type: 'stat', title: '金额', unit: '元', value: 'v', data: one('v', '金额', sum(rows, (r) => r.amount)) },
      { type: 'stat', title: '单数', unit: '单', value: 'v', data: one('v', '单数', rows.length) },
      { type: 'stat', title: '件数', unit: '件', value: 'v', data: one('v', '件数', sum(rows, (r) => r.qty)) },
      { type: 'progress', title: '完成', value: 'done', total: 'all', data: { columns: [col('done', 'integer', '完成'), col('all', 'integer', '全部')], rows: rows.length ? [{ done: rows.filter((r) => r.status === 'done').length, all: rows.length }] : [] } },
      { type: 'bar', title: '各月金额（按区堆叠）', x: 'month', y: 'amount', series: 'region', stacked: true, data: byMonthRegion },
      { type: 'line', title: '各月金额（按区）', x: 'month', y: 'amount', series: 'region', data: byMonthRegion },
      { type: 'pie', title: '各区单数', label: 'region', value: 'n', donut: true, span: 4, data: byRegion },
      { type: 'bar', title: '各区单数（横向）', x: 'region', y: 'n', horizontal: true, span: 4, data: byRegion },
      { type: 'form', title: '补一条备注', span: 4, columns: [{ name: 'title', type: 'text', label: '标题', required: true }, { name: 'amount', type: 'decimal', label: '金额' }, { name: 'day', type: 'date', label: '日期' }, { name: 'urgent', type: 'boolean', label: '加急' }] },
      { type: 'table', title: '明细', page_size: 8, value_labels: { status: { done: { text: '已完成', tone: 'success' }, doing: '进行中' } }, columns: ['status', 'id', 'day', 'region', 'owner', 'qty', 'amount', 'updated_at'], data: {
        columns: [col('id', 'integer', '单号', 'text'), col('day', 'date', '日期'), col('region', 'text', '区'), col('owner', 'text', '负责人', 'person'), col('qty', 'integer', '件数'), col('amount', 'decimal', '金额'), col('status', 'text', '状态', 'status'), col('updated_at', 'datetime', '更新')],
        rows: rows.slice(0, 40), truncated: rows.length > 40,
      } },
    ],
  };
}

const STATUS_TEXT: Record<string, { text: string; tone: 'success' | 'warning' | 'danger' }> = { done: { text: '已完成', tone: 'success' }, doing: { text: '进行中', tone: 'warning' }, late: { text: '已超期', tone: 'danger' } };
const few: BlockData = { columns: [col('k', 'text', '类目'), col('v', 'integer', '数量')], rows: [{ k: '甲', v: 12 }, { k: '乙', v: 7 }, { k: '丙', v: 3 }] };
const many: BlockData = { columns: [col('k', 'text', '类目'), col('s', 'text', '系列'), col('v', 'integer', '数量')], rows: ['甲', '乙', '丙'].flatMap((k, i) => ['一', '二', '三', '四', '五', '六', '七'].map((s, j) => ({ k, s, v: 3 + ((i * 5 + j * 3) % 8) }))) };

export default function BenchBlocksDemo() {
  const [params, setParams] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState('');
  const result = useMemo(() => render(params), [params]);
  return (
    <WmPage title="数据视图组件" subTitle="开发演示，合成数据">
      <Typography.Paragraph type="secondary">一、照一份视图取数的结果排出来的一页。改筛选栏，下面的块跟着变。</Typography.Paragraph>
      <BenchView result={result} onParams={setParams} onSubmit={() => new Promise((ok) => setTimeout(ok, 400))} />

      <Typography.Paragraph type="secondary" className="wm-bb-demo-gap">二、驾驶舱用得上的属性：环比、右上角的操作、数据截至、点了下钻、状态的说法。{picked ? `刚才点的是：${picked}` : ''}</Typography.Paragraph>
      <DashGrid>
        <StatBlock title="本月金额" unit="元" value="v" data={{ columns: [col('v', 'decimal', '金额')], rows: [{ v: 128450.5 }] }} delta={{ value: 3200, direction: 'up', label: '比上月' }} onClick={() => setPicked('统计卡')} />
        <StatBlock title="超期" unit="单" value="v" data={{ columns: [col('v', 'integer', '超期')], rows: [{ v: 7 }] }} delta={{ value: 2, direction: 'up', label: '比上周', good: 'down' }} />
        <StatBlock title="数据过期的卡" value="v" data={{ columns: [col('v', 'integer', '数')], rows: [{ v: 42 }] }} asOf={Date.now() - 3600_000} staleAfterMs={600_000} />
        <ProgressBlock title="写死总数的进度" value="v" total={50} unit="件" data={{ columns: [col('v', 'integer', '数')], rows: [{ v: 50 }] }} />
        <BarBlock title="点一根柱子" span={6} x="k" y="v" data={few} extra={<Button type="link" size="small">查看全部</Button>} onSelect={(rows, c) => setPicked(`柱 ${c}（${rows.length} 行）`)} />
        <PieBlock title="点一个扇区" span={6} label="k" value="v" data={few} onSelect={(rows, n) => setPicked(`扇区 ${n}（${rows.length} 行）`)} />
        <LineBlock title="一条线，带面积" span={6} x="month" y="amount" area data={{ columns: [col('month', 'text', '月份'), col('amount', 'decimal', '金额')], rows: ['01', '02', '03', '04', '05', '06'].map((m, i) => ({ month: `2026-${m}`, amount: 30000 + ((i * 7) % 5) * 4200 })) }} />
        <LineBlock title="系列太多：并成「其他」" span={6} x="k" y="v" series="s" data={many} />
        <TableBlock title="状态用人话、整行可点" span={6} data={{ columns: [col('status', 'text', '状态', 'status'), col('owner', 'text', '负责人', 'person'), col('n', 'integer', '件数')], rows: [{ status: 'done', owner: '周一', n: 3 }, { status: 'late', owner: { name: '吴二', seat: 'w2' }, n: 12000 }, { status: 'x-unknown', owner: '郑三', n: null }] }} statusText={(v) => STATUS_TEXT[String(v)] ?? null} onRowClick={(r) => setPicked(`行 ${String(r.status)}`)} rowActions={(r) => <Button type="link" size="small" onClick={() => setPicked(`操作 ${String(r.status)}`)}>催一下</Button>} />
      </DashGrid>

      <Typography.Paragraph type="secondary" className="wm-bb-demo-gap">三、四种状态：读取中、出错、空、数据不全。</Typography.Paragraph>
      <DashGrid>
        <StatBlock title="读取中" value="v" loading />
        <StatBlock title="出错" value="v" error={{ code: 'timeout' }} />
        <StatBlock title="空" value="v" data={{ columns: [], rows: [] }} empty="这个月还没有单。" />
        <ProgressBlock title="总数是 0" value="v" total="t" data={{ columns: [], rows: [{ v: 0, t: 0 }] }} />
        <BarBlock title="读取中" span={4} x="k" y="v" loading />
        <BarBlock title="出错：设置和数据对不上" span={4} x="k" y="v" error={{ code: 'invalid' }} />
        <PieBlock title="空：说清为什么" span={4} label="k" value="v" data={{ columns: [], rows: [] }} empty="还没有人提报。提报之后这里会按类别分出来。" />
        <TableBlock title="出错：数据太多" span={6} error={{ code: 'limit' }} />
        <TableBlock title="数据不全" span={6} pageSize={3} data={{ ...few, truncated: true }} />
        <FormBlock title="不能提交" span={6} fields={[{ name: 'title', type: 'text', label: '标题', required: true }]} onSubmit={() => Promise.resolve()} disabledReason="你的账号现在不能往这个台提报。" />
        <FormBlock title="提交被拒" span={6} fields={[{ name: 'title', type: 'text', label: '标题', required: true }]} onSubmit={() => Promise.reject({ code: 'invalid', message: '第 1 行 列 title：文本超过 10000 个字符' })} />
      </DashGrid>
    </WmPage>
  );
}
