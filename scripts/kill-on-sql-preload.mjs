// 测试夹具：进程里第一次执行含 KILL_ON_SQL 子串的 SQL 时，当场 SIGKILL 自己（模拟进程在两句之间被杀）。
// 只给测试用：node --import ./scripts/kill-on-sql-preload.mjs …；不设 KILL_ON_SQL 什么也不做。
import { DatabaseSync } from 'node:sqlite';

const needle = process.env.KILL_ON_SQL ?? '';
if (needle !== '') {
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (sql, ...rest) {
    const st = prepare.call(this, sql, ...rest);
    if (!String(sql).includes(needle)) return st;
    return new Proxy(st, {
      get(target, key) {
        if (key === 'run' || key === 'all' || key === 'get') return () => { process.kill(process.pid, 'SIGKILL'); };
        const v = Reflect.get(target, key);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  };
}
