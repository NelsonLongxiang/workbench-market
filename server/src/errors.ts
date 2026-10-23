/** 统一错误类型（S3 抽离）：cores 与路由共用，避免循环依赖。 */
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const bad = (msg: string): never => {
  throw new HttpError(400, msg);
};
