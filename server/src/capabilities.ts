/** 第 16 篇的领域声明。注册来自宿主或已装扩展，永不从调用请求加载代码。 */
import { HttpError } from './errors.ts';
import { catalogSummary } from './mcp-tools.ts';

const PART = /^[a-z][a-z0-9-]{0,47}$/;
const NAME = /^[a-z][a-z0-9-]{0,47}\.[a-z][a-z0-9-]{0,47}$/;
type Args = Record<string, unknown>;
export type CapabilityChannel = 'rest' | 'mcp-invoke';
export type CapabilityCaller = { sessionId: number; principal: string; area: string };
export type CapabilityDeclaration = {
  name: string;
  area: string;
  description: string;
  skill: string;
  properties: Readonly<Record<string, { type: 'string' | 'number' | 'integer' | 'boolean' }>>;
  required?: readonly string[];
} & (
  | { kind: 'read' | 'write'; run: (caller: CapabilityCaller, args: Args) => unknown }
  /** 已安装扩展负责将提案落库。只有站内的人确认之后，扩展才能执行决定。 */
  | { kind: 'decide'; propose: (caller: CapabilityCaller, args: Args) => { id: string; status: 'pending' } | Promise<{ id: string; status: 'pending' }> }
);
const registered = new Map<string, CapabilityDeclaration>();
const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype', 'principal', 'session_id', 'grants', 'route', 'url', 'sql', 'callback']);

export function addCapability(namespace: string, input: CapabilityDeclaration): () => void {
  if (!NAME.test(input.name) || !input.name.startsWith(namespace + '.') || !PART.test(input.area) || !PART.test(input.skill) || registered.has(input.name)) {
    throw new Error('领域能力名称、范围或说明技能无效，或名称已登记');
  }
  if (!['read', 'write', 'decide'].includes(input.kind) ||
    (input.kind === 'decide' ? typeof input.propose !== 'function' || 'run' in input : typeof input.run !== 'function' || 'propose' in input)) {
    throw new Error('决定类领域能力只可登记提案处理器');
  }
  const description = String(input.description).replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim().slice(0, 1000);
  const entries = Object.entries(input.properties);
  if (!description || entries.length > 32 || entries.some(([key, value]) => !/^[a-z][a-z0-9_]{0,47}$/.test(key) || forbiddenKeys.has(key) || !['string', 'number', 'integer', 'boolean'].includes(value?.type))) {
    throw new Error('领域能力说明或参数表不合法');
  }
  const properties = Object.fromEntries(entries.map(([key, value]) => [key, { type: value.type }]));
  const required = [...new Set(input.required ?? [])];
  if (required.some(key => !Object.hasOwn(properties, key))) throw new Error('必填参数必须在参数表登记');
  const cap = { ...input, description, properties, required };
  registered.set(cap.name, cap);
  return () => { if (registered.get(cap.name) === cap) registered.delete(cap.name); };
}
export function capability(name: unknown): CapabilityDeclaration | undefined {
  return typeof name === 'string' && NAME.test(name) ? registered.get(name) : undefined;
}
export function capabilityIndex() { return [...registered.values()].sort((a, b) => a.name.localeCompare(b.name)); }
export function capabilityBrief(cap: CapabilityDeclaration, granted: boolean) {
  return { name: cap.name, area: cap.area, description: catalogSummary(cap.description), kind: cap.kind, granted };
}
export function capabilityDetail(cap: CapabilityDeclaration, granted: boolean) {
  const input_schema = { type: 'object', additionalProperties: false, properties: cap.properties, required: cap.required };
  return {
    ...capabilityBrief(cap, granted), description: cap.description, skill: cap.skill, input_schema,
    openapi: { method: 'POST', path: '/api/mcp-rest/capabilities/' + cap.name, requestBody: { required: true, content: { 'application/json': { schema: input_schema } } } },
  };
}
export function capabilityDenied(): never {
  throw new HttpError(403, '本会话不能调用此领域能力', { code: 'capability_forbidden' });
}
export async function executeCapability(cap: CapabilityDeclaration, caller: CapabilityCaller, args: unknown): Promise<unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args) || (cap.required ?? []).some(key => !Object.hasOwn(args, key))) {
    throw new HttpError(400, '领域能力参数不是对象或缺少必填项', { code: 'capability_args_invalid' });
  }
  const clean: Args = Object.create(null);
  for (const [key, value] of Object.entries(args)) {
    const prop = Object.hasOwn(cap.properties, key) ? cap.properties[key] : undefined;
    const valid = prop?.type === 'integer' ? Number.isSafeInteger(value) : typeof value === prop?.type &&
      (typeof value !== 'number' || Number.isFinite(value)) && (typeof value !== 'string' || value.length <= 4096);
    if (!valid) throw new HttpError(400, '领域能力参数含未声明的字段或类型不符', { code: 'capability_args_invalid' });
    clean[key] = value;
  }
  if (cap.kind !== 'decide') return cap.run(caller, clean);
  const out = await cap.propose(caller, clean);
  if (!out || typeof out.id !== 'string' || out.status !== 'pending') throw new HttpError(500, '决定类领域能力须返回待确认的提案');
  return { id: out.id, status: out.status };
}
