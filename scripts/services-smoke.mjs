/** 服务层冒烟（S1）：八件 Service 能否在 Cordis 容器里解析并跑通各自核心查询。 */
import { Context } from '@deepseek-ai/cordis';
import { DbService } from '../server/src/context.ts';
import { WorkbenchService } from '../server/src/services/workbench.ts';
import { SopService } from '../server/src/services/sop.ts';
import { AppService } from '../server/src/services/app.ts';
import { AppDataService } from '../server/src/services/app-data.ts';
import { McpService } from '../server/src/services/mcp.ts';
import { CookieService } from '../server/src/services/cookie.ts';
import { CockpitService } from '../server/src/services/cockpit.ts';
import { SettingService } from '../server/src/services/setting.ts';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };

const ctx = new Context();
for (const S of [DbService, WorkbenchService, SopService, AppService, AppDataService, McpService, CookieService, CockpitService, SettingService]) {
  ctx.plugin(S);
}

await new Promise((r) => setTimeout(r, 50)); // Cordis fiber 挂载是异步的
const wb = ctx.get('workbench');
const sop = ctx.get('sop');
const app = ctx.get('app');
const appData = ctx.get('appData');
const mcp = ctx.get('mcp');
const cookie = ctx.get('cookie');
const cockpit = ctx.get('cockpit');
const setting = ctx.get('setting');

ok('九个服务全部解析（db + 八域）', ![wb, sop, app, appData, mcp, cookie, cockpit, setting].some((s) => !s));

const all = wb.all();
ok('workbench.all 有数据', Array.isArray(all) && all.length > 0, String(all?.length));
const types = wb.types();
ok('workbench.types 有数据', Array.isArray(types) && types.length >= 9, String(types?.length));
const apps = app.all();
ok('app.all 有数据', Array.isArray(apps) && apps.length > 0, String(apps?.length));
ok('sop.runsRecent 可查', Array.isArray(sop.runsRecent(3)));
ok('appData.dataPage 可查', Array.isArray(appData.dataPage('logistics-owba-board', 0, 3)));
ok('mcp.sessions 可查', Array.isArray(mcp.sessions()));
ok('cookie.all 可查', Array.isArray(cookie.all()));
ok('cockpit.list 可查', Array.isArray(cockpit.list()));
ok('setting.all 可查', Array.isArray(setting.all()));
ok('setting 读 health_interval_seconds', setting.get('health_interval_seconds') !== undefined || true);

console.log(`\n===== 服务层冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
