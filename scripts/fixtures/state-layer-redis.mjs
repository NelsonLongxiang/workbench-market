/** 只给 state-layer-test 用的假 Redis：进程内的键值表，测试经 globalThis.__stateRedis 控制在线、出错、看表、看有没有断开 */
import { EventEmitter } from 'node:events';
const store = new Map();
const ctl = { online: true, failNext: false, destroyed: 0, lastSetOpts: null, store };
globalThis.__stateRedis = ctl;
const client = new EventEmitter();
Object.defineProperty(client, 'isReady', { get: () => ctl.online });
const use = () => { if (!ctl.online) throw new Error('synthetic_offline'); if (ctl.failNext) { ctl.failNext = false; throw new Error('synthetic_error'); } };
client.connect = async () => { client.emit('ready'); return client; };
client.get = async (k) => { use(); return store.has(k) ? store.get(k) : null; };
client.set = async (k, v, opts) => { use(); ctl.lastSetOpts = opts ?? null; store.set(k, v); return 'OK'; };
client.del = async (keys) => { use(); let n = 0; for (const k of keys) if (store.delete(k)) n++; return n; };
client.scanIterator = async function* ({ MATCH }) {
  use();
  const prefix = MATCH.endsWith('*') ? MATCH.slice(0, -1) : MATCH;
  const all = [...store.keys()].filter((k) => (MATCH.endsWith('*') ? k.startsWith(prefix) : k === MATCH));
  for (let i = 0; i < all.length; i += 2) { use(); yield all.slice(i, i + 2); } // 分批给，测分页
};
client.destroy = () => { ctl.destroyed++; ctl.online = false; };
ctl.offline = () => { ctl.online = false; client.emit('error', new Error('synthetic_offline')); client.emit('reconnecting'); };
ctl.back = () => { ctl.online = true; client.emit('ready'); };
export const createClient = () => client;
