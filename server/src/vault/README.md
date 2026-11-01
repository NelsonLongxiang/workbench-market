# server/src/vault —— dsh-vault 存储层（引入件）

来源：[Ox0400/dsh-vault](https://github.com/Ox0400/dsh-vault) `v1.10.75`（提交 `d544455`，npm `dsh-vault@1.10.75`），MIT，许可证见同目录 `LICENSE`。

| 文件 | 来源 | 改动 |
|---|---|---|
| `crypto.ts` `home-paths.ts` `totp.ts` `password.ts` `password-strength.ts` `breach.ts` | `src/<同名>.ts` | 无 |
| `store.ts` | `src/store.ts` | ① 原子写从 `@deepseek-ai/dsh-atomic-write` 换成本地 `./atomic-write.ts`；② `openVault` / `load` 加 `clearStaleLock` 选项（缺省 true=上游行为），市场传 false——上游只在启动时删「残留写锁」，市场运行中会重开库，不能删别的进程正持有的锁 |
| `atomic-write.ts` | `@deepseek-ai/dsh-atomic-write@0.1.0-rc.6`（MIT） | 移植成 TS；原包依赖 cordis 运行时，市场不引 |

为什么不直接装 npm 包：包的 `exports` 只开放 DSH 插件入口（依赖 cordis / dsh-tools / dsh-llm 等运行时），存储层没有公开出口；写盘还硬依赖 `@deepseek-ai/dsh-atomic-write`。

**不要在这里改业务逻辑**——要改先改上游，再按上表重新同步。磁盘格式（scrypt + AES-256-GCM、`<库>.json` / `<库>-audit.json` / `<库>.json.lock`）必须与上游一致，市场和 DSH 插件才能共用同一个库文件。

同步方法：

```bash
git -C <dsh-vault 检出> show v<版本>:src/store.ts > server/src/vault/store.ts   # 其余文件同理
# 再把上表 store.ts 的两处改动补回去（grep workbench-market）
node scripts/vault-smoke.mjs
```

HTTP 面与安全口径见 `server/src/vault-api.ts`。
