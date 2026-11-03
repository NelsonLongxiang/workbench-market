#!/usr/bin/env node
/** 自产台数据契约 + 上传内容识别冒烟（纯函数，不起服务、不读数据库）。
 *  判据：契约本身写错时报错；必填/枚举/格式/条件必填/file_ids 归属逐条拦下；未声明类型按 unknown_types 放行或拒绝；
 *  上传按内容识别 PNG/JPEG/PDF/JSON/XLSX，扩展名与内容不符、可执行文件、旧的 octet-stream 存量都能判出。 */
import { checkRecord, parseContract } from '../server/src/app-data-contract.ts';
import { sniff } from '../server/src/file-sniff.ts';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

console.log('契约解析');
ok('非 JSON 报错', throws(() => parseContract('{')));
ok('缺 version 报错', throws(() => parseContract('{"types":{}}')));
ok('坏正则报错', throws(() => parseContract(JSON.stringify({ version: 1, types: { t: { pattern: { a: '(' } } } }))));
ok('unknown_types 非法值报错', throws(() => parseContract(JSON.stringify({ version: 1, unknown_types: 'maybe', types: {} }))));
ok('when.if 形态错报错', throws(() => parseContract(JSON.stringify({ version: 1, types: { t: { when: [{ if: { a: 'x' } }] } } }))));

const C = parseContract(JSON.stringify({
  version: 1, type_fields: ['record_type', 'type'], unknown_types: 'allow',
  types: {
    human_task: {
      required: ['item', 'line', 'task_kind', 'owner', 'state'],
      enum: { line: ['negotiate', 'appeal', 'reship', 'finance', 'other'], task_kind: ['progress', 'todo', 'issue', 'handoff'], state: ['待办', '进行中', '阻塞', '已完成'] },
      pattern: { task_ref: '^t\\d{3,}$', due_at: '^\\d{4}-\\d{2}-\\d{2}$' },
      when: [{ if: { line: ['negotiate', 'appeal', 'reship'] }, require: ['case_ref'] }],
      file_ids: true,
    },
    agent_delivery: {
      pattern: { zip_sha256: '^[a-f0-9]{64}$', spec_ref: '^spec_[0-9a-f]{12}@v\\d+$', run_id: '^run_[0-9a-f]{16}$', archive_id: '^arc_[0-9a-f]{12}$' },
      when: [{ if: { verdict: ['PASS'] }, require: ['spec_ref', 'run_id', 'archive_id', 'zip_sha256'], equals: { human_ack: true } }],
      file_ids: true,
    },
  },
}));
const files = new Set([10, 11]);
const has = (id) => files.has(id);
const good = { record_type: 'human_task', item: '补录发货凭证', line: 'reship', task_kind: 'todo', owner: '张三', state: '待办', case_ref: 'PO-1', task_ref: 't100001', due_at: '2026-11-05', file_ids: [10] };

console.log('人工任务');
ok('完整记录通过', checkRecord(C, good, has).length === 0, JSON.stringify(checkRecord(C, good, has)));
ok('缺必填被拦', checkRecord(C, { ...good, owner: '' }, has).some((e) => e.includes('owner')));
ok('不支持的 task_kind 被拦', checkRecord(C, { ...good, task_kind: 'deploy' }, has).some((e) => e.includes('task_kind')));
ok('格式不符的 task_ref 被拦', checkRecord(C, { ...good, task_ref: 'abc' }, has).some((e) => e.includes('task_ref')));
ok('售后线缺 case_ref 被拦', checkRecord(C, { ...good, case_ref: '' }, has).some((e) => e.includes('case_ref')));
ok('财务线不要求 case_ref', checkRecord(C, { ...good, line: 'finance', case_ref: '' }, has).length === 0);
ok('file_ids 指向别台/不存在的文件被拦', checkRecord(C, { ...good, file_ids: [99] }, has).some((e) => e.includes('99')));
ok('file_ids 非整数被拦', checkRecord(C, { ...good, file_ids: ['10'] }, has).some((e) => e.includes('正整数')));
ok('非对象被拦', checkRecord(C, [1], has).length === 1);
ok('超长字符串不进正则、直接拦下', checkRecord(C, { ...good, task_ref: 't' + '1'.repeat(5000) }, has).some((e) => e.includes('超过')));

console.log('交付事件（PASS 前提）');
const pass0 = { type: 'agent_delivery', verdict: 'PASS', spec_ref: 'spec_0123456789ab@v2', run_id: 'run_0123456789abcdef', archive_id: 'arc_0123456789ab', zip_sha256: 'a'.repeat(64), human_ack: true };
ok('PASS 要件齐全通过', checkRecord(C, pass0, has).length === 0, JSON.stringify(checkRecord(C, pass0, has)));
ok('PASS 缺 spec 被拦', checkRecord(C, { ...pass0, spec_ref: '' }, has).some((e) => e.includes('spec_ref')));
ok('PASS 缺人工确认被拦', checkRecord(C, { ...pass0, human_ack: false }, has).some((e) => e.includes('human_ack')));
ok('坏 SHA 被拦', checkRecord(C, { ...pass0, zip_sha256: 'xyz' }, has).some((e) => e.includes('zip_sha256')));
ok('坏 spec 格式被拦（含 FAIL）', checkRecord(C, { type: 'agent_delivery', verdict: 'FAIL', spec_ref: 'spec_x' }, has).some((e) => e.includes('spec_ref')));
ok('FAIL 不要求 PASS 要件', checkRecord(C, { type: 'agent_delivery', verdict: 'FAIL' }, has).length === 0);
ok('type 与 record_type 并存时取已声明的那个', checkRecord(C, { type: 'agent_delivery', record_type: 'production_progress', verdict: 'PASS' }, has).length > 0);

console.log('未声明类型');
ok('allow：放行', checkRecord(C, { record_type: 'whatever' }, has).length === 0);
const R = parseContract(JSON.stringify({ version: 1, unknown_types: 'reject', types: { a: {} } }));
ok('reject：拒绝', checkRecord(R, { record_type: 'whatever' }, has).length === 1);

console.log('上传内容识别');
const b = (...xs) => new Uint8Array(xs);
const PNG = b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0);
const JPG = b(0xff, 0xd8, 0xff, 0xe0, 0, 0);
const PDF = new TextEncoder().encode('%PDF-1.7\n...');
const ZIP = b(0x50, 0x4b, 0x03, 0x04, 0, 0);
const EXE = b(0x4d, 0x5a, 0x90, 0);
const enc = (s) => new TextEncoder().encode(s);
ok('PNG 识别并存 image/png', sniff('a.png', PNG, true, 'application/octet-stream').mime === 'image/png');
ok('JPEG 识别', sniff('a.JPG', JPG, true).verdict === 'ok');
ok('PDF 识别', sniff('a.pdf', PDF, true).mime === 'application/pdf');
ok('XLSX（ZIP 容器）识别', sniff('a.xlsx', ZIP, true).mime.includes('spreadsheetml'));
ok('JSON 识别', sniff('a.json', enc('{"a":1}'), true).mime === 'application/json');
ok('MD 识别为文本', sniff('README.md', enc('# 标题'), true).verdict === 'ok');
ok('.png 实为 PDF 判不符', sniff('a.png', PDF, true).verdict === 'mismatch');
ok('.pdf 无文件头判不符', sniff('a.pdf', enc('hello'), true).verdict === 'mismatch');
ok('.json 内容坏判不符', sniff('a.json', enc('{bad'), true).verdict === 'mismatch');
ok('.json 只读到文件头时不解析', sniff('a.json', enc('{"a":'), false).verdict === 'ok');
ok('.txt 含二进制判不符', sniff('a.txt', PNG, true).verdict === 'mismatch');
const GBK_CSV = b(0xb6, 0xa9, 0xb5, 0xa5, 0xba, 0xc5, 0x2c, 0xbd, 0xf0, 0xb6, 0xee, 0x0a, 0x31, 0x2c, 0x32, 0x0a); // 「订单号,金额」GBK 编码
ok('GBK 编码的 CSV 放行，存不带 charset 的 text/csv', (() => { const s = sniff('导出.csv', GBK_CSV, true); return s.verdict === 'ok' && s.mime === 'text/csv'; })());
ok('带 BOM 的 UTF-16 .txt 放行（Excel「Unicode 文本」）', sniff('导出.txt', b(0xff, 0xfe, 0x61, 0, 0x62, 0), true).mime === 'text/plain');
ok('带 BOM 的 UTF-16 .json 判不符', sniff('a.json', b(0xff, 0xfe, 0x7b, 0, 0x7d, 0), true).verdict === 'mismatch');
ok('含 NUL 的 .csv 判不符', sniff('a.csv', b(0x61, 0, 0x62), true).verdict === 'mismatch');
ok('非 UTF-8 的 .json 判不符', sniff('a.json', GBK_CSV, true).verdict === 'mismatch');
const SQLITE = new Uint8Array([...new TextEncoder().encode('SQLite format 3'), 0, 1, 2]);
const OLE = b(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0);
ok('SQLite 识别', sniff('snap.sqlite', SQLITE, true).mime === 'application/vnd.sqlite3');
ok('.sqlite 实为文本判不符', sniff('snap.sqlite', enc('hello'), true).verdict === 'mismatch');
ok('旧版 xls（OLE）识别', sniff('old.xls', OLE, true).mime === 'application/vnd.ms-excel');
ok('.xls 实为 ZIP 判不符', sniff('old.xls', ZIP, true).verdict === 'mismatch');
ok('RAR 识别', sniff('a.rar', b(0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0), true).verdict === 'ok');
ok('7z 识别', sniff('a.7z', b(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c), true).verdict === 'ok');
ok('.rar 实为 ZIP 判不符', sniff('a.rar', ZIP, true).verdict === 'mismatch');
ok('.db 不当 SQLite 强判（未知扩展名沿用上报）', sniff('x.db', enc('anything'), true, 'application/octet-stream').verdict === 'unknown');
ok('可执行文件拒收', sniff('setup.zip', EXE, true).verdict === 'executable');
ok('未知扩展名有签名时按签名', sniff('blob.bin', PNG, true).mime === 'image/png');
ok('未知扩展名无签名时沿用上报值', sniff('x.dat', enc('abc'), true, 'application/x-foo').mime === 'application/x-foo');

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
