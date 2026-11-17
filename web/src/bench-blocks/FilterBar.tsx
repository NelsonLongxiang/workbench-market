/**
 * 筛选栏：受控（value / onChange）。字段四种——月份、日期、下拉、搜索。值都是文本：月份 YYYY-MM，日期 YYYY-MM-DD。
 * 清空一个字段就是「全部」。
 */
import { DatePicker, Input, Select } from 'antd';
import dayjs from 'dayjs';
import { BlockFrame, type BlockFrameProps } from './Frame';

export type FilterField = {
  name: string; kind: 'month' | 'date' | 'select' | 'search'; label?: string;
  /** 下拉的选项：一组文本，或者 { value, label } */
  options?: (string | { value: string; label: string })[];
};
export interface FilterBarProps extends Omit<BlockFrameProps, 'data' | 'empty'> {
  fields: FilterField[];
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}

export function FilterBar({ fields, value, onChange, span = 12, ...frame }: FilterBarProps) {
  const set = (name: string, v: string) => {
    const next = { ...value };
    if (v) next[name] = v; else delete next[name];
    onChange(next);
  };
  return (
    <BlockFrame {...frame} span={span} kind="filter-bar" skipEmpty>
      <div className="wm-bb-filters">
        {fields.map((f) => {
          const label = f.label || f.name, v = value[f.name] ?? '';
          return (
            <label key={f.name} className="wm-bb-filter" data-filter={f.name}>
              <span className="wm-bb-filter-label">{label}</span>
              {f.kind === 'month' || f.kind === 'date' ? (
                <DatePicker
                  picker={f.kind === 'month' ? 'month' : 'date'} allowClear placeholder="全部"
                  value={v && dayjs(v).isValid() ? dayjs(v) : null}
                  onChange={(d) => set(f.name, d ? d.format(f.kind === 'month' ? 'YYYY-MM' : 'YYYY-MM-DD') : '')}
                />
              ) : f.kind === 'select' ? (
                <Select
                  allowClear placeholder="全部" className="wm-bb-filter-select" value={v || undefined} popupMatchSelectWidth={false}
                  options={(f.options ?? []).map((o) => (typeof o === 'string' ? { value: o, label: o } : o))}
                  onChange={(x) => set(f.name, typeof x === 'string' ? x : '')}
                />
              ) : (
                <Input.Search allowClear placeholder={`搜${label}`} defaultValue={v} className="wm-bb-filter-search" onSearch={(x) => set(f.name, x.trim())} />
              )}
            </label>
          );
        })}
      </div>
    </BlockFrame>
  );
}
