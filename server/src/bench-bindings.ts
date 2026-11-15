/** Explicit, read-only numeric references in a saved view. No database, SQL or expression evaluation. */
export type VarRef = { var: string };
const KEY = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/;
export function isVarRef(v: unknown): v is VarRef {
  return !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1
    && Object.hasOwn(v, 'var') && typeof (v as VarRef).var === 'string' && KEY.test((v as VarRef).var);
}
type Block = Record<string, unknown>;
type Data = { columns: { name: string; type: string; label?: string }[]; rows: Record<string, unknown>[]; truncated?: boolean };
export type VarRead = (key: string) => Promise<{ value: unknown; revision: number } | undefined>;
type Failure = { code: string; message: string };
const obj = (v: unknown): v is Block => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** Only these saved slots can cause a read; request parameters and arbitrary object children never do. */
function refs(b: Block): VarRef[] {
  const out: VarRef[] = [];
  if ((b.type === 'stat' || b.type === 'progress') && isVarRef(b.value)) out.push(b.value);
  if (b.type === 'progress' && isVarRef(b.total)) out.push(b.total);
  if ((b.type === 'stat' || b.type === 'bar') && Array.isArray(b.tone_rules)) {
    for (const r of b.tone_rules) if (obj(r) && isVarRef(r.value)) out.push(r.value);
  }
  return out;
}
/** Resolve after the caller has authorized the saved view. The reader is already pinned to its card. */
export async function resolveViewVars<T extends { blocks: Block[] }>(result: T, read: VarRead): Promise<T> {
  if (!result.blocks.some(b => refs(b).length)) return result;
  const cache = new Map<string, Promise<{ value: number; revision: number } | Failure>>();
  const get = (key: string) => {
    if (!cache.has(key)) cache.set(key, (async () => {
      try {
        const hit = await read(key);
        if (!hit) return { code: 'not_found', message: '引用的常量或变量不存在' };
        if (!finite(hit.value) || !Number.isSafeInteger(hit.revision) || hit.revision < 1) return { code: 'invalid', message: '引用的常量或变量须为有限数字' };
        return { value: hit.value, revision: hit.revision };
      } catch (e) {
        const status = obj(e) ? e.status : undefined;
        return status === 404 ? { code: 'not_found', message: '引用的常量或变量不存在' }
          : status === 401 || status === 403 ? { code: 'forbidden', message: '不能读取引用的常量或变量' }
          : { code: 'unavailable', message: '引用的常量或变量暂时读不到，请稍后刷新' };
      }
    })());
    return cache.get(key)!;
  };
  const blocks: Block[] = [];
  for (const original of result.blocks) {
    const selected = refs(original);
    if (!selected.length || original.error) { blocks.push(original); continue; }
    const found = new Map<string, { value: number; revision: number }>();
    let failure: Failure | undefined;
    for (const ref of selected) {
      const hit = await get(ref.var);
      if ('code' in hit) { failure = hit; break; }
      found.set(ref.var, hit);
    }
    if (!failure && isVarRef(original.total) && found.get(original.total.var)!.value <= 0) failure = { code: 'invalid', message: '进度目标须为大于零的数字' };
    if (failure) { const { data: _d, ...rest } = original; blocks.push({ ...rest, error: failure }); continue; }
    const b = { ...original };
    const data = original.data as Data | undefined;
    let next: Data | undefined;
    const column = (slot: 'value' | 'total', ref: VarRef) => {
      next ??= data ? { ...data, columns: data.columns.map(c => ({ ...c })), rows: data.rows.map(r => ({ ...r })) } : { columns: [], rows: [{}], truncated: false };
      let name = data?.columns.length ? 'var_' + slot : slot;
      while (next.columns.some(c => c.name === name)) name += '_';
      next.columns.push({ name, type: 'decimal', label: typeof b.title === 'string' && slot === 'value' ? b.title : slot === 'total' ? '目标' : '数值' });
      for (const row of next.rows) row[name] = found.get(ref.var)!.value;
      b[slot] = name;
    };
    if ((b.type === 'stat' || b.type === 'progress') && isVarRef(b.value)) column('value', b.value);
    // total is passed as a resolved number, leaving existing ProgressBlock's contract unchanged.
    if (b.type === 'progress' && isVarRef(b.total)) b.total = found.get(b.total.var)!.value;
    if (next) b.data = next;
    if (Array.isArray(b.tone_rules)) b.tone_rules = b.tone_rules.map(r => obj(r) && isVarRef(r.value) ? { ...r, value: found.get(r.value.var)!.value } : r);
    b.var_revisions = Object.fromEntries([...found].map(([key, hit]) => [key, hit.revision]));
    blocks.push(b);
  }
  return { ...result, blocks };
}
