/**
 * #258 R3 业务 URL 登记准入（#030 A–F，docs/r3-url-allowlist-design.md v2）。
 * 单核：REST / MCP / GUI·复制 / update 新 url / 自产台自动登记 / import 全走 admitUrl。
 * - 公网（G4/G6/FQDN）只认 WM_REGISTER_URL_ALLOWLIST 精确 key；ALLOW_PUBLIC_NET 不再放行任何东西（breaking）。
 * - 私网 P4/P6、回环、内网短名沿原准入；硬拒 H4/H6 与混淆输入永远优先，列表与旧 flag 都救不了。
 * - 内部路径只收 /apps/<slug>/、/sop/<slug>/（及合法子路径），且台必须存在。
 * 审计：成功 commit 后每个命中许可的行一条 allow（stderr 单行 JSON）；deny 每 reason 每 60s 至多 10 条。
 */
import { createHash } from 'node:crypto';
import { isIPv6 } from 'node:net';
import { HttpError } from './errors.ts';

export const POLICY_VERSION = 'r3-url-allowlist-v2';

export type AdmissionKind = 'internal' | 'private' | 'public' | 'hard';
export interface Analysis {
  kind: AdmissionKind;
  /** 精确许可 key（scheme://host:port/path?query）；内部路径与无法规范化的为 null */
  key: string | null;
  /** 公网 key 的严格形态问题（fragment/点段/编码分隔符）：公网目标据此 400，私网不受影响 */
  strictProblem?: string;
  internal?: { area: 'apps' | 'sop'; slug: string };
}

/** 准入错误：error 字段 = 具名码，message = 中文说明（不回显原 URL/query/secret） */
export class AdmissionError extends HttpError {
  code: string;
  constructor(status: number, code: string, message: string) {
    super(status, code, { message });
    this.code = code;
  }
}
const invalid = (message: string): never => { throw new AdmissionError(400, 'invalid_url', message); };

// ---------- IPv4 ----------
const V4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
/** 只收标准四段十进制（无前导零）；其余返回 null */
export function parseV4(s: string): number | null {
  const m = V4_RE.exec(s);
  if (!m) return null;
  return ((Number(m[1]) << 24) >>> 0) + (Number(m[2]) << 16) + (Number(m[3]) << 8) + Number(m[4]);
}
const v4Str = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
const cidr4 = (s: string): [number, number] => { const [a, l] = s.split('/'); return [parseV4(a)!, Number(l)]; };
const in4 = (n: number, [base, len]: [number, number]) => len === 0 || (n >>> (32 - len)) === (base >>> (32 - len));

/** P4：合法私网/回环（不逐 URL 登记） */
export const P4 = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8'];
/** H4：硬拒（§3.1 穷举，不以「等」扩解释） */
export const H4 = ['0.0.0.0/8', '100.64.0.0/10', '169.254.0.0/16', '192.0.0.0/24', '192.0.2.0/24', '192.31.196.0/24', '192.52.193.0/24',
  '192.88.99.0/24', '192.175.48.0/24', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4'];
const P4C = P4.map(cidr4), H4C = H4.map(cidr4);
export function classifyV4(n: number): 'private' | 'public' | 'hard' {
  if (H4C.some((c) => in4(n, c))) return 'hard';
  if (P4C.some((c) => in4(n, c))) return 'private';
  return 'public';
}

// ---------- IPv6 ----------
/** 已经 isIPv6 校验过的文本 → 128 位整数（含 ::ffff:a.b.c.d 尾段） */
export function parseV6(s: string): bigint | null {
  let str = s.toLowerCase();
  const lc = str.lastIndexOf(':');
  const last = str.slice(lc + 1);
  if (last.includes('.')) {
    const v4 = parseV4(last);
    if (v4 === null) return null;
    str = str.slice(0, lc + 1) + (v4 >>> 16).toString(16) + ':' + (v4 & 0xffff).toString(16);
  }
  const halves = str.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let groups: string[];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null;
    groups = [...head, ...Array(fill).fill('0'), ...tail];
  }
  let v = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    v = (v << 16n) | BigInt(parseInt(g, 16));
  }
  return v;
}
const cidr6 = (s: string): [bigint, number] => { const [a, l] = s.split('/'); return [parseV6(a)!, Number(l)]; };
const in6 = (v: bigint, [base, len]: [bigint, number]) => (v >> BigInt(128 - len)) === (base >> BigInt(128 - len));
/** P6：::1 回环 ∪ fc00::/7 ULA */
export const P6 = ['::1/128', 'fc00::/7'];
/** G6 = 2000::/3 减 H6（保守整体阻断的特殊用途前缀）；其余 128 位全部硬拒（补集定义） */
export const G6 = '2000::/3';
export const H6 = ['2001::/23', '2001:db8::/32', '2002::/16', '2620:4f:8000::/48', '3fff::/20'];
const P6C = P6.map(cidr6), G6C = cidr6(G6), H6C = H6.map(cidr6);
const MAPPED = cidr6('::ffff:0:0/96');
export function classifyV6(v: bigint): { cls: 'private' | 'public' | 'hard'; mappedV4?: string } {
  if (in6(v, MAPPED)) { const n = Number(v & 0xffffffffn); return { cls: classifyV4(n), mappedV4: v4Str(n) }; }
  if (P6C.some((c) => in6(v, c))) return { cls: 'private' };
  if (in6(v, G6C) && !H6C.some((c) => in6(v, c))) return { cls: 'public' };
  return { cls: 'hard' };
}

// ---------- URL 分析 ----------
const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ENCODED_SEP_RE = /%(2f|5c|3f|23|25|2e)/i;
const upperHex = (s: string) => s.replace(/%[0-9a-f]{2}/gi, (x) => x.toUpperCase());

/** 百分号序列必须是合法 %HH，且解出的字节流（连同字面字符）是合法 UTF-8；只校验，不拿解码结果参与 key */
const UTF8 = new TextDecoder('utf-8', { fatal: true });
export function percentProblem(s: string): string | null {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '%') {
      const h = s.slice(i + 1, i + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(h)) return '含非法百分号编码（须 %HH）';
      bytes.push(parseInt(h, 16));
      i += 2;
    } else {
      bytes.push(...Buffer.from(s[i], 'utf8'));
    }
  }
  try { UTF8.decode(Uint8Array.from(bytes)); } catch { return '百分号编码解出的字节不是合法 UTF-8（超长/代理项/越界/截断）'; }
  return null;
}

function hasDotSegment(path: string): boolean {
  return path.split('/').some((seg) => seg === '.' || seg === '..');
}

/** 内部托管路径：/apps/<slug>/ 或 /sop/<slug>/ 加合法相对资产子路径；无 query/fragment/点段/编码分隔符/空段 */
function analyzeInternal(u: string): Analysis {
  const m = /^\/(apps|sop)\/([^/?#]*)\/(.*)$/.exec(u);
  if (!m || !SLUG_RE.test(m[2])) invalid('内部路径只收 /apps/<slug>/ 或 /sop/<slug>/（slug=小写字母数字开头·连字符·≤64）');
  const rest = m![3];
  if (/[?#]/.test(rest)) invalid('内部路径不收 query/fragment');
  if (ENCODED_SEP_RE.test(rest)) invalid('内部路径不收编码分隔符或编码点（%2f %5c %3f %23 %25 %2e）');
  const pp = percentProblem(rest);
  if (pp) invalid('内部路径' + pp);
  const segs = rest.split('/');
  segs.forEach((seg, i) => {
    if (seg === '.' || seg === '..') invalid('内部路径不收点段');
    if (seg === '' && i !== segs.length - 1) invalid('内部路径不收空段（//）');
    if (!/^[A-Za-z0-9._~!$&'()*+,;=:@%-]*$/.test(seg)) invalid('内部路径含非法字符');
  });
  return { kind: 'internal', key: null, internal: { area: m![1] as 'apps' | 'sop', slug: m![2] } };
}

/** 纯解析与分类（不查许可、不查库）。格式问题直接抛 400 invalid_url。 */
export function analyzeUrl(raw: string): Analysis {
  if (typeof raw !== 'string' || !raw) invalid('url 不能为空');
  if (/[\u0000- \u007f-\u009f\\]/.test(raw)) invalid('url 含控制字符、空白或反斜杠');
  if (raw.startsWith('/')) return analyzeInternal(raw);
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/.exec(raw);
  if (!m) invalid('url 形态非法（须 http(s)://host[:port]/path）');
  const scheme = m![1].toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') invalid('仅支持 http/https 协议');
  const authority = m![2], rawPath = m![3], fragment = m![5];
  if (authority.includes('@')) invalid('url 不收 userinfo（凭据请放 auth 配置）');
  let hostRaw: string, portRaw = '';
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    if (end < 0) invalid('IPv6 括号不完整');
    hostRaw = authority.slice(1, end);
    const after = authority.slice(end + 1);
    if (after && !/^:\d{1,5}$/.test(after)) invalid('IPv6 地址后只能跟 :端口');
    portRaw = after.slice(1);
    if (hostRaw.includes('%')) invalid('IPv6 zone-id 不收');
    if (!isIPv6(hostRaw)) invalid('IPv6 地址非法');
  } else {
    const parts = authority.split(':');
    if (parts.length > 2) invalid('主机含多余冒号（IPv6 须加方括号）');
    hostRaw = parts[0];
    if (parts.length === 2) { if (!/^\d{1,5}$/.test(parts[1])) invalid('端口非法'); portRaw = parts[1]; }
  }
  if (!hostRaw) invalid('主机为空');
  if (portRaw && (Number(portRaw) < 1 || Number(portRaw) > 65535)) invalid('端口越界');
  let u: URL;
  try { u = new URL(raw); } catch { return invalid('非法 URL'); }

  let cls: 'private' | 'public' | 'hard';
  let keyHost: string;
  if (authority.startsWith('[')) {
    const v = parseV6(hostRaw);
    if (v === null) invalid('IPv6 地址非法');
    const c = classifyV6(v!);
    cls = c.cls;
    keyHost = c.mappedV4 ?? u.hostname; // mapped 先归 v4：::ffff:8.8.8.8 与 8.8.8.8 同 key
  } else {
    const lower = hostRaw.toLowerCase();
    const ascii = /^[\x21-\x7e]*$/.test(hostRaw);
    const host = u.hostname;
    const looksV4 = /^[0-9.]+$/.test(host) && host.split('.').length === 4;
    if (looksV4) {
      // WHATWG 会把 0x7f000001 / 0177.0.0.1 / 2130706433 / 127.1 / 全角数字悄悄变成 IPv4——原文必须本来就是标准四段
      if (!ascii || lower !== host || parseV4(host) === null) invalid('数值主机只收标准四段十进制 IPv4');
      cls = classifyV4(parseV4(host)!);
    } else {
      if (ascii && lower !== host) invalid('主机名规范化后变形（非标准数值或编码主机）');
      if (host.endsWith('.') || host.split('.').some((l) => l === '')) invalid('主机名不收尾点或空标签');
      const labels = host.split('.');
      if (!labels.every((l) => LABEL_RE.test(l))) invalid('主机名标签非法（仅小写字母数字与中横线·1–63·首尾字母数字·不收通配）');
      if (labels.some((l) => /^\d+$/.test(l))) {
        // 10.attacker.example / 127.0.0.1.nip.io 型：全数值 label 的非 IP 主机一律硬拒（#242 回归）
        cls = 'hard';
      } else if (host === 'localhost' || labels.length === 1) {
        cls = 'private';
      } else {
        cls = 'public';
      }
    }
    keyHost = u.hostname;
  }

  const port = u.port || (scheme === 'https' ? '443' : '80');
  const pathname = u.pathname || '/';
  const key = `${scheme}://${keyHost}:${port}${upperHex(pathname)}${upperHex(u.search)}`;
  let strictProblem: string | undefined;
  if (fragment !== undefined) strictProblem = '许可 URL 不收 fragment';
  else if (hasDotSegment(rawPath)) strictProblem = '许可 URL 不收点段';
  else if (ENCODED_SEP_RE.test(rawPath)) strictProblem = '许可 URL 路径不收编码分隔符（%2f %5c %3f %23 %25 %2e）';
  else { const pp = percentProblem(rawPath + (m![4] ?? '')); if (pp) strictProblem = '许可 URL ' + pp; }
  return { kind: cls, key, strictProblem };
}

/**
 * 存量兼容：新 url 与原 url 是同一个规范化 key（host 大小写 / 显式缺省端口 / hex 大小写）且 fragment 相同，
 * 视为「url 未变」——旧行做元数据更新不因登记写法不同被拒。新 url 自身格式坏或公网严格形态不合法时不算。
 */
export function sameTarget(curUrl: string, nextUrl: string): boolean {
  let a: Analysis, b: Analysis;
  try { a = analyzeUrl(curUrl); b = analyzeUrl(nextUrl); } catch { return false; }
  if (!a.key || a.key !== b.key || a.kind !== b.kind || b.strictProblem) return false;
  const hash = (u: string) => { const i = u.indexOf('#'); return i < 0 ? '' : u.slice(i); };
  return hash(curUrl) === hash(nextUrl);
}

// ---------- 许可配置（WM_REGISTER_URL_ALLOWLIST，进程启动快照） ----------
const SENSITIVE_QUERY = new Set(['token', 'password', 'secret', 'api_key', 'access_token']);
export interface AllowPolicy { keys: Set<string>; digest: string; size: number; duplicates: number }

/** 解析许可列表；任何坏项（非数组/非字符串/格式坏/硬拒/非公网/敏感 query）整体抛错——由调用方拒绝启动 */
export function loadAllowPolicy(raw: string | undefined): AllowPolicy {
  let list: unknown = [];
  if (raw !== undefined && raw.trim() !== '') {
    try { list = JSON.parse(raw); } catch { throw new Error('WM_REGISTER_URL_ALLOWLIST 不是合法 JSON'); }
  }
  if (!Array.isArray(list)) throw new Error('WM_REGISTER_URL_ALLOWLIST 必须是 JSON 字符串数组');
  const keys = new Set<string>();
  let duplicates = 0;
  list.forEach((item, i) => {
    if (typeof item !== 'string' || !item) throw new Error(`WM_REGISTER_URL_ALLOWLIST[${i}] 不是非空字符串`);
    let a: Analysis;
    try { a = analyzeUrl(item); } catch (e: any) { throw new Error(`WM_REGISTER_URL_ALLOWLIST[${i}] 格式非法：${e?.extra?.message ?? e?.message}`); }
    if (a.kind === 'hard') throw new Error(`WM_REGISTER_URL_ALLOWLIST[${i}] 是硬拒目标，不能许可`);
    if (a.kind !== 'public') throw new Error(`WM_REGISTER_URL_ALLOWLIST[${i}] 不是公网目标（私网/回环/短名/内部路径沿原准入，不进许可列表）`);
    if (a.strictProblem) throw new Error(`WM_REGISTER_URL_ALLOWLIST[${i}] ${a.strictProblem}`);
    const q = new URL(item).searchParams;
    for (const k of q.keys()) if (SENSITIVE_QUERY.has(k.toLowerCase())) throw new Error(`WM_REGISTER_URL_ALLOWLIST[${i}] query 含敏感键（凭据请放 auth 配置）`);
    if (keys.has(a.key!)) duplicates++;
    keys.add(a.key!);
  });
  const digest = createHash('sha256').update(JSON.stringify({ policy: POLICY_VERSION, allow: [...keys].sort() })).digest('hex');
  return { keys, digest, size: keys.size, duplicates };
}

export interface AdmitResult extends Analysis { allowlisted: boolean }

/**
 * 准入判定（先验后写）：
 * 400 invalid_url（格式/内部路径/公网 key 严格形态）· 403 url_hard_denied · 403 url_not_allowlisted。
 * internalExists：内部路径的台必须存在（/sop/ 对 kind=sop，/apps/ 对其余）。
 */
export function admitUrl(raw: string, policy: AllowPolicy, internalExists: (area: 'apps' | 'sop', slug: string) => boolean): AdmitResult {
  const a = analyzeUrl(raw);
  if (a.kind === 'internal') {
    if (!internalExists(a.internal!.area, a.internal!.slug)) invalid('内部路径指向的托管台不存在（先发布台再登记）');
    return { ...a, allowlisted: false };
  }
  if (a.kind === 'hard') throw new AdmissionError(403, 'url_hard_denied', '目标属于硬拒地址（元数据/链路本地/未指定/保留/特殊用途/混淆主机），许可列表与旧开关都不能放行');
  if (a.kind === 'private') return { ...a, allowlisted: false };
  if (a.strictProblem) invalid(a.strictProblem);
  if (!policy.keys.has(a.key!)) throw new AdmissionError(403, 'url_not_allowlisted', '公网地址须由部署维护者写进 WM_REGISTER_URL_ALLOWLIST 精确许可后才能登记（ALLOW_PUBLIC_NET 已不再放行）');
  return { ...a, allowlisted: true };
}

/** health_path：相对路径照收；绝对 URL 必须与登记 URL 同 origin；拒协议相对、反斜杠、控制字符 */
export function checkHealthPath(url: string, hp: string): void {
  const v = (hp ?? '').trim();
  if (!v) return;
  const fail = (message: string): never => { throw new AdmissionError(400, 'invalid_health_path', message); };
  if (/[\u0000-\u001f\u007f\\]/.test(v)) fail('health_path 含控制字符或反斜杠');
  if (v.startsWith('//')) fail('health_path 不收协议相对地址');
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) {
    if (url.startsWith('/')) fail('内部路径台的 health_path 不能是绝对 URL');
    let a: URL, b: URL;
    try { a = new URL(v); b = new URL(url); } catch { return fail('health_path 非法'); }
    if (a.protocol !== 'http:' && a.protocol !== 'https:') fail('health_path 仅支持 http/https');
    if (a.origin !== b.origin) fail('health_path 绝对 URL 必须与登记 URL 同 origin');
  }
}

/** 类型级 health_path 没有自己的 origin，只收相对路径（被各台继承后在探测处再按台 origin 核） */
export function checkTypeHealthPath(hp: string): void {
  const v = (hp ?? '').trim();
  if (!v) return;
  const fail = (message: string): never => { throw new AdmissionError(400, 'invalid_health_path', message); };
  if (/[\u0000-\u001f\u007f\\]/.test(v)) fail('类型 health_path 含控制字符或反斜杠');
  if (v.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(v)) fail('类型 health_path 只收相对路径（绝对 URL 会被所有该类型的台继承成跨 origin 探测）');
}

// ---------- 审计（stderr 单行 JSON） ----------
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/** 输出通道：同步抛错或回调带 err 都算失败；write 返回 false（背压）不算失败 */
type AuditWriter = (line: string, done: (err?: Error | null) => void) => void;
let auditWrite: AuditWriter = (line, done) => { process.stderr.write(line, (err) => done(err)); };
/** 仅测试用：替换输出通道（生产不调用） */
export function _setAuditWriter(w: AuditWriter): void { auditWrite = w; }

/**
 * 已知的审计渠道故障（异步回调/流 error 后锁存）：锁存期间每次写都报降级。
 * 解除只认「最近一次故障之后才发起的写」成功回调：每次故障 gen+1，写发起时记下 gen，
 * 故障前发起的旧写迟到成功不能清掉更新的故障。
 */
const channel = { failed: false, failures: 0, lastAt: '', gen: 0 };
export function auditChannelState(): { failed: boolean; failures: number; last_failure_at: string } {
  return { failed: channel.failed, failures: channel.failures, last_failure_at: channel.lastAt };
}
/** 流 error 事件（index.ts 挂在 process.stderr 上）与写回调失败共用 */
export function markAuditChannelFailed(): void {
  channel.failed = true; channel.failures++; channel.gen++; channel.lastAt = new Date().toISOString();
}

function emit(obj: Record<string, unknown>): boolean {
  try {
    const startGen = channel.gen;
    auditWrite(JSON.stringify(obj) + '\n', (err) => {
      if (err) markAuditChannelFailed();
      else if (channel.failed && startGen === channel.gen) channel.failed = false; // 只有故障后发起的写成功才算恢复
    });
    return true;
  } catch { markAuditChannelFailed(); return false; }
}

/**
 * 成功 commit 后调：返回 false = 审计降级（调用方加 X-WM-Audit-State: degraded，不重试、不回滚业务写）。
 * 降级 = 本条同步写失败，或此前已锁存渠道故障（异步失败发生在上一响应之后也会在这里体现）。
 */
export function auditAllow(op: 'register' | 'update' | 'import', policy: AllowPolicy, key: string, workbenchId: number, subject: string): boolean {
  const knownBroken = channel.failed;
  const ok = emit({ event: 'workbench_url_allowlist', operation: op, policy_digest: policy.digest, url_digest: sha(key), workbench_id: workbenchId, subject, outcome: 'allow', at: new Date().toISOString() });
  if (!ok || knownBroken) {
    emit({ event: 'workbench_url_audit_failure', operation: op, workbench_id: workbenchId, sync_write_failed: !ok, channel_failures: channel.failures, last_failure_at: channel.lastAt || null, at: new Date().toISOString() });
    return false;
  }
  return true;
}

const DENY_WINDOW_MS = 60_000, DENY_MAX = 10;
const denyWin = new Map<string, { start: number; count: number; dropped: number }>();
let now = () => Date.now();
/** 仅测试用：注入时钟 */
export function _setAuditClock(f: () => number): void { now = f; denyWin.clear(); }

/** deny 限量：每 reason 每 60s 至多 10 条；窗口重置后第一条带上个窗口丢弃数 */
export function auditDeny(op: string, reason: string, key: string | null): void {
  const t = now();
  let w = denyWin.get(reason);
  let droppedPrev = 0;
  if (!w || t - w.start >= DENY_WINDOW_MS) { droppedPrev = w?.dropped ?? 0; w = { start: t, count: 0, dropped: 0 }; denyWin.set(reason, w); }
  if (w.count >= DENY_MAX) { w.dropped++; return; }
  w.count++;
  emit({ event: 'workbench_url_admission_denied', operation: op, reason, url_digest: key ? sha(key) : null, ...(droppedPrev ? { dropped_previous_window: droppedPrev } : {}), at: new Date(t).toISOString() });
}

/** 存量缺口（迁移材料）：现有行里按新规会被拒的，只出 id + 摘要 + 原因，不出原 URL */
export function legacyGaps(rows: { id: number; url: string }[], policy: AllowPolicy): { id: number; url_digest: string | null; reason: string }[] {
  const out: { id: number; url_digest: string | null; reason: string }[] = [];
  for (const r of rows) {
    try { admitUrl(r.url, policy, () => true); }
    catch (e: any) {
      let key: string | null = null;
      try { key = analyzeUrl(r.url).key; } catch { /* 格式坏到无 key */ }
      out.push({ id: r.id, url_digest: key ? sha(key) : null, reason: e?.code ?? 'invalid_url' });
    }
  }
  return out;
}
