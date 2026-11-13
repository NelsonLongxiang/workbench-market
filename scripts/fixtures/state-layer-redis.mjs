/** 只给 state-layer-test 用的假 Redis：进程内的键值表，测试经 globalThis.__stateRedis 控制在线、出错、看表、看有没有断开 */
import { EventEmitter } from 'node:events';
const store = new Map();
const ctl = { online: true, failNext: false, destroyed: 0, lastSetOpts: null, store, offlineAfterBatches: null };
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
  const re = new RegExp(`^${MATCH.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  const all = [...store.keys()].filter((k) => re.test(k));
  for (let i = 0, b = 0; i < all.length; i += 2, b++) {
    if (ctl.offlineAfterBatches !== null && b >= ctl.offlineAfterBatches) { ctl.offlineAfterBatches = null; ctl.offline(); }
    use(); yield all.slice(i, i + 2); // 分批给，测分页
  }
};
// SOP 句柄用的几种（hash 存成对象、set 存成 Set）
const hashOf = (k) => { const v = store.get(k); if (v === undefined) { const h = {}; store.set(k, h); return h; } return v; };
client.hSet = async (k, a, v) => { use(); const h = hashOf(k); if (typeof a === 'object') Object.assign(h, a); else h[a] = v; return 1; };
client.hGet = async (k, f) => { use(); const v = store.get(k); return v && typeof v === 'object' && !(v instanceof Set) && Object.hasOwn(v, f) ? v[f] : null; };
client.hGetAll = async (k) => { use(); const v = store.get(k); return v && typeof v === 'object' && !(v instanceof Set) ? { ...v } : {}; };
const setOf = (k) => { let s = store.get(k); if (!(s instanceof Set)) { s = new Set(); store.set(k, s); } return s; };
client.sAdd = async (k, m) => { use(); setOf(k).add(m); return 1; };
client.sRem = async (k, m) => { use(); setOf(k).delete(m); return 1; };
client.sMembers = async (k) => { use(); return [...setOf(k)]; };
client.expire = async (k, s) => { use(); ctl.expires = { ...(ctl.expires ?? {}), [k]: s }; return 1; };
client.destroy = () => { ctl.destroyed++; ctl.online = false; };
ctl.offline = () => { ctl.online = false; client.emit('error', new Error('synthetic_offline')); client.emit('reconnecting'); };
ctl.back = () => { ctl.online = true; client.emit('ready'); };
export const createClient = () => client;
