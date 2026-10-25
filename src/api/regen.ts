import { createApi, traceOf } from "@needle/honox";
import { ResponseX } from "@needle/shell";
import { RegenBody } from "../beans/regen.ts";
import { todayInShanghai } from "../config.ts";
import type { Scheduler } from "../scheduler.ts";

/** 日期形状。与数据目录的文件名一致：`days/<date>.json`。 */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 唯一的写接口：触发某天重新生成。 */
export function createRegenApi(scheduler: Scheduler) {
  const api = createApi("api/regen");

  api.post("/api/regenerate", RegenBody, async (ctx, request) => {
    // 一行同时建 trace + 记请求体；后面每个出口都用 trace 记一行
    const trace = traceOf(ctx).info(request);

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
