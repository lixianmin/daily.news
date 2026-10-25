import { createApi } from "@needle/honox";
import { todayInShanghai } from "../config.ts";
import type { Scheduler } from "../scheduler.ts";
import type { Store } from "../store.ts";
import { APP_VERSION } from "../version.ts";

/**
 * 探活。
 *
 * 一行日志都不写——这正是「请求日志交给业务决定」要的效果：探活再怎么
 * 频繁也不会有日志噪音。库只补 500 / 慢请求。
 */
export function createHealthApi(store: Store, scheduler: Scheduler) {
  const api = createApi("api/health");

  api.get("/health", async (ctx) => {
    const index = await store.readIndex();
    return ctx.json({
      ok: true,
      version: APP_VERSION,
      days: index.days.length,
      latest: index.days[0]?.date ?? null,
      running: scheduler.isRunning(),
      today: todayInShanghai(),
    });
  });

  return api;
}
