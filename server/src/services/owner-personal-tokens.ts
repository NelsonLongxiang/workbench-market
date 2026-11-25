import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { db } from '../db.ts';
import { svc } from '../context.ts';
import { HttpError } from '../errors.ts';
import { getBench, resolveBenchRef } from './bench-registry.ts';
import type { GrantService } from './grant.ts';
import type { PrincipalService } from './principal.ts';

export const SCOPES = ['bench:read', 'bench:write', 'view', 'grants', 'report-dimensions'] as const;
export type Scope = typeof SCOPES[number];
const DAY = 86_400_000;
const NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,47}$/u;
const BENCH_REF = /^[a-z0-9][a-z0-9-]{0,63}$/;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

const metadata = 'id, principal, name, scopes, benches, created_at, expires_at, last_used_at, revoked_at';
type TokenRow = {
  id: string; principal: string; name: string; scopes: string; benches: string;
  created_at: number; expires_at: number; last_used_at: number | null; revoked_at: number | null;
};
const decode = (row: TokenRow) => ({ ...row, scopes: JSON.parse(row.scopes) as Scope[], benches: JSON.parse(row.benches) as string[] });
export type PersonalToken = ReturnType<typeof decode>;
function invalid(message: string): never { throw new HttpError(400, message, { code: 'personal_token_invalid' }); }

export function listPersonalTokens(principal: string): PersonalToken[] {
  return (db.prepare('SELECT ' + metadata + ' FROM owner_personal_tokens WHERE principal = ? ORDER BY created_at DESC, id').all(principal) as TokenRow[]).map(decode);
}

export function issuePersonalToken(principal: string, input: Record<string, unknown>, now = Date.now()) {
  if (!input || Object.keys(input).some(k => !['name', 'scopes', 'benches', 'expires_in_days'].includes(k))) invalid('个人令牌设置有不认识的字段');
  const { name, scopes, benches, expires_in_days: days = 30 } = input;
  if (typeof name !== 'string' || !NAME.test(name) || name !== name.trim()) invalid('令牌名称限 1～48 个字母、数字、空格、点、短横线或下划线');
  if (!Array.isArray(scopes) || scopes.length === 0 || scopes.length > SCOPES.length || scopes.some(s => !SCOPES.includes(s)) || new Set(scopes).size !== scopes.length) invalid('请选择有效且不重复的作用域');
  if (!Array.isArray(benches) || benches.length > 128 || benches.some(b => typeof b !== 'string' || !BENCH_REF.test(b))) invalid('请选择可用的台');
  const canonical = [...new Set((benches as string[]).map(resolveBenchRef))];
  if (canonical.some(b => !getBench(b)) || (canonical.length === 0 && (scopes as Scope[]).some(s => s !== 'report-dimensions'))) invalid('台相关的作用域须选择已登记的台');
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 90) invalid('有效期须为 1～90 天');
  const token = 'wmu_' + randomBytes(32).toString('base64url');
  const row = db.prepare('INSERT INTO owner_personal_tokens (id, token_sha256, principal, name, scopes, benches, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (principal, name) DO NOTHING RETURNING ' + metadata)
    .get(randomUUID(), digest(token), principal, name, JSON.stringify(scopes), JSON.stringify(canonical), now, now + Number(days) * DAY) as TokenRow | undefined;
  if (!row) throw new HttpError(409, '此令牌名称已使用，请换一个名字', { code: 'personal_token_name_taken' });
  return { token, personal_token: decode(row) };
}

export function revokePersonalToken(principal: string, id: string, now = Date.now()): boolean {
  return !!db.prepare('UPDATE owner_personal_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? AND principal = ? RETURNING id').get(now, id, principal);
}

export function authenticatePersonalToken(value: string, now = Date.now()): PersonalToken | null {
  const row = db.prepare('SELECT ' + metadata + ' FROM owner_personal_tokens WHERE token_sha256 = ? AND revoked_at IS NULL AND expires_at > ?').get(digest(value), now) as TokenRow | undefined;
  if (!row) return null;
  const person = svc<PrincipalService>('principals').get(row.principal);
  return person?.kind === 'person' && person.status === 'active' && svc<GrantService>('grants').isOwner(row.principal, now) ? decode(row) : null;
}

export function markPersonalTokenUsed(id: string, now = Date.now()): boolean {
  return !!db.prepare('UPDATE owner_personal_tokens SET last_used_at = CASE WHEN last_used_at > ? THEN last_used_at ELSE ? END WHERE id = ? AND revoked_at IS NULL AND expires_at > ? RETURNING id').get(now, now, id, now);
}
