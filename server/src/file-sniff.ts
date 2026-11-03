/** 按文件内容识别类型（不只看文件名或浏览器报的 MIME）。上传校验与存量审计共用。
 *  - 内容带已知签名（PNG/JPEG/GIF/WebP/PDF/ZIP/旧版 Office/SQLite/RAR/7z/gzip/可执行文件）时，以签名为准
 *  - 文本类扩展名（.json/.md/.txt/.csv…）：带二进制签名或含 NUL 判不符；非 UTF-8（如 GBK 导出的 CSV）放行，存不带 charset 的类型；.json 须是能解析的 UTF-8
 *  - 扩展名与内容不符 → mismatch：上传拒收，审计报告标出，交人工核查；不按文件名自动改 MIME */

type Family = 'png' | 'jpeg' | 'gif' | 'webp' | 'pdf' | 'zip' | 'ole' | 'sqlite' | 'rar' | '7z' | 'gzip' | 'exe' | 'text';

const EXT: Record<string, { family: Family; mime: string }> = {
  png: { family: 'png', mime: 'image/png' },
  jpg: { family: 'jpeg', mime: 'image/jpeg' },
  jpeg: { family: 'jpeg', mime: 'image/jpeg' },
  gif: { family: 'gif', mime: 'image/gif' },
  webp: { family: 'webp', mime: 'image/webp' },
  pdf: { family: 'pdf', mime: 'application/pdf' },
  zip: { family: 'zip', mime: 'application/zip' },
  xlsx: { family: 'zip', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  docx: { family: 'zip', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  pptx: { family: 'zip', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
  xls: { family: 'ole', mime: 'application/vnd.ms-excel' },
  doc: { family: 'ole', mime: 'application/msword' },
  sqlite: { family: 'sqlite', mime: 'application/vnd.sqlite3' },
  sqlite3: { family: 'sqlite', mime: 'application/vnd.sqlite3' },
  rar: { family: 'rar', mime: 'application/vnd.rar' },
  '7z': { family: '7z', mime: 'application/x-7z-compressed' },
  gz: { family: 'gzip', mime: 'application/gzip' },
  json: { family: 'text', mime: 'application/json' },
  md: { family: 'text', mime: 'text/markdown; charset=utf-8' },
  txt: { family: 'text', mime: 'text/plain; charset=utf-8' },
  csv: { family: 'text', mime: 'text/csv; charset=utf-8' },
  tsv: { family: 'text', mime: 'text/tab-separated-values; charset=utf-8' },
  yaml: { family: 'text', mime: 'application/yaml' },
  yml: { family: 'text', mime: 'application/yaml' },
  sha256: { family: 'text', mime: 'text/plain; charset=utf-8' },
  log: { family: 'text', mime: 'text/plain; charset=utf-8' },
};
const SIG_MIME: Record<Exclude<Family, 'text'>, string> = {
  png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf', zip: 'application/zip',
  ole: 'application/x-ole-storage', sqlite: 'application/vnd.sqlite3', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed', gzip: 'application/gzip', exe: 'application/x-executable',
};

function signature(b: Uint8Array): Exclude<Family, 'text'> | null {
  const at = (i: number, ...xs: number[]) => xs.every((x, k) => b[i + k] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'jpeg';
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'gif';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'webp';
  if (at(0, 0x25, 0x50, 0x44, 0x46, 0x2d)) return 'pdf';
  if (at(0, 0x50, 0x4b, 0x03, 0x04) || at(0, 0x50, 0x4b, 0x05, 0x06)) return 'zip';
  if (at(0, 0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)) return 'ole';   // 旧版 Office（xls/doc）
  if (at(0, 0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00)) return 'sqlite';  // "SQLite format 3\0"
  if (at(0, 0x52, 0x61, 0x72, 0x21, 0x1a, 0x07)) return 'rar';
  if (at(0, 0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c)) return '7z';
  if (at(0, 0x1f, 0x8b)) return 'gzip';
  if (at(0, 0x4d, 0x5a) || at(0, 0x7f, 0x45, 0x4c, 0x46) || at(0, 0xcf, 0xfa, 0xed, 0xfe) || at(0, 0xfe, 0xed, 0xfa, 0xcf) || at(0, 0xca, 0xfe, 0xba, 0xbe)) return 'exe';
  return null;
}

function isUtf8(b: Uint8Array, complete: boolean): boolean {
  // 只读了文件头时，末尾可能截断在多字节字符中间：去掉最后 3 字节再判
  const part = complete ? b : b.subarray(0, Math.max(0, b.length - 3));
  try { new TextDecoder('utf-8', { fatal: true }).decode(part); return true; } catch { return false; }
}

export interface Sniff {
  ext: string;
  detected: string;            // 按内容判出的 MIME；判不出时为 ''
  mime: string;                // 建议存储的 MIME
  verdict: 'ok' | 'mismatch' | 'executable' | 'unknown';
  reason: string;
}

/** head：文件开头若干字节（建议 ≥ 8KB）；complete：head 是否就是整份文件（.json 只在完整时解析）。 */
export function sniff(name: string, head: Uint8Array, complete: boolean, reported = ''): Sniff {
  const ext = (name.match(/\.([A-Za-z0-9]+)$/)?.[1] ?? '').toLowerCase();
  const want = EXT[ext];
  const sig = signature(head);
  if (sig === 'exe') return { ext, detected: SIG_MIME.exe, mime: SIG_MIME.exe, verdict: 'executable', reason: '内容是可执行文件' };
  if (want && want.family !== 'text') {
    if (sig === want.family) return { ext, detected: SIG_MIME[sig], mime: want.mime, verdict: 'ok', reason: '' };
    return { ext, detected: sig ? SIG_MIME[sig] : '', mime: reported || 'application/octet-stream', verdict: 'mismatch', reason: sig ? `扩展名 .${ext} 与内容（${SIG_MIME[sig]}）不符` : `扩展名 .${ext} 但内容没有该格式的文件头` };
  }
  if (want && want.family === 'text') {
    if (sig) return { ext, detected: SIG_MIME[sig], mime: reported || 'application/octet-stream', verdict: 'mismatch', reason: `扩展名 .${ext} 但内容是 ${SIG_MIME[sig]}` };
    // 带 BOM 的 UTF-16（Excel「Unicode 文本」另存）：含 NUL 但是文本；.json 仍须 UTF-8
    const utf16 = (head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff);
    if (utf16 && ext !== 'json') { const bare = want.mime.split(';')[0]; return { ext, detected: bare, mime: bare, verdict: 'ok', reason: '' }; }
    if (head.includes(0)) return { ext, detected: '', mime: reported || 'application/octet-stream', verdict: 'mismatch', reason: `扩展名 .${ext} 但内容含 NUL，不是文本` };
    if (!isUtf8(head, complete)) {
      if (ext === 'json') return { ext, detected: 'text/plain', mime: reported || 'application/octet-stream', verdict: 'mismatch', reason: '扩展名 .json 但内容不是 UTF-8' };
      const bare = want.mime.split(';')[0];  // 编码未知（常见 GBK 导出）：不声明 charset，交给打开方判断
      return { ext, detected: bare, mime: bare, verdict: 'ok', reason: '' };
    }
    if (ext === 'json' && complete) {
      try { JSON.parse(new TextDecoder().decode(head)); } catch { return { ext, detected: 'text/plain', mime: reported || 'application/octet-stream', verdict: 'mismatch', reason: '扩展名 .json 但内容不是合法 JSON' }; }
    }
    return { ext, detected: want.mime, mime: want.mime, verdict: 'ok', reason: '' };
  }
  // 扩展名不在识别表内：有签名就用签名，否则沿用上报值
  return { ext, detected: sig ? SIG_MIME[sig] : '', mime: sig ? SIG_MIME[sig] : (reported || 'application/octet-stream'), verdict: 'unknown', reason: '' };
}
