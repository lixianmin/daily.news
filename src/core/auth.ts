import type { MiddlewareHandler } from "hono";
import { decode, verify } from "hono/jwt";
import type { CoreEnv, CoreJwtPayload, CoreUser } from "./types.ts";

/** JWT 中间件的配置。 */
export interface JwtAuthOptions {
  /**
   * 验签密钥（HS256 对称密钥）。
   *
   * 不传或空串 = 只解不验：能读出 payload，但 uid 未经验签、任何人伪造得出来，
   * 只能拿去记日志，不能拿来授权。现在还没登录，就是这个状态。
   */
  secret?: string;
}

/** 从 `Authorization: Bearer <token>` 里取出 token。取不到返回 undefined。 */
function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

/** 取 payload 里第一个非空字符串字段。 */
function firstString(payload: CoreJwtPayload, key: string): string | undefined {
  const value = payload[key];
  if (typeof value !== "string" || value === "") {
    return undefined;
  }
  return value;
}

/**
 * 解 token。
 *
 * 返回 user 表示解出来了；返回 error 表示没解出来（原因写进日志）。
 * 两种情况都不拦请求——拦不拦是鉴权的事，那是 core 之外的守卫。
 */
async function resolveUser(
  token: string,
  secret: string | undefined,
): Promise<{ user?: CoreUser; error?: string }> {
  let payload: CoreJwtPayload;
  let verified = false;

  if (secret !== undefined && secret !== "") {
    try {
      // 第三个参数必填：hono/jwt 的 verify 不给 alg 会直接抛 JwtAlgorithmRequired
      payload = await verify(token, secret, { alg: "HS256" });
      verified = true;
    } catch (error) {
      return { error: error instanceof Error ? error.message : "token 验签失败" };
    }
  } else {
    try {
      // 畸形 token 会抛 JwtTokenInvalid，不能让它把请求打挂
      payload = decode(token).payload;
    } catch (error) {
      return { error: error instanceof Error ? error.message : "token 解不开" };
    }
  }

  // uid 是约定的用户 id 字段；没有就退到 JWT 标准的 sub
  const uid = firstString(payload, "uid") ?? firstString(payload, "sub");
  if (uid === undefined) {
    return { error: "token 里没有 uid" };
  }

  return { user: { uid, verified, payload } };
}

/**
 * JWT 中间件：把 `Authorization: Bearer <token>` 解成用户上下文。
 *
 * 解出来就 `c.set("user", …)`，解不出来只记原因，不拦请求——
 * 现在整个服务还没有登录，拦了等于谁也用不了。
 */
export function jwtAuth(options: JwtAuthOptions = {}): MiddlewareHandler<CoreEnv> {
  return async (c, next) => {
    const token = bearerToken(c.req.header("authorization"));

    if (token !== undefined) {
      const resolved = await resolveUser(token, options.secret);
      if (resolved.user !== undefined) {
        c.set("user", resolved.user);
      } else {
        c.set("authError", resolved.error);
      }
    }

    await next();
  };
}
