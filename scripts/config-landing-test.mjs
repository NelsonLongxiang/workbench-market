#!/usr/bin/env node
/**
 * 配置的落点（server/src/config.ts）：模块自己的 Config。
 *
 *   C1 不给配置就取启动环境；给了同形对象就用给的，不碰全局环境
 *   C2 read 抛错 → validate 回 issues（Cordis 装插件时据此报 ValidationError，启动失败）
 *   C3 服务类插件的 static Config 经 Cordis 生效：ctx.plugin(P) 不给配置时构造函数拿到启动环境解析出的值；给了就用给的；非法值装不上；
 *      服务容器（context.ts）装上的沙箱服务拿到启动环境里的桥地址
 *   C4 收进 Config 的模块解析口径照旧（逐个对原来的表达式）
 *   C5 收进 Config 的文件里不再直接读 process.env（缺省的 process.env 只在 config.ts 出现）：
 *      process.env.名字、process.env[变量]（动态读法，体检数不到）、process.env 起别名或解构都算；
 *      把整个环境原样传给子进程（{ ...process.env, … }）不算读配置
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => pathToFileURL(join(ROOT, 'server/src', p)).href;
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };

process.env.CONFIG_LANDING_PROBE = ' from-env ';
const dataDir = mkdtempSync(join(tmpdir(), 'wm-config-landing-'));
process.env.DATA_DIR = dataDir;
process.env.SANDBOX_BRIDGE_URL = ' http://bridge.invalid ';
const { defineConfig, loadConfig, passEnv, str } = await import(src('config.ts'));
const C = defineConfig((env) => {
  if (env.CONFIG_LANDING_BAD) throw new Error('CONFIG_LANDING_BAD 不认');
  return { probe: str(env.CONFIG_LANDING_PROBE) };
});

// C1
ok('C1 不给配置取启动环境', C['~standard'].validate(undefined).value?.probe === 'from-env');
ok('C1 loadConfig 缺省取启动环境', loadConfig(C).probe === 'from-env');
ok('C1 给了同形对象就用给的', C['~standard'].validate({ CONFIG_LANDING_PROBE: 'given' }).value?.probe === 'given' && loadConfig(C, {}).probe === '');

ok('C1 passEnv：只带点名的、非空的；不给就取启动环境', JSON.stringify(passEnv(['A', 'B', 'C'], { A: '1', B: '', D: '4' })) === '{"A":"1"}' && passEnv(['CONFIG_LANDING_PROBE']).CONFIG_LANDING_PROBE === ' from-env ');

// C2
const bad = C['~standard'].validate({ CONFIG_LANDING_BAD: '1' });
ok('C2 read 抛错 → issues', !bad.value && bad.issues?.[0]?.message === 'CONFIG_LANDING_BAD 不认', JSON.stringify(bad));
let threw = false; try { loadConfig(C, { CONFIG_LANDING_BAD: '1' }); } catch { threw = true; }
ok('C2 loadConfig 遇到非法值直接抛', threw);

// C3：Cordis 装插件时按 static Config 校验、把结果交给构造函数
const { Context, Service } = await import('@deepseek-ai/cordis');
class Probe extends Service {
  static Config = C;
  constructor(ctx, config) { super(ctx, 'configProbe'); this.got = config; }
}
{
  const ctx = new Context();
  await ctx.plugin(Probe);
  ok('C3 ctx.plugin(P) 不给配置：构造函数拿到启动环境解析出的值', ctx.get('configProbe')?.got?.probe === 'from-env', JSON.stringify(ctx.get('configProbe')?.got));
}
{
  const ctx = new Context();
  await ctx.plugin(Probe, { CONFIG_LANDING_PROBE: 'given' });
  ok('C3 ctx.plugin(P, env) 用给的', ctx.get('configProbe')?.got?.probe === 'given');
}
{
  const ctx = new Context();
  let err = null;
  try { await ctx.plugin(Probe, { CONFIG_LANDING_BAD: '1' }); } catch (e) { err = e; }
  ok('C3 非法值装不上', !ctx.get('configProbe'), String(err));
}

{
  const { svc } = await import(src('context.ts'));
  ok('C3 服务容器装上的沙箱服务拿到启动环境里的桥地址（库里没设时兜底）', svc('sandbox').bridgeUrl() === 'http://bridge.invalid', svc('sandbox').bridgeUrl());
}

// C4：各模块的 Config 照原来的口径解析
const eval_ = await import(src('eval.ts'));
ok('C4 eval：网关缺省、去空白', eval_.Config.read({}).gatewayUrl === 'https://ai-gateway.vercel.sh/v4/ai/evaluation-model' && eval_.Config.read({ EVAL_GATEWAY_URL: ' http://g.invalid ' }).gatewayUrl === 'http://g.invalid' && eval_.Config.read({ AI_GATEWAY_API_KEY: ' k ' }).apiKey === 'k');
const gh = await import(src('github-source.ts'));
ok('C4 github：缺省地址、去尾斜杠、令牌缺省空串', gh.Config.read({}).apiBase === 'https://api.github.com' && gh.Config.read({ WM_GITHUB_API: 'http://x.invalid//' }).apiBase === 'http://x.invalid' && gh.Config.read({}).token === '');
const cap = await import(src('sop-read-auth.ts'));
ok('C4 SOP 读能力：缺省 30、非数字回落、0 回落', cap.Config.read({}).readCapTtlDays === 30 && cap.Config.read({ SOP_READ_CAP_TTL_DAYS: 'x' }).readCapTtlDays === 30 && cap.Config.read({ SOP_READ_CAP_TTL_DAYS: '0' }).readCapTtlDays === 30 && cap.Config.read({ SOP_READ_CAP_TTL_DAYS: '7' }).readCapTtlDays === 7);
const health = await import(src('routes/health.ts'));
ok('C4 health：LayerFS 地址非空才算配了', health.Config.read({}).layerfs === false && health.Config.read({ LAYERFS_SERVICE_URL: '' }).layerfs === false && health.Config.read({ LAYERFS_SERVICE_URL: 'http://l.invalid' }).layerfs === true);
const tasks = await import(src('tasks.ts'));
const t = tasks.Config.read({ YGL_HOME: ' /h ', A2A_STATE_URL: ' http://a.invalid/ ', A2A_API_KEY: ' k ' });
ok('C4 tasks：工作区原样（不去空白）、A2A 去空白', t.yglHome === ' /h ' && t.a2aStateUrl === 'http://a.invalid/' && t.a2aApiKey === 'k' && tasks.Config.read({}).a2aStateUrl === '');
const up = await import(src('mcp-stdio-upstream.ts'));
ok('C4 MCP 上游：服务端工作区去空白', up.Config.read({ YGL_HOME: ' /h ' }).yglHome === '/h' && up.Config.read({}).yglHome === '');
const { SandboxService } = await import(src('services/sandbox.ts'));
ok('C4 沙箱：没设是 undefined（让库里的 settings 和缺省空串照原样兜底）', SandboxService.Config.read({}).bridgeUrl === undefined && SandboxService.Config.read({ SANDBOX_BRIDGE_TOKEN: 't' }).bridgeToken === 't');

const adminEnv = await import(src('admin-token-env.ts'));
ok('C4 管理口令：原样取（不去空白，和原来现读的口径一样）、没设是空串；本进程没设时三样都是「没有」', adminEnv.Config.read({ ADMIN_TOKEN: ' x ' }).token === ' x ' && adminEnv.Config.read({}).token === ''
  && adminEnv.adminTokenFromEnv() === false && adminEnv.envAdminTokenOk('') === false && adminEnv.envAdminTokenFingerprint() === '');
const gate = await import(src('outbound-gate.ts'));
let gateErr = ''; try { gate.Config.read({ WM_OUTBOUND: 'OFF' }); } catch (e) { gateErr = String(e?.message); }
ok('C4 对外断开：空和 on 是开、去空白的 off 是断开；别的值（大小写不同也算）拒绝启动、报错点名变量', gate.Config.read({}).off === false && gate.Config.read({ WM_OUTBOUND: 'on' }).off === false && gate.Config.read({ WM_OUTBOUND: ' off ' }).off === true
  && /WM_OUTBOUND 只能是 on 或 off/.test(gateErr) && !!gate.Config['~standard'].validate({ WM_OUTBOUND: 'yes' }).issues, gateErr);
const vault = await import(src('vault-api.ts'));
const vr = (e) => vault.Config.read(e);
ok('C4 凭据库：闲置分钟缺省 15、空串是 0（Number 口径）、负数和非数回落 15、小数照收', vr({}).idleMin === 15 && vr({ WM_VAULT_IDLE_MIN: '' }).idleMin === 0 && vr({ WM_VAULT_IDLE_MIN: '-1' }).idleMin === 15 && vr({ WM_VAULT_IDLE_MIN: 'x' }).idleMin === 15 && vr({ WM_VAULT_IDLE_MIN: '2.5' }).idleMin === 2.5);
ok('C4 凭据库：库路径去空白、空白算没设；主密码文件去空白；主密码原样（空格保留）', vr({ WM_VAULT_PATH: ' /v.json ' }).path === '/v.json' && vr({ WM_VAULT_PATH: '  ' }).path === '' && vr({ DSH_VAULT_PASSWORD_FILE: ' /pw ' }).passwordFile === '/pw' && vr({ DSH_VAULT_PASSWORD: ' p ' }).password === ' p ' && vr({}).password === '');
ok('C4 凭据库：没设库路径时用 DATA_DIR 下的缺省库', vault.vaultPath() === join(dataDir, 'vault', 'default.json'), vault.vaultPath());
const tr = (e) => tasks.Config.read(e);
ok('C4 tasks：项目数上限缺省 200、去空白、非整数和越界回落', tr({}).yglMaxProjects === 200 && tr({ YGL_MAX_PROJECTS: ' 40 ' }).yglMaxProjects === 40 && ['0', '1.5', '-5', 'abc', '10001'].every((v) => tr({ YGL_MAX_PROJECTS: v }).yglMaxProjects === 200) && tr({ YGL_MAX_PROJECTS: '10000' }).yglMaxProjects === 10000);
ok('C4 tasks：总预算缺省 8000、500～120000 之外回落', tr({}).yglTotalBudgetMs === 8000 && tr({ YGL_TOTAL_BUDGET_MS: '499' }).yglTotalBudgetMs === 8000 && tr({ YGL_TOTAL_BUDGET_MS: '120000' }).yglTotalBudgetMs === 120000 && tr({ YGL_TOTAL_BUDGET_MS: '120001' }).yglTotalBudgetMs === 8000);

// C5
/** 读配置的写法：点名字、方括号（动态）、可选链、起别名或解构。整个环境原样传给子进程（展开）不算 */
const READS = [/\bprocess\.env\s*(?:\?\.)?\.?\s*[A-Za-z_$[]/, /(?:=|\breturn)\s*process\.env\b(?!\s*(?:\?\.|\.|\[))/, /\bin\s+process\.env\b/];
const reads = (text) => READS.some((re) => re.test(text.replace(/\.\.\.process\.env\b/g, '')));
ok('C5 量法自检：点名字、方括号、可选链、别名、解构、in 都算；展开传给子进程不算',
  ['process.env.WM_X', 'process.env[name]', "process.env['WM_X']", 'process.env?.WM_X', 'process.env?.[k]', 'const e = process.env;', 'const { WM_X } = process.env', 'return process.env', "'WM_X' in process.env"].every(reads)
  && !['env: { ...process.env, A: 1 }', 'spawn(x, [], { env: { ...process.env } })', '// 不读环境'].some(reads));
const moved = ['eval.ts', 'github-source.ts', 'mcp-stdio-upstream.ts', 'routes/health.ts', 'services/sandbox.ts', 'sop-read-auth.ts', 'tasks.ts', 'routes/admin-token.ts', 'outbound-gate.ts', 'vault-api.ts', 'admin-token-env.ts'];
const direct = moved.filter((f) => reads(readFileSync(join(ROOT, 'server/src', f), 'utf8')));
ok('C5 收进 Config 的文件里不再读 process.env（含动态读法）', direct.length === 0, direct.join(', '));
{
  // 管理口令全进程只认 admin-token-env.ts 启动时取的那一份：server/src 下任何文件都不再自己读 ADMIN_TOKEN
  const { readdirSync, statSync } = await import('node:fs');
  const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : /\.(ts|mjs|js)$/.test(n) ? [p] : []; });
  const hits = walk(join(ROOT, 'server/src')).filter((f) => /process\.env\s*(?:\?\.)?\s*(?:\.\s*ADMIN_TOKEN\b|\[\s*['"`]ADMIN_TOKEN['"`]\s*\])/.test(readFileSync(f, 'utf8')));
  ok('C5 管理口令只在 admin-token-env.ts 启动时取一次：别处不再读 process.env.ADMIN_TOKEN', hits.length === 0, hits.join(', '));
}

rmSync(dataDir, { recursive: true, force: true });
console.log(`\nconfig-landing-test: ${pass} 过，${fail} 没过`);
process.exit(fail ? 1 : 0);
