#!/usr/bin/env node
/** MCP app_files_upload 完整性冒烟：有的 MCP 客户端会把过长的参数截短（常见截在 64KB），截在 4 的倍数上的 base64 照样能解码。
 *  覆盖：大文件经 /mcp 与 REST 工具完整收下；带 size / sha256 时不符即拒收且不落库；恰好 65536 字符又没带时按疑似截断拒收；
 *  坏 base64（长度不是 4 的倍数、非法字符）拒收；带对的 size / sha256 照常收。自起实例、空数据目录、网关开。 */
import { spawn } from './owned-script-fixture.mjs';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
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
  await fetch(`${B}/api/mcp/sessions/${s.id}/grants`, { method: 'PUT', headers: AT, body: JSON.stringify({ grants: ['app_files_upload', 'app_files_list'] }) });
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
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 300));
  rmSync(data, { recursive: true, force: true });
}
console.log(`\n===== MCP 上传完整性冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
