/**
 * 最小日志接口。
 *
 * core 不绑死具体日志库：任何「记一条日志」的实现都能塞进来
 * （本仓用的是 `@needle/logo` 的 Logger，它的四个级别方法签名是
 * `(...args: unknown[])`，与这里的 `(message, fields?)` 结构兼容）。
 */
export interface CoreLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/**
 * JWT 的 payload。
 *
 * 自己定义而不是用 `hono/jwt` 的类型：core 的公开类型（`CoreUser.payload`）
 * 不该把 hono 的内部类型泄露给业务代码。
 */
export interface CoreJwtPayload {
  [key: string]: unknown;
  exp?: number;
  nbf?: number;
  iat?: number;
  iss?: string;
  aud?: string | string[];
}

/**
 * 从 token 里解出来的用户。
 *
 * `verified` 是给调用方看的安全提示：没配 secret 时 token 只解不验，
 * 此时的 uid 是**任何人伪造得出来的**，只能拿去记日志，不能拿来授权。
 */
export interface CoreUser {
  uid: string;
  /** token 是否验签通过。 */
  verified: boolean;
  /** 原始 payload，业务要别的字段自己取。 */
  payload: CoreJwtPayload;
}

/** core 往 Hono context 里放的东西。 */
export interface CoreEnv {
  Bindings: {
    /**
     * 运行时挂在 env 上的 socket 查询能力（Bun 的 `Server.requestIP`）。
     *
     * core 用鸭子类型探测它，不绑死运行时——别的运行时没有就回落代理头。
     */
    requestIP?: (request: Request) => { address?: string } | null;
  };
  Variables: {
    /** 解出来的用户。没登录时不存在。 */
    user?: CoreUser;
    /** token 解不出来时的原因，写进请求结束日志。 */
    authError?: string;
    /** 处理函数抛出的异常。Hono 的 compose 会把异常吞成 500 响应，异常对象靠 onError 存进来。 */
    requestError?: Error;
  };
}
