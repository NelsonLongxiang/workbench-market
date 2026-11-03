#!/usr/bin/env node
/** 存量附件 MIME 审计（只读）：逐个读取台的已登记文件，按内容识别类型，与登记的 MIME 对照。
 *  只发 GET（文件头用 Range 取前 1MB），不改任何记录；判不符的交人工核查，不按文件名自动改。
 *  用法：node scripts/app-files-mime-audit.mjs <市场地址> <台 slug>  > report.csv
 *  输出 CSV：id,name,ext,size,stored_mime,detected_mime,suggested_mime,verdict,reason */
import { sniff } from '../server/src/file-sniff.ts';

const [base, slug] = process.argv.slice(2);
if (!base || !slug) { console.error('用法：node scripts/app-files-mime-audit.mjs <市场地址> <台 slug>'); process.exit(2); }
const HEAD = 1024 * 1024;
const csv = (v) => /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);

const files = [];
for (let before = 0; ;) {
  const r = await fetch(`${base.replace(/\/+$/, '')}/api/apps/${encodeURIComponent(slug)}/files?limit=200${before ? `&before_id=${before}` : ''}`);
  if (!r.ok) { console.error(`列文件失败 HTTP ${r.status}`); process.exit(1); }
  const j = await r.json();
  files.push(...j.items);
  if (!j.has_more) break;
  before = j.next_before_id;
}

console.log('id,name,ext,size,stored_mime,detected_mime,suggested_mime,verdict,reason');
const tally = {};
for (const f of files) {
  let head;
  try {
    const r = await fetch(`${base.replace(/\/+$/, '')}${f.url}`, { headers: { Range: `bytes=0-${HEAD - 1}` } });
    if (!r.ok && r.status !== 206) throw new Error(`HTTP ${r.status}`);
    head = new Uint8Array(await r.arrayBuffer()).subarray(0, HEAD);
  } catch (e) {
    console.log([f.id, f.original_name, '', f.size, f.mime, '', '', 'unreadable', e.message].map(csv).join(','));
    tally.unreadable = (tally.unreadable ?? 0) + 1;
    continue;
  }
  const s = sniff(f.original_name, head, f.size <= HEAD, f.mime);
  // 内容相符但登记的 MIME 不同（如 octet-stream）也要列出：只建议，不改
  const main = (m) => String(m || '').split(';')[0].trim().toLowerCase();  // 只比主类型，charset 等参数不算差异
  const verdict = s.verdict === 'ok' && main(s.mime) !== main(f.mime) ? 'stored_mime_differs' : s.verdict;
  tally[verdict] = (tally[verdict] ?? 0) + 1;
  console.log([f.id, f.original_name, s.ext, f.size, f.mime, s.detected, s.mime, verdict, s.reason].map(csv).join(','));
}
console.error(`共 ${files.length} 个文件：` + Object.entries(tally).map(([k, v]) => `${k} ${v}`).join('，'));
