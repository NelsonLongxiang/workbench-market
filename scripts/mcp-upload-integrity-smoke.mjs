#!/usr/bin/env node
/** MCP app_files_upload 完整性冒烟：有的 MCP 客户端会把过长的参数截短（常见截在 64KB），截在 4 的倍数上的 base64 照样能解码。
 *  覆盖：大文件经 /mcp 与 REST 工具完整收下；带 size / sha256 时不符即拒收且不落库；恰好 65536 字符又没带时按疑似截断拒收；
 *  坏 base64（长度不是 4 的倍数、非法字符）拒收；带对的 size / sha256 照常收。
 *  应答的核对结果（integrity / next）：MCP 与 REST 原始字节、multipart 上传，带对的 sha256 → sha256-verified，带错的 → 400 且库里和盘上都没有，
 *  不带 → unverified 且 sha256 与内容一致；skill_file_put 同样（不符不暂存）。自起实例、空数据目录、网关开。 */
import { spawn } from './owned-script-fixture.mjs';
import { mkdtempSync, rmSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };
const port = await new Promise((r) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
mkdirSync('tmp', { recursive: true });
const data = mkdtempSync(resolve('tmp/mcp-upload-integrity-'));
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], {
  cwd: 'server', stdio: ['ignore', 'ignore', 'pipe'],
  env: { ...process.env, PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data, ADMIN_TOKEN: 'upi-admin', MCP_GATEWAY: 'on', NODE_ENV: 'test' },
});
const B = `http://127.0.0.1:${port}`, AT = { 'X-Admin-Token': 'upi-admin', 'content-type': 'application/json' };
const j = async (r) => { try { return await r.json(); } catch { return null; } };
try {
  let up = false;
  for (let i = 0; i < 120 && !up; i++) { try { up = (await fetch(B + '/api/health')).ok; } catch { /* 未起 */ } if (!up) await new Promise((r) => setTimeout(r, 250)); }
  ok('实例就绪', up);
  const s = await j(await fetch(B + '/api/mcp/sessions', { method: 'POST', headers: AT, body: JSON.stringify({ name: 'upload-integrity' }) }));
  await fetch(`${B}/api/mcp/sessions/${s.id}/grants`, { method: 'PUT', headers: AT, body: JSON.stringify({ grants: ['app_files_upload', 'app_files_list', 'skill_file_put'] }) });
  const apps = await j(await fetch(B + '/api/apps', { headers: AT }));
  const slug = (Array.isArray(apps) ? apps : apps?.items ?? []).map((a) => a.slug)[0];
  ok('有可上传的自产台', !!slug, JSON.stringify(apps).slice(0, 120));
  const H = { Authorization: 'Bearer ' + s.token, 'content-type': 'application/json' };
  const call = async (args) => {
    const r = await fetch(B + '/mcp', { method: 'POST', headers: H, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'app_files_upload', arguments: { slug, ...args } } }) });
    const out = await j(r), text = out?.result?.content?.[0]?.text ?? out?.error?.message ?? '';
    let payload = null; try { payload = JSON.parse(text); } catch { /* 错误是纯文本 */ }
    return { isError: !!(out?.result?.isError || out?.error), text, payload };
  };
  const count = async () => ((await j(await fetch(`${B}/api/mcp-rest/tools/app_files_list`, { method: 'POST', headers: H, body: JSON.stringify({ slug, limit: 200 }) })))?.items ?? []).length;
  const bytes = randomBytes(200 * 1024), b64 = bytes.toString('base64'), sha = createHash('sha256').update(bytes).digest('hex');

  let r = await call({ name: 'big.bin', content_base64: b64 });
  ok('U1 200KB 经 /mcp 完整收下', !r.isError && r.payload?.size === bytes.length && r.payload?.sha256 === sha, r.text.slice(0, 120));
  const rr = await j(await fetch(B + '/api/mcp-rest/tools/app_files_upload', { method: 'POST', headers: H, body: JSON.stringify({ slug, name: 'big2.bin', content_base64: b64, size: bytes.length, sha256: sha }) }));
  ok('U1 200KB 经 REST 工具完整收下（带对的 size / sha256）', (rr?.result ?? rr)?.size === bytes.length, JSON.stringify(rr).slice(0, 120));

  const n0 = await count();
  const cut = b64.slice(0, 65536);
  r = await call({ name: 'cut.bin', content_base64: cut });
  ok('U2 恰好 65536 字符又没带 size / sha256：按疑似截断拒收', r.isError && r.text.includes('65536'), r.text.slice(0, 120));
  r = await call({ name: 'cut.bin', content_base64: cut, size: bytes.length });
  ok('U3 带了 size，收到的少了：拒收并说明', r.isError && r.text.includes('截断') && r.text.includes(String(bytes.length)), r.text.slice(0, 120));
  r = await call({ name: 'cut.bin', content_base64: b64.slice(0, 40000), sha256: sha });
  ok('U4 带了 sha256，内容不符：拒收', r.isError && r.text.includes('sha256'), r.text.slice(0, 120));
  r = await call({ name: 'cut.bin', content_base64: b64.slice(0, 65533) });
  ok('U5 长度不是 4 的倍数：拒收', r.isError && r.text.includes('不是完整的 base64'), r.text.slice(0, 120));
  r = await call({ name: 'cut.bin', content_base64: 'aGVsbG8*' });
  ok('U5 含非法字符：拒收', r.isError && r.text.includes('不是完整的 base64'), r.text.slice(0, 120));
  r = await call({ name: 'x.bin', content_base64: b64, size: -1 });
  ok('U6 size 非正整数：拒收', r.isError && r.text.includes('size'), r.text.slice(0, 120));
  ok('U7 被拒的都没落库', (await count()) === n0, `${await count()} vs ${n0}`);

  const small = Buffer.from('a,b\n1,2\n'), sb = small.toString('base64');
  r = await call({ name: 'small.csv', content_base64: sb, size: small.length, sha256: createHash('sha256').update(small).digest('hex') });
  ok('U8 小文件带对的 size / sha256 照常收', !r.isError && r.payload?.size === small.length, r.text.slice(0, 120));
  r = await call({ name: 'small2.csv', content_base64: sb.slice(0, 4) + '\n' + sb.slice(4) });
  ok('U8 base64 里带换行照常收（按 RFC 2045 折行）', !r.isError && r.payload?.size === small.length, r.text.slice(0, 120));
  const url = Buffer.from([0xfb, 0xff, 0xfe, 0x3e, 0x3f, 0x01]);
  r = await call({ name: 'u.bin', content_base64: url.toString('base64url').padEnd(Math.ceil(url.toString('base64url').length / 4) * 4, '='), size: url.length });
  ok('U9 URL 安全的 base64（- 和 _）照常收', !r.isError && r.payload?.size === url.length, r.text.slice(0, 120));

  // 应答的核对结果：带对的 sha256 → sha256-verified；带错的 → 拒收，库里和盘上都没有；不带 → unverified，sha256 与内容一致
  const onDisk = () => { const walk = (d) => existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name)) : [e.name]) : []; return walk(join(data, 'uploads')).length; };
  const doc = Buffer.from('核对结果 integrity\n'), docSha = createHash('sha256').update(doc).digest('hex'), wrongSha = 'f'.repeat(64);
  r = await call({ name: 'v1.txt', content_base64: doc.toString('base64'), sha256: docSha });
  ok('I1 MCP 带对的 sha256：integrity=sha256-verified，next 说不用下载回读', !r.isError && r.payload?.integrity === 'sha256-verified' && /无需下载回读/.test(r.payload?.next ?? ''), r.text.slice(0, 200));
  r = await call({ name: 'v2.txt', content_base64: doc.toString('base64'), size: doc.length });
  ok('I2 MCP 只带 size：integrity=size-verified', !r.isError && r.payload?.integrity === 'size-verified' && /不需要下载/.test(r.payload?.next ?? ''), r.text.slice(0, 200));
  r = await call({ name: 'v3.txt', content_base64: doc.toString('base64') });
  ok('I3 MCP 都没带：integrity=unverified，sha256 与内容一致，next 说比一下即可', !r.isError && r.payload?.integrity === 'unverified' && r.payload?.sha256 === docSha && /不需要下载/.test(r.payload?.next ?? ''), r.text.slice(0, 200));
  let rows0 = await count(), disk0 = onDisk();
  const viaTool = await fetch(B + '/api/mcp-rest/tools/app_files_upload', { method: 'POST', headers: H, body: JSON.stringify({ slug, name: 'v4.txt', content_base64: doc.toString('base64'), sha256: wrongSha }) });
  ok('I4 MCP 带错的 sha256：400，库里和盘上都没有', viaTool.status === 400 && (await count()) === rows0 && onDisk() === disk0, `${viaTool.status} ${await count()}/${rows0} ${onDisk()}/${disk0}`);

  const put = (name, headers = {}) => fetch(`${B}/api/mcp-rest/apps/${slug}/files/${encodeURIComponent(name)}`, { method: 'PUT', headers: { Authorization: 'Bearer ' + s.token, 'content-type': 'text/plain', ...headers }, body: doc });
  let pr = await put('r1.txt', { 'X-Content-SHA256': docSha }), pb = await j(pr);
  ok('I5 REST 原始字节带对的 X-Content-SHA256：201，sha256-verified', pr.status === 201 && pb?.integrity === 'sha256-verified' && pb?.sha256 === docSha && /无需下载回读/.test(pb?.next ?? ''), JSON.stringify(pb));
  pr = await put('r2.txt'); pb = await j(pr);
  ok('I6 REST 原始字节不带：201，unverified，sha256 与内容一致', pr.status === 201 && pb?.integrity === 'unverified' && pb?.sha256 === docSha, JSON.stringify(pb));
  rows0 = await count(); disk0 = onDisk();
  pr = await put('r3.txt', { 'X-Content-SHA256': wrongSha }); pb = await j(pr);
  ok('I7 REST 原始字节带错的 X-Content-SHA256：400，库里和盘上都没有', pr.status === 400 && /不符/.test(pb?.error ?? '') && (await count()) === rows0 && onDisk() === disk0, `${pr.status} ${JSON.stringify(pb)} ${onDisk()}/${disk0}`);
  pr = await put('r4.txt', { 'X-Content-SHA256': 'abc' }); pb = await j(pr);
  ok('I8 REST 原始字节 X-Content-SHA256 不是 64 位十六进制：400，没落库', pr.status === 400 && (await count()) === rows0 && onDisk() === disk0, `${pr.status} ${JSON.stringify(pb)}`);

  const multi = (name, field, headers = {}) => { const f = new FormData(); f.append('file', new Blob([doc], { type: 'text/plain' }), name); if (field) f.append('sha256', field); return fetch(`${B}/api/mcp-rest/apps/${slug}/files`, { method: 'POST', headers: { Authorization: 'Bearer ' + s.token, ...headers }, body: f }); };
  pr = await multi('m1.txt', docSha); pb = await j(pr);
  ok('I9 multipart 表单字段带对的 sha256：201，sha256-verified', pr.status === 201 && pb?.integrity === 'sha256-verified', JSON.stringify(pb));
  pr = await multi('m2.txt', null, { 'X-Content-SHA256': docSha }); pb = await j(pr);
  ok('I10 multipart 请求头带对的 sha256：201，sha256-verified', pr.status === 201 && pb?.integrity === 'sha256-verified', JSON.stringify(pb));
  pr = await multi('m3.txt', null); pb = await j(pr);
  ok('I11 multipart 不带：201，unverified，sha256 与内容一致', pr.status === 201 && pb?.integrity === 'unverified' && pb?.sha256 === docSha, JSON.stringify(pb));
  rows0 = await count(); disk0 = onDisk();
  pr = await multi('m4.txt', wrongSha); pb = await j(pr);
  ok('I12 multipart 带错的 sha256：400，库里和盘上都没有', pr.status === 400 && (await count()) === rows0 && onDisk() === disk0, `${pr.status} ${JSON.stringify(pb)} ${onDisk()}/${disk0}`);
  pr = await multi('m5.txt', docSha, { 'X-Content-SHA256': wrongSha }); pb = await j(pr);
  ok('I13 multipart 请求头和字段不一致：400，库里和盘上都没有', pr.status === 400 && (await count()) === rows0 && onDisk() === disk0, `${pr.status} ${JSON.stringify(pb)}`);

  // skill_file_put：同样可带期望的 sha256，不符拒收、不暂存；应答带 integrity / next
  const stage = () => { const d = join(data, 'skill-staging'); return existsSync(d) ? readdirSync(d) : []; };
  const skillPut = async (args) => {
    const r = await fetch(B + '/mcp', { method: 'POST', headers: H, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'skill_file_put', arguments: args } }) });
    const out = await j(r), t = out?.result?.content?.[0]?.text ?? out?.error?.message ?? '';
    let p = null; try { p = JSON.parse(t); } catch { /* 错误是纯文本 */ }
    return { isError: !!(out?.result?.isError || out?.error), text: t, payload: p };
  };
  const skillText = '# 合成技能\n核对结果\n', skillSha = createHash('sha256').update(skillText).digest('hex');
  r = await skillPut({ content: skillText, sha256: skillSha });
  ok('S1 skill_file_put 带对的 sha256：sha256-verified，暂存里有这个文件', !r.isError && r.payload?.integrity === 'sha256-verified' && r.payload?.sha256 === skillSha && /无需下载回读/.test(r.payload?.next ?? '') && stage().includes(skillSha), r.text.slice(0, 200));
  const other = '另一份内容\n', otherSha = createHash('sha256').update(other).digest('hex');
  r = await skillPut({ content: other });
  ok('S2 skill_file_put 不带：unverified，sha256 与内容一致', !r.isError && r.payload?.integrity === 'unverified' && r.payload?.sha256 === otherSha, r.text.slice(0, 200));
  const s0 = stage().length, third = '第三份\n';
  r = await skillPut({ content: third, sha256: wrongSha });
  ok('S3 skill_file_put 带错的 sha256：拒收，暂存里没多出文件', r.isError && /不符/.test(r.text) && stage().length === s0 && !stage().includes(createHash('sha256').update(third).digest('hex')), `${r.text.slice(0, 160)} ${stage().length}/${s0}`);
  r = await skillPut({ content: third, sha256: 'xyz' });
  ok('S4 skill_file_put 的 sha256 格式错：拒收，暂存不变', r.isError && /64 位十六进制/.test(r.text) && stage().length === s0, r.text.slice(0, 160));
  r = await skillPut({ content: Buffer.from(third).toString('base64'), encoding: 'base64', sha256: createHash('sha256').update(third).digest('hex').toUpperCase() });
  ok('S5 skill_file_put 二进制（base64）带对的 sha256（大写也认）：按解码后的字节核对', !r.isError && r.payload?.integrity === 'sha256-verified', r.text.slice(0, 200));
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 300));
  rmSync(data, { recursive: true, force: true });
}
console.log(`\n===== MCP 上传完整性冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
