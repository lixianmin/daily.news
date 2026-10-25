import { createApi } from "@needle/honox";
import { ResponseX } from "@needle/shell";
import { renderSearchHits } from "../render.ts";
import type { Store } from "../store.ts";

/** 搜索上限。超过 200 条没人会翻，只白白把响应撑大。 */
const MAX_SEARCH_LIMIT = 200;

/** 只读接口：日期索引、某天原文、跨天搜索。 */
export function createDaysApi(store: Store) {
  const api = createApi("api/days");

  api.get("/api/days", async (ctx) => {
    const index = await store.readIndex();
    return ctx.json(index);
  });

  api.get("/api/day/:date", async (ctx) => {
    const day = await store.readDay(ctx.req.param("date"));
    if (day === null) {
      return ResponseX.notFound("没有这一天的数据");
    }
    return ctx.json(day);
  });

  /**
   * `limit` 不套 schema 校验：非数字就当没传（回到默认值），
   * 这是刻意的宽容——搜索框不该因为多带一个参数就 400。
   */
  api.get("/api/search", async (ctx) => {
    const query = ctx.req.query("q") ?? "";
    const limitRaw = Number(ctx.req.query("limit") ?? "");
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, MAX_SEARCH_LIMIT) : undefined;
    const hits = await store.search(query, limit);
    return ctx.json({ query, hits });
  });

  /** 服务端渲染的搜索结果片段，给不支持脚本的场景兜底。 */
  api.get("/api/search.html", async (ctx) => {
    const hits = await store.search(ctx.req.query("q") ?? "");
    return ctx.html(renderSearchHits(hits));
  });

  return api;
}
