/**
 * 预加载（测试夹具）：node --import <本文件> src/index.ts。把进程里的时钟整体平移，从 WM_REPLAY_CLOCK 给的时刻开始走。
 *
 * 给路由的录制回放用（scripts/route-replay-test.mjs，场景里写了 clock 才带上）：
 * 应答里凡是由「现在」算出来的数——还有几天过期、今天是哪一天——每次都不一样，定了时钟才能录下来比。
 *
 * 只平移 Date：new Date()、Date.now()、Date()。带参数的 new Date(x)、Date.parse、Date.UTC 照旧；定时器照常走。
 * 数据库自己取的时间（datetime('now')）不受影响，仍然是真的时间：
 * 拿数据库里的时间和进程里的「现在」比大小的路由，定了时钟行为会变，那样的场景不要写 clock。
 *
 * 只在 NODE_ENV=test 下干活。这个文件会随镜像一起发出去：在别的环境里被 --import 或 NODE_OPTIONS 带进来，
 * 进程直接退出，不会带着假的时钟起来。
 */
if (process.env.NODE_ENV !== 'test') {
  console.error('[replay-clock-preload] 拒绝加载：这是测试夹具，只在 NODE_ENV=test 下可用');
  process.exit(1);
}
const start = Date.parse(process.env.WM_REPLAY_CLOCK ?? '');
if (!Number.isFinite(start)) {
  console.error('[replay-clock-preload] 拒绝加载：WM_REPLAY_CLOCK 不是合法的时刻（要 ISO 写法，比如 2030-01-01T00:00:00Z）');
  process.exit(1);
}

const RealDate = Date;
const offset = start - RealDate.now();
const shiftedNow = () => RealDate.now() + offset;
const ShiftedDate = new Proxy(RealDate, {
  // new Date()：不带参数才是「现在」
  construct(target, args, newTarget) { return Reflect.construct(target, args.length === 0 ? [shiftedNow()] : args, newTarget); },
  // Date()：不带 new 调用，回的是「现在」的字符串
  apply(target) { return new target(shiftedNow()).toString(); },
  get(target, prop, receiver) { return prop === 'now' ? shiftedNow : Reflect.get(target, prop, receiver); },
});
// 让 x.constructor === Date 照旧成立
Object.defineProperty(RealDate.prototype, 'constructor', { value: ShiftedDate, writable: true, configurable: true, enumerable: false });
globalThis.Date = ShiftedDate;
