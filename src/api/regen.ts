import { getConnInfo } from "@hono/bun";
import { createApi, traceOf } from "@needle/honox";
import { ResponseX } from "@needle/shell";
import { RegenBody } from "../beans/regen.ts";
import { todayInShanghai } from "../config.ts";
import type { Scheduler } from "../scheduler.ts";

/** 日期形状。与数据目录的文件名一致：`days/<date>.json`。 */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 回环地址判定。写操作只放行本机。 */
function isLoopback(address: string): boolean {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1" ||
    address.startsWith("127.")
  );
}

/**
 * 判断请求是否来自本机。
 *
 * 用 `getConnInfo` 拿真实 socket 地址——不能靠 Host / Origin 头，那些可伪造。
 */
function isLocalRequest(ctx: { req: { raw: Request } }): boolean {
  try {
    const address = getConnInfo(ctx as never).remote.address ?? "";
    return isLoopback(address);
  } catch {
    // 拿不到连接信息时按不安全处理
    return false;
  }
}

/** 唯一的写接口：触发某天重新生成。 */
export function createRegenApi(scheduler: Scheduler) {
  const api = createApi("api/regen");

  api.post("/api/regenerate", RegenBody, async (ctx, request) => {
    // 一行同时建 trace + 记请求体；后面每个出口都用 trace 记一行
    const trace = traceOf(ctx).info(request);

    // 会烧 LLM 额度的写操作只允许本机触发（局域网手机只读）
    if (!isLocalRequest(ctx)) {
      trace.warn({ step: "reject", reason: "not local" });
      return ResponseX.fail(403, "forbidden", "只允许本机触发重新生成");
    }

    const date = request.date ?? todayInShanghai();
    if (!DATE_PATTERN.test(date)) {
      trace.warn({ step: "reject", reason: "bad date", date });
      return ResponseX.badRequest("日期格式应为 YYYY-MM-DD");
    }

    const result = await scheduler.regenerate(date);
    if (!result.started) {
      return trace.json({ started: false, reason: result.reason }, 409);
    }
    return trace.json({ started: true, date });
  });

  return api;
}
