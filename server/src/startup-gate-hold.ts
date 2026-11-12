/** 服务进程拉上启动闸（见 startup-gate.ts）。index.ts 最先引入它，赶在 context.ts 装服务之前 */
import { holdUntilStartupPassed } from './startup-gate.ts';
holdUntilStartupPassed();
