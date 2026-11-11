// a2a-outbox-events-test.mjs 的子进程：在给定 DATA_DIR 上装事件层，按 argv 做一件事后退出。
//   seed    建一个事件：一行 held、一行 pending（照 recordEvent 的列直写）
//   release 经真实的放行路由（registerWorkbenchEventRoutes，守卫全放行）放行这个事件
const [, , action, eventId] = process.argv;
const { db } = await import('../server/src/db.ts');
const ev = await import('../server/src/workbench-events.ts');
ev.initWorkbenchEvents();
if (action === 'seed') {
  db.prepare("INSERT INTO workbench_events (event_id, source, workbench, item, context_id, submitter_kind, submitter, form_version, data_sha256, dispatch, routed) VALUES (?, 'app-data', 'demo', 'demo:1', 'wb:demo:1', 'human', 'human:alice', 1, ?, 0, 'default')").run(eventId, 'x'.repeat(64));
  db.prepare("INSERT INTO workbench_event_deliveries (event_id, target_team, target_url, caller_session, status, message) VALUES (?, 'dsh/aaaa', 'http://peer.invalid', 'market/test', 'held', '{\"m\":1}')").run(eventId);
  console.log('seeded');
} else if (action === 'release') {
  const express = (await import('../server/node_modules/express/index.js')).default;
  const app = express();
  app.use(express.json());
  ev.registerWorkbenchEventRoutes(app, { admin: () => true, sameOrigin: () => true });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const r = await fetch(`http://127.0.0.1:${server.address().port}/api/workbench-events/${eventId}/release`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  console.log('release', r.status);
  server.close();
}
process.exit(0);
