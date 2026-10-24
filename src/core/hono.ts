import { Hono } from "hono";
import { jwtAuth } from "./auth.ts";
import { requestLogger } from "./logger.ts";
import type { CoreEnv, CoreLogger } from "./types.ts";

/** `createHono` 的参数。 */
export interface CreateHonoOptions {
  /** 传了就装请求日志中间件。 */
  logger?: CoreLogger;
  /** JWT 验签密钥。不传只解不验。 */
  jwtSecret?: string;
}

/**
 * 造一个装好通用中间件的 Hono 实例。
 *
 * 中间件顺序：**日志在外、鉴权在内**。这样「request start」是整个请求的
 * 第一条日志，而「request end」能拿到鉴权中间件写进 context 的 uid。
 */
export function createHono(options: CreateHonoOptions = {}): Hono<CoreEnv> {
  const app = new Hono<CoreEnv>();
  const logger = options.logger;

  if (logger !== undefined) {
    // Hono 的 compose 会把处理函数抛的异常吞成 500 响应（见 hono/compose.js），
    // 中间件里的 try/catch 根本抓不到。要拿到异常对象只能靠 onError：
    // 这里把它存进 context，请求结束日志再把它带出来。
    app.onError((error, c) => {
      c.set("requestError", error);
      return c.text("Internal Server Error", 500);
    });
    app.use("*", requestLogger(logger));
  }

  app.use("*", jwtAuth({ secret: options.jwtSecret }));

  return app;
}
