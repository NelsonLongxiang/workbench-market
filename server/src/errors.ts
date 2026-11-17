/** 统一错误类型（S3 抽离）：cores 与路由共用，避免循环依赖。 */
export class HttpError extends Error {
  status: number;
  /** 附加到响应体的具名字段（如 #258 准入错误的 message / row_index）；error 字段仍是 message */
  extra?: Record<string, unknown>;
  constructor(status: number, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.status = status;
    if (extra) this.extra = extra;
  }
}

// 类型写在常量上（不是只写在箭头函数的返回值上）：这样 TypeScript 才认它是「调用之后不会往下走」的函数，
// 调用点后面的代码才会按前面的判断收窄。运行时没有区别。
export const bad: (msg: string) => never = (msg) => {
  throw new HttpError(400, msg);
};
