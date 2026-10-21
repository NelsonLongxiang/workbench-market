/**
 * A2A 网络接入（GH #17 P1）：Ed25519 签名卡片 + 人工绑定数据面。
 *
 * canonical/签名/验签与上游 dsh-open-a2a-net src/card.ts（裁判钉 75a3ebd）逐字节一致：
 * 签名面 {capabilities, expiresAt, name, [records], session, team}（键序固定），
 * Ed25519 pure（sign(undefined, payload)），公钥为 SPKI DER base64。
 * 修订 3 落实：卡片不发布 teamMemberships（绑定图不出门）；id8 每 SOP 随机生成持久化
 * （禁 slug 推导防抢注）；ADMIN_TOKEN 只经启动环境。
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as edSign, timingSafeEqual, verify as edVerify, type KeyObject } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir, db } from './db.ts';

export const MARKET_TEAM = process.env.MARKET_TEAM || 'market';
export const CARD_TTL_MS = 45 * 3600 * 1000; // 45h ≤ 上游 48h 预算

let cachedKey: KeyObject | null = null;

/** 首启生成 Ed25519 并存 DATA_DIR/a2a-key.pem（0600）；之后加载。 */
export function loadOrCreateKey(keyPath: string): KeyObject {
  if (cachedKey) return cachedKey;
  if (existsSync(keyPath)) {
    cachedKey = createPrivateKey(readFileSync(keyPath, 'utf8'));
    return cachedKey;
  }
  const { privateKey } = generateKeyPairSync('ed25519');
  writeFileSync(keyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  try { chmodSync(keyPath, 0o600); } catch { /* Windows 权限语义尽力而为 */ }
  cachedKey = privateKey;
  return cachedKey;
}

/** 与上游 canonicalPayload 逐字节一致（键序固定：字母序，records 可选插入）。 */
export function canonicalPayload(core: { capabilities: unknown; expiresAt: number; name: string; records?: unknown; session: string; team: string }): string {
  return JSON.stringify({
    capabilities: core.capabilities,
    expiresAt: core.expiresAt,
    name: core.name,
    ...(core.records !== undefined ? { records: core.records } : {}),
    session: core.session,
    team: core.team,
  });
}

/** 签名卡片核心（镜像上游 signCard：Ed25519 pure + SPKI DER base64 公钥）。 */
export function signCardCore(core: { capabilities: unknown; expiresAt: number; name: string; session: string; team: string }, privateKey: KeyObject): { publicKey: string; signature: string } {
  const signature = edSign(undefined, Buffer.from(canonicalPayload(core), 'utf8'), privateKey).toString('base64');
  return { publicKey: createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64'), signature };
}

/** 镜像验签（E2E 与自检用；裁判仍是上游 verifyCard）。 */
export function mirrorVerifyCard(wire: any, now: number): boolean {
  try {
    if (typeof wire?.name !== 'string' || typeof wire?.session !== 'string' || typeof wire?.team !== 'string') return false;
    if (typeof wire.expiresAt !== 'number' || typeof wire.publicKey !== 'string' || typeof wire.signature !== 'string') return false;
    if (wire.expiresAt <= now) return false;
    const pub = createPublicKey({ key: Buffer.from(wire.publicKey, 'base64'), format: 'der', type: 'spki' });
    return edVerify(undefined, Buffer.from(canonicalPayload(wire), 'utf8'), pub, Buffer.from(wire.signature, 'base64'));
  } catch {
    return false;
  }
}

/** SOP 的 a2a 节点短 id：随机 8 hex，一次生成持久化（apps.a2a_node8）——禁 slug 推导（修订 3 防抢注）。 */
export function sopNode8(slug: string): string {
  const row = db.prepare('SELECT a2a_node8 FROM apps WHERE slug = ?').get(slug) as { a2a_node8?: string } | undefined;
  if (row?.a2a_node8) return row.a2a_node8;
  const id8 = randomBytes(4).toString('hex');
  db.prepare('UPDATE apps SET a2a_node8 = ? WHERE slug = ?').run(id8, slug);
  return id8;
}

/** ADMIN_TOKEN 常量时间比较（两侧 sha256 定长再比；未设置一律拒绝）。 */
export function adminTokenOk(provided: string | undefined): boolean {
  const expect = process.env.ADMIN_TOKEN;
  if (!expect) return false;
  const h = (s: string) => createHash('sha256').update(s, 'utf8').digest();
  return timingSafeEqual(h(String(provided ?? '')), h(expect));
}

/**
 * 组装市场卡片（上卡规则：sessionTeams 只列 published 且 ≥1 有效绑定的 SOP；
 * 不发布 teamMemberships——绑定图不出门）。
 */
export function buildAgentCard(keyPath: string): Record<string, unknown> {
  const priv = loadOrCreateKey(keyPath);
  const now = Date.now();
  const rows = db.prepare(
    `SELECT DISTINCT a.slug, a.title, a.description, a.a2a_node8
       FROM apps a
       JOIN sop_bindings b ON b.sop_slug = a.slug AND b.revoked_at = ''
      WHERE a.kind = 'sop' AND a.status = 'published'
      ORDER BY a.slug`
  ).all() as { slug: string; title: string; description: string; a2a_node8: string }[];
  const sessionTeams = rows.map((r) => ({
    team: `${MARKET_TEAM}/${r.a2a_node8 || sopNode8(r.slug)}`,
    name: r.slug,
    description: r.description || r.title,
  }));
  let peers: string[] = [];
  try {
    const raw = db.prepare("SELECT value FROM settings WHERE key = 'a2a_peers'").get() as { value: string } | undefined;
    const parsed = raw ? JSON.parse(raw.value) : [];
    if (Array.isArray(parsed)) peers = parsed.filter((x) => typeof x === 'string');
  } catch { /* 配置坏值忽略 */ }
  const core = {
    capabilities: { sop: true, bindings: 'human-only', stage: 'P1-readonly' },
    expiresAt: now + CARD_TTL_MS,
    name: 'workbench-market',
    session: MARKET_TEAM,
    team: MARKET_TEAM,
  };
  const { publicKey, signature } = signCardCore(core, priv);
  return { ...core, sessionTeams, ...(peers.length ? { peers } : {}), version: 'p1', publicKey, signature };
}

export function a2aKeyPath(): string {
  return join(dataDir, 'a2a-key.pem');
}
