/** Native table context and errors; no field/URL is inferred as an authorization capability. */
export type TableContext = { view: string; block: number; version: number; revision: string; params: Record<string, string> };
export function asTableContext(value: unknown): TableContext | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Partial<TableContext>;
  return typeof v.view === 'string' && Number.isSafeInteger(v.block) && Number(v.block) >= 0 && Number.isSafeInteger(v.version) && Number(v.version) > 0 && typeof v.revision === 'string' && /^[a-f0-9]{64}$/.test(v.revision) && !!v.params && typeof v.params === 'object' && !Array.isArray(v.params) ? v as TableContext : null;
}
export function tableReadError(status: number, body?: unknown): string {
  if (status === 401) return '请先登录后再查看或导出。';
  if (status === 403) return '你无权查看或导出这份来源；请联系原台管理方，不会自动开通权限。';
  if (status === 404) return '来源或该版本已不存在，未取得原证。';
  if (status === 409) return '数据、批次、版本或筛选已改变，请刷新后重新操作。';
  if (status === 413) return '完整结果超过导出上限，未下载截断文件；请缩小筛选范围。';
  if (status === 400) { const b = body as { message?: unknown } | null; if (typeof b?.message === 'string') return b.message; }
  return status === 0 ? '连不上服务器，请稍后重试。' : '这次未取得完整结果，请稍后重试。';
}
