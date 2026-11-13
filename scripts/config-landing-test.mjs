#!/usr/bin/env node
/**
 * 配置的落点（server/src/config.ts）：模块自己的 Config。
 *
 *   C1 不给配置就取启动环境；给了同形对象就用给的，不碰全局环境
 *   C2 read 抛错 → validate 回 issues（Cordis 装插件时据此报 ValidationError，启动失败）
 *   C3 服务类插件的 static Config 经 Cordis 生效：ctx.plugin(P) 不给配置时构造函数拿到启动环境解析出的值；给了就用给的；非法值装不上；
 *      服务容器（context.ts）装上的沙箱服务拿到启动环境里的桥地址
 *   C4 收进 Config 的模块解析口径照旧（逐个对原来的表达式）
 *   C5 收进 Config 的文件里不再直接读 process.env（缺省的 process.env 只在 config.ts 出现）
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
const { defineConfig, loadConfig, str } = await import(src('config.ts'));
const C = defineConfig((env) => {
  if (env.CONFIG_LANDING_BAD) throw new Error('CONFIG_LANDING_BAD 不认');
  return { probe: str(env.CONFIG_LANDING_PROBE) };
});

// C1
ok('C1 不给配置取启动环境', C['~standard'].validate(undefined).value?.probe === 'from-env');
ok('C1 loadConfig 缺省取启动环境', loadConfig(C).probe === 'from-env');
ok('C1 给了同形对象就用给的', C['~standard'].validate({ CONFIG_LANDING_PROBE: 'given' }).value?.probe === 'given' && loadConfig(C, {}).probe === '');

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

// C5
const moved = ['eval.ts', 'github-source.ts', 'mcp-stdio-upstream.ts', 'routes/health.ts', 'services/sandbox.ts', 'sop-read-auth.ts', 'tasks.ts'];
const direct = moved.filter((f) => /\bprocess\.env\.[A-Z0-9_]+/.test(readFileSync(join(ROOT, 'server/src', f), 'utf8')));
ok('C5 收进 Config 的文件里不再直接读 process.env.名字', direct.length === 0, direct.join(', '));

rmSync(dataDir, { recursive: true, force: true });
console.log(`\nconfig-landing-test: ${pass} 过，${fail} 没过`);
process.exit(fail ? 1 : 0);
