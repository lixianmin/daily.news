import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createApi } from "@needle/honox";
import { todayInShanghai } from "../config.ts";
import { renderDayPage, renderIndexPage, escapeHtml } from "../render.ts";
import type { Store } from "../store.ts";

/** 页面路由：列表页、详情页、前端脚本。 */
export function createPagesApi(store: Store) {
  const api = createApi("api/pages");

  api.get("/", async (ctx) => {
    const index = await store.readIndex();
    return ctx.html(renderIndexPage(index, todayInShanghai()));
  });

  api.get("/d/:date", async (ctx) => {
    const date = ctx.req.param("date");
    const day = await store.readDay(date);
    if (day === null) {
      return ctx.html(renderNotFound(date), 404);
    }

    // 前后日导航 + 侧边栏的历史列表
    const index = await store.readIndex();
    const dates = index.days.map((entry) => entry.date);
    const at = dates.indexOf(date);
    const newer = at > 0 ? dates[at - 1] : undefined;
    const older = at >= 0 && at < dates.length - 1 ? dates[at + 1] : undefined;

    return ctx.html(renderDayPage(day, { newer, older }, index.days, todayInShanghai()));
  });

  api.get("/app.js", async (ctx) => {
    try {
      const js = await readFile(join(import.meta.dir, "..", "..", "public", "app.js"), "utf8");
      return ctx.body(js, 200, { "content-type": "application/javascript; charset=utf-8" });
    } catch {
      return ctx.body("// app.js missing", 404, { "content-type": "application/javascript" });
    }
  });

  // favicon：svg 优先（见 layout 里的 link 声明），png 兜底不支持 svg 的浏览器；
  // apple-touch-icon 给 iOS 添加到主屏幕用
  for (const [file, type] of [
    ["favicon.svg", "image/svg+xml"],
    ["favicon.png", "image/png"],
    ["apple-touch-icon.png", "image/png"],
  ] as const) {
    api.get(`/${file}`, async (ctx) => {
      try {
        const bytes = await readFile(join(import.meta.dir, "..", "..", "public", file));
        return ctx.body(bytes, 200, { "content-type": type });
      } catch {
        return ctx.body(null, 404);
      }
    });
  }

  return api;
}

function renderNotFound(date: string): string {
  // date 是 URL 段，原样拼进 HTML 就是一个反射型 XSS：/d/<script> 能执行。
  // 这个函数从 server.ts 搬过来时补上转义（内容一律当不可信文本）。
  return `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>没有这一天</title></head>
<body style="font:16px/1.6 -apple-system,sans-serif;max-width:640px;margin:60px auto;padding:0 16px">
<h1>没有 ${escapeHtml(date)} 的数据</h1>
<p><a href="/">← 返回列表</a></p>
</body></html>`;
}
