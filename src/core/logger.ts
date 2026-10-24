import type { Context, MiddlewareHandler } from "hono";
import type { CoreEnv, CoreLogger } from "./types.ts";
import { newUid } from "./uid.ts";

/**
 * 客户端地址。
 *
 * 优先取 socket 真实地址（运行时把它挂在 `c.env` 上，Bun 是 `requestIP`），
 * 回落代理头。core 用鸭子类型探测，不绑死 Bun——别的运行时没有就只剩代理头。
 */
function clientIp(c: Context<CoreEnv>): string {
  const env: CoreEnv["Bindings"] | undefined = c.env;
  if (env !== undefined && typeof env.requestIP === "function") {
    try {
      const info = env.requestIP(c.req.raw);
      if (info !== null && info !== undefined && info.address !== undefined) {
        return info.address;
      }
    } catch {
      // 拿不到 socket 信息就回落代理头，不因此让请求失败
    }
  }

  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded !== undefined && forwarded !== "") {
    return forwarded.split(",")[0]?.trim() ?? "";
  }

  return c.req.header("x-real-ip") ?? "unknown";
}

/**
 * 请求日志中间件。
 *
 * 每个请求开始与结束各记一条 info，字段尽量多——出问题时第一件事就是想知道
 * 「刚才那个请求是谁发的、带了什么、走了哪条路、返回了什么、用了多久」：
 *
 *   request start → GET /api/search?q=ai · 127.0.0.1 · 8ms
 *   request end   → 200 · 8ms · uid=01ARZ…
 *
 * 5xx 另记一条 error：只看 info 的话，出错的请求和正常请求长得一样。
 * 处理函数抛出的异常由 `createHono` 装的 onError 存进 context，这里带出来。
 */
export function requestLogger(logger: CoreLogger): MiddlewareHandler<CoreEnv> {
  return async (c, next) => {
    const requestId = newUid();
    const startedAt = Date.now();
    const url = new URL(c.req.url);

    const startFields = {
      requestId,
      method: c.req.method,
      path: url.pathname,
      query: url.search.replace(/^\?/, ""),
      url: c.req.url,
      protocol: url.protocol.replace(":", ""),
      host: url.host,
      ip: clientIp(c),
      userAgent: c.req.header("user-agent") ?? "",
      referer: c.req.header("referer") ?? "",
      contentType: c.req.header("content-type") ?? "",
      contentLength: c.req.header("content-length") ?? "",
      // 只记「有没有带 token」，绝不记 token 本身
      hasAuthorization: c.req.header("authorization") !== undefined,
    };

    logger.info("request start", startFields);

    await next();

    const user = c.get("user");
    const endFields = {
      ...startFields,
      status: c.res.status,
      elapsedMs: Date.now() - startedAt,
      uid: user?.uid,
      authenticated: user !== undefined,
      verified: user?.verified ?? false,
      authError: c.get("authError"),
      responseContentType: c.res.headers.get("content-type") ?? "",
      responseContentLength: c.res.headers.get("content-length") ?? "",
      // 处理函数抛的异常（Hono 的 compose 吞成 500 响应，异常对象靠 onError 存进来）
      error: c.get("requestError"),
    };

    logger.info("request end", endFields);

    // 返回 5xx 的请求另记一条 error：只看 info 的话，出错的请求和正常请求长得一样
    if (c.res.status >= 500) {
      logger.error("request failed", endFields);
    }
  };
}
