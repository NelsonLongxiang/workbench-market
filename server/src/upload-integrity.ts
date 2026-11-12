/**
 * 上传应答里的「核对结果」：调用方带了期望的 sha256 或 size、服务端对上了才会存，所以成功应答本身就说明核对过。
 * 把这件事写进应答（integrity 和给 agent 看的 next），agent 就不必为了验证再把文件下载回来。
 * MCP 工具 app_files_upload 与 REST 原始字节、multipart 上传共用；拒收规则不在这里，各自照旧。
 */
export type UploadIntegrity = 'sha256-verified' | 'size-verified' | 'unverified';

const NEXT: Record<UploadIntegrity, string> = {
  'sha256-verified': '服务端已按你给的 sha256 核对过并保存，无需下载回读',
  'size-verified': '服务端已按你给的 size 核对过字节数并保存；要逐字节确认，把应答里的 sha256 和本地文件的 sha256 比一下即可，不需要下载',
  unverified: '把应答里的 sha256 和本地文件的 sha256 比一下即可，不需要下载',
};

/** 成功存下之后的核对结果：带了 sha256 且对上 → sha256-verified；只带 size 且对上 → size-verified；都没带 → unverified */
export function uploadIntegrity(wantSha: string | null, wantSize: number | null): { integrity: UploadIntegrity; next: string } {
  const integrity: UploadIntegrity = wantSha !== null ? 'sha256-verified' : wantSize !== null ? 'size-verified' : 'unverified';
  return { integrity, next: NEXT[integrity] };
}

/** 请求里声明的期望 sha256：没带 → null；带了但不是 64 位十六进制 → 'bad'；否则小写 */
export function expectedSha256(raw: unknown): string | null | 'bad' {
  if (raw === undefined || raw === null) return null;
  const s = String(Array.isArray(raw) ? raw[0] : raw).trim().toLowerCase();
  if (s === '') return null;
  return /^[0-9a-f]{64}$/.test(s) ? s : 'bad';
}
