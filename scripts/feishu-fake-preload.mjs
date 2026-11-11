/**
 * 录制回放用的夹具（--import 预加载）：在市场进程里起一个假飞书（scripts/feishu-fake.mjs，只听 127.0.0.1），
 * 建一个临时凭据库放好合成的应用凭证（含事件订阅的 Encrypt Key、Verification Token），并把飞书登录的配置指过去。必须在 index.ts 之前跑：飞书插件在引入时读一次配置。
 * 预先登记两个授权码：replay-code-alice、replay-code-bob（回放没法走一遍授权页）。
 *
 * 只在测试环境里装得上（NODE_ENV=test）：scripts/ 会随镜像一起发出去，不能在别的环境里把飞书指到假的上。
 */
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { APP, startFakeFeishu } from './feishu-fake.mjs';

if (process.env.NODE_ENV !== 'test') {
  console.error('[feishu-fake-preload] 拒绝加载：只在 NODE_ENV=test 下可用');
  process.exit(1);
}
const root = resolve(process.env.IDENTITY_SEAM_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..'));
const fake = await startFakeFeishu({ fixedCodes: { 'replay-code-alice': 'alice', 'replay-code-bob': 'bob' } });
const vault = join(process.env.DATA_DIR ?? '.', 'feishu-fake-vault', 'default.json');
mkdirSync(dirname(vault), { recursive: true });
const MASTER = 'Synthetic-Vault-Master-2026!replay';
const { openVault } = await import(pathToFileURL(join(root, 'server/src/vault/store.ts')).href);
const store = await openVault({ masterPassword: MASTER, path: vault });
await store.add({ title: 'feishu-login', kind: 'login', username: APP.id, password: APP.secret, fields: { encrypt_key: APP.encryptKey, verification_token: APP.verificationToken } });
await store.lock();
Object.assign(process.env, fake.env, { WM_VAULT_PATH: vault, DSH_VAULT_PASSWORD: MASTER });
