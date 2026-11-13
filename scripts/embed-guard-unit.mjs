#!/usr/bin/env node
/** 嵌台防护（web/src/embed-guard.ts）：登记的地址指不指向市场自己、框里是不是市场自己的页面。 */
import { BENCH_PATHS, FRAMED_SELF_TEXT, MARKET_SELF_TEXT, USE_SELF_TEXT, framedByMarket, isMarketDocument, pointsAtMarket } from '../web/src/embed-guard.ts';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };
const O = 'http://market.test';

ok('同源、在台的路径下（/apps/、/sop/、/go/）：是台，照嵌', !pointsAtMarket('/apps/trial-output/', O) && !pointsAtMarket('/sop/task-center/', O) && !pointsAtMarket(`${O}/go/3/`, O) && BENCH_PATHS.length === 3);
ok('同源、不在台的路径下（/、/cockpit/1、/market）：指向市场自己，不嵌', pointsAtMarket('/', O) && pointsAtMarket(`${O}/cockpit/1`, O) && pointsAtMarket('/market', O) && pointsAtMarket('/apps', O));
ok('别的来源、空的、解析不了的：不算（交给服务端的准入）', !pointsAtMarket('https://other.test/', O) && !pointsAtMarket('', O) && !pointsAtMarket(undefined, O) && !pointsAtMarket('http://[bad', O));
ok('框里的页面带市场的标记才算市场自己；读不到（别的来源抛错）不算', isMarketDocument({ querySelector: (s) => (s.includes('wm-surface') ? {} : null) }) && !isMarketDocument({ querySelector: () => null }) && !isMarketDocument(null) && !isMarketDocument({ querySelector: () => { throw new Error('cross-origin'); } }));
ok('说法照协调定的', MARKET_SELF_TEXT === '这个台的地址指向市场本身，不能嵌在驾驶舱里');

// 第二层防护在框里的页面上判：在框里、外面读得到、外面也是市场，才算「市场套市场」
{
  const market = { querySelector: (q) => (q.includes('wm-surface') ? {} : null) }, other = { querySelector: () => null };
  const self = {}, top = {};
  ok('被市场嵌在框里：算', framedByMarket({ self, top, parent: { document: market } }));
  ok('自己就是最外层：不算', !framedByMarket({ self, top: self, parent: self }) && !framedByMarket({ self, top: self, parent: { document: market } }));
  ok('外面不是市场（别的页面嵌了市场）：不算', !framedByMarket({ self, top, parent: { document: other } }));
  ok('外面读不到（别的来源，读 document 抛错）：不算、不抛', !framedByMarket({ self, top, parent: { get document() { throw new Error('cross-origin'); } } }) && !framedByMarket({ self, top, parent: null }));
  ok('三种说法：驾驶舱、/use、框里各一句，后两句说清去找谁改', MARKET_SELF_TEXT.includes('指向市场本身') && USE_SELF_TEXT.includes('请管理员改一下登记的地址') && FRAMED_SELF_TEXT.includes('请管理员改一下登记的地址'));
}
console.log(`\nembed-guard-unit: ${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
