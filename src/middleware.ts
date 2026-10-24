import type { MiddlewareHandler } from "hono";
import { getConnInfo } from "@hono/bun";
import type { Logger } from "@needle/logo";

/**
 * 请求日志中间件。
 *
 * 服务本身是「调试对象」——页面出问题时，第一件事就是想知道「刚才那个
 * 请求是谁发的、走了哪条路、返回了什么」。所以每个请求都留一条：
 *
 *   GET /d/2026-10-23 → 200 · 14ms · 127.0.0.1
 *
 * 4xx/5xx 记 warn/error，异常带调用栈。控制台的实时日志流里能直接看到。
 */
export function requestLogger(logger: Logger): MiddlewareHandler {
  return async (c, next) => {
    const startedAt = Date.now();
    const { pathname } = new URL(c.req.url);

    // 客户端地址：拿不到就记 "unknown"，不因此让请求失败
    let address = "unknown";
    try {
      address = getConnInfo(c).remote.address ?? "unknown";
    } catch {
      // 拿不到连接信息不影响请求本身
    }

    try {
      await next();
    } catch (error) {
      const elapsedMs = Date.now() - startedAt;
      logger.error("request failed", {
        method: c.req.method,
        path: pathname,
        elapsedMs,
        address,
        error,
      });
      throw error;
    }

    const elapsedMs = Date.now() - startedAt;
    const status = c.res.status;

    const fields = {
      method: c.req.method,
      path: pathname,
      status,
      elapsedMs,
      address,
    };

    // 状态码分级：5xx 记 error，4xx 记 warn，其余 info
    if (status >= 500) logger.error("request", fields);
    else if (status >= 400) logger.warn("request", fields);
    else logger.info("request", fields);
  };
}
