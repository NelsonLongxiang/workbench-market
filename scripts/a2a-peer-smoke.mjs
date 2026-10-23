#!/usr/bin/env node
/**
 * A2A peer 冒烟（上游实现承载 · 双 peer 真实 HTTP）
 * 覆盖：卡片可验 · 控制面 join · 入站派单→市场开 run · 出站发消息（/__bridge/send）· 状态
 * 依赖上游检出的 node_modules：`node --import ./scripts/a2a-peer-loader.mjs scripts/a2a-peer-smoke.mjs`
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';

const A_PORT = 9830, A_CTL = 9831;
const B_PORT = 9832, B_CTL = 9833;
const MARKET_PORT = 9834;
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };

async function waitReady(url, ms = 25000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.status < 500) return true; } catch { /* 未起 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
const json = async (url, method = 'GET', body) => {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j, headers: r.headers };
};

// 独立市场实例（桥接目标）
rmSync('tmp/e2e-peer-market', { recursive: true, force: true });
mkdirSync('tmp/e2e-peer-market', { recursive: true });
const market = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], {
  cwd: 'server', env: { ...process.env, PORT: String(MARKET_PORT), DATA_DIR: '../tmp/e2e-peer-market', REDIS_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'],
});
if (!(await waitReady(`http://127.0.0.1:${MARKET_PORT}/api/health`))) { console.log('  ✗ 市场实例未就绪'); process.exit(1); }
// 市场里先发一个 SOP 台（供派单开 run）
const made = await json(`http://127.0.0.1:${MARKET_PORT}/api/apps`, 'POST', {
  slug: 'peer-smoke-sop', kind: 'sop', title: 'peer 冒烟流程',
  files: [
    { path: 'sop.yaml', content: 'title: peer 冒烟流程\ncode: SOP-PEER-1\nsteps:\n  - key: s1\n    title: 第一步\n    body: "<p>demo</p>"\n' },
  ],
  changelog: '冒烟建台',
});
const pub = await json(`http://127.0.0.1:${MARKET_PORT}/api/sops/peer-smoke-sop/publish`, 'POST', {});
console.log('  · 建台:', made.status, JSON.stringify(made.body).slice(0, 140));
console.log('  · 上架:', pub.status, JSON.stringify(pub.body).slice(0, 140));

async function bootPeer(name, port, ctl, home, peers, marketBase) {
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  const child = spawn(process.execPath, ['--import', './scripts/a2a-peer-loader.mjs', 'scripts/a2a-peer.mjs'], {
    env: {
      ...process.env, PEER_PORT: String(port), PEER_CTL_PORT: String(ctl), PEER_HOME: home,
      PEER_NAME: name, PEER_SESSION: name, PEER_TEAM: name, PEER_PEERS: peers.join(','), PEER_TEAMS: `${name}/01234567`, MARKET_BASE: marketBase,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return child;
}

const A = await bootPeer('alpha', A_PORT, A_CTL, 'D:/workspace/workbench-market/tmp/peer-a', [`http://127.0.0.1:${B_PORT}`], `http://127.0.0.1:${MARKET_PORT}`);
const B = await bootPeer('beta', B_PORT, B_CTL, 'D:/workspace/workbench-market/tmp/peer-b', [], `http://127.0.0.1:${MARKET_PORT}`);
try {
  const aReady = await waitReady(`http://127.0.0.1:${A_CTL}/__bridge/state`);
  const bReady = await waitReady(`http://127.0.0.1:${B_CTL}/__bridge/state`);
  ok('A/B 两个 peer 就绪', aReady && bReady);

  // ① 卡片（最小面）可读且带签名
  const card = await json(`http://127.0.0.1:${B_PORT}/.well-known/agent-card.json`);
  ok('卡片可读', card.status === 200 && card.body?.name === 'beta');
  ok('卡片带公钥与签名', typeof card.body?.publicKey === 'string' && typeof card.body?.signature === 'string');

  // ② 控制面 join（B 的会话节点）
  const state = await json(`http://127.0.0.1:${B_PORT}/__dsh_a2a/state`);
  const sess = state.body?.sessions?.[0];
  ok('B 有 live 会话节点', !!sess?.id, JSON.stringify(state.body?.sessions ?? []).slice(0, 120));
  const joined = await json(`http://127.0.0.1:${B_PORT}/__dsh_a2a/join`, 'POST', { id: sess.id, team: sess.team });
  ok('控制面 join 成功', joined.status === 200 && joined.body?.id === sess.id);

  // ③ 入站派单 → 桥接 → 市场开 run
  const dispatch = await json(`http://127.0.0.1:${B_PORT}/a2a/direct`, 'POST', {
    team: sess.team,
    message: JSON.stringify({ sop: { slug: 'peer-smoke-sop', action: 'start' } }),
    caller_session: 'dsh/abcdef01',
  });
  const reply = dispatch.body?.result?.text ?? '';
  ok('派单被 peer 受理', dispatch.status === 200 && dispatch.body?.routed === true, JSON.stringify(dispatch.body).slice(0, 160));
  ok('桥接在市场开了 run', /run #\d+/.test(reply), reply);

  // ④ 出站前 A 的会话也要入网（join 是宿主侧人控）
  const aState0 = await json(`http://127.0.0.1:${A_PORT}/__dsh_a2a/state`);
  const aSess = aState0.body?.sessions?.[0];
  await json(`http://127.0.0.1:${A_PORT}/__dsh_a2a/join`, 'POST', { id: aSess.id, team: aSess.team });
  // ④ 出站：A 经桥接控制面给 B 发消息（B 的桥接 agent 收到并回）
  // 自环出站（A 的会话节点）：证 /__bridge/send 的发件链完整（工具门→准入→投递→回执）
  const send = await json(`http://127.0.0.1:${A_CTL}/__bridge/send`, 'POST', {
    team: aSess.team,
    message: '出站冒烟：来自 alpha 的问候',
  });
  ok('出站 send 成功', send.status === 200 && send.body?.ok === true, JSON.stringify(send.body).slice(0, 200));
  const outText = JSON.stringify(send.body?.result ?? {});
  ok('自环投递收到桥接回复', /桥接：/.test(outText) || /已受理/.test(outText) || /ok/.test(outText), outText.slice(0, 160));
  // 跨 peer 出站：未共享队时按网络规则拒（admission），断言错误形状而非成功——
  // 跨机互通需要双方加入同一队（canvas/team），属主人配置面，冒烟只证「拒绝是有理由的」
  const cross = await json(`http://127.0.0.1:${A_CTL}/__bridge/send`, 'POST', {
    team: sess.team,
    message: '跨 peer 冒烟',
  });
  const crossText = JSON.stringify(cross.body?.result ?? {});
  ok('跨 peer 未共享队时按规则拒绝', /not published|team membership|refus/i.test(crossText), crossText.slice(0, 160));

  // ⑤ 状态面
  const aState = await json(`http://127.0.0.1:${A_CTL}/__bridge/state`);
  ok('桥接状态面可读', aState.body?.name === 'alpha' && aState.body?.bridge === 'market');
} finally {
  A.kill(); B.kill(); market.kill();
  await new Promise((r) => setTimeout(r, 600));
}
console.log(`\n===== A2A peer 冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
