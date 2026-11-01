/** Test-only in-memory Redis protocol; no sockets, credentials, production data. */
const hashes = new Map(), active = new Set();
let online = true;
const requireOnline = () => { if (!online) throw Error('synthetic_redis_unavailable'); };
const client = {
  get isReady() { return online; },
  on() { return this; }, async connect() { online = true; return this; },
  async hSet(key, field, value) { requireOnline(); const row = hashes.get(key) ?? {}; if (typeof field === 'object') Object.assign(row, field); else row[field] = value; hashes.set(key, row); },
  async hGetAll(key) { requireOnline(); return { ...(hashes.get(key) ?? {}) }; },
  async sAdd(_key, value) { requireOnline(); active.add(value); },
  async sRem(_key, value) { requireOnline(); active.delete(value); },
  async sMembers() { requireOnline(); return [...active]; },
  async expire() { requireOnline(); return 1; },
};
export const createClient = () => client;
process.on('message', msg => {
  if (msg?.kind !== 'synthetic-redis') return;
  if (msg.action === 'offline') online = false;
  if (msg.action === 'online') online = true;
  if (msg.action === 'clear') { hashes.clear(); active.clear(); }
  if (msg.action === 'active') { active.clear(); for (const id of msg.ids) active.add(String(id)); }
  process.send?.({ kind: 'synthetic-redis-receipt', id: msg.id, online, active: [...active] });
});
