import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type ServerHandle } from "../src/server.ts";
import { createStore, type Store } from "../src/store.ts";
import type { DigestDay } from "../src/types.ts";
import { TEST_QUEUE_PATH } from "./helpers/queue.ts";

/** 测试里读 JSON 的出口。Response.json() 返回 unknown，这里统一收窄。 */
function jsonOf(response: Response): Promise<any> {
  return response.json() as Promise<any>;
}

let dataDir: string;
let store: Store;
let server: ServerHandle;
let base: string;

function day(date: string): DigestDay {
  return {
    date,
    weekday: "星期五",
    generatedAt: `${date}T07:00:00+08:00`,
    model: "deepseek/deepseek-flash",
    sources: {
      github: { ok: true, count: 1 },
      zhihu: { ok: false, count: 0, error: "抓取失败" },
    },
    sections: [
      {
        key: "github",
        title: "GitHub Trending（今日趨勢）",
        kind: "items",
        items: [{ title: "owner/repo", url: "https://github.com/owner/repo", en: "A fast CLI for X.", zh: "" }],
      },
    ],
  };
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "daily-news-server-"));
  store = createStore({ dataDir });
  await store.writeDay(day("2026-10-23"));
  await store.writeDay(day("2026-10-22"));

  server = await createServer({
    store,
    port: 0,
    hostname: "127.0.0.1",
    skipStartupCheck: true,
    // bunqueue 内嵌模式是每进程一个 manager，路径必须全局一致
    queuePath: TEST_QUEUE_PATH,
    // 测试里绝不跑真实抓取与模型调用
    generate: async () => true,
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  await server.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("页面路由", () => {
  it("首页 200 且列出日期", async () => {
    const response = await fetch(`${base}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("2026-10-23");
    expect(html).toContain("2026-10-22");
  });

  it("详情页 200 且含内容", async () => {
    const response = await fetch(`${base}/d/2026-10-23`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("A fast CLI for X.");
  });

  it("不存在的日期 404", async () => {
    const response = await fetch(`${base}/d/1999-01-01`);
    expect(response.status).toBe(404);
  });

  it("app.js 可访问", async () => {
    const response = await fetch(`${base}/app.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("javascript");
  });
});

describe("API 路由", () => {
  it("/api/days 返回索引", async () => {
    const response = await fetch(`${base}/api/days`);
    expect(response.status).toBe(200);
    const payload = await jsonOf(response);
    expect(payload.days.map((d: { date: string }) => d.date)).toEqual(["2026-10-23", "2026-10-22"]);
  });

  it("/api/day/:date 返回整天 JSON", async () => {
    const response = await fetch(`${base}/api/day/2026-10-23`);
    expect(response.status).toBe(200);
    const payload = await jsonOf(response);
    expect(payload.model).toBe("deepseek/deepseek-flash");
    expect(payload.sections).toHaveLength(1);
  });

  it("/api/day/:date 不存在时 404 + not_found 信封", async () => {
    const response = await fetch(`${base}/api/day/1999-01-01`);
    expect(response.status).toBe(404);
    const payload = await jsonOf(response);
    expect(payload.code).toBe("not_found");
    expect(payload.message).toBeTruthy();
  });

  it("/api/search 能搜到", async () => {
    const response = await fetch(`${base}/api/search?q=${encodeURIComponent("CLI")}`);
    expect(response.status).toBe(200);
    const payload = await jsonOf(response);
    expect(payload.hits.length).toBeGreaterThan(0);
  });

  it("/api/search 空查询返回空数组", async () => {
    const response = await fetch(`${base}/api/search?q=`);
    const payload = await jsonOf(response);
    expect(payload.hits).toEqual([]);
  });

  it("/health 报告状态", async () => {
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    const payload = await jsonOf(response);
    expect(payload.ok).toBe(true);
    expect(payload.days).toBe(2);
    expect(payload.running).toBe(false);
  });

  it("未知路径 404 JSON", async () => {
    const response = await fetch(`${base}/nope`);
    expect(response.status).toBe(404);
    const payload = await jsonOf(response);
    expect(payload.code).toBe("not_found");
    expect(payload.message).toContain("/nope");
  });
});

describe("POST /api/regenerate", () => {
  it("本机触发返回 started:true", async () => {
    const response = await fetch(`${base}/api/regenerate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ date: "2026-10-23" }),
    });
    expect(response.status).toBe(200);
    const payload = await jsonOf(response);
    expect(payload.started).toBe(true);
    expect(payload.date).toBe("2026-10-23");
  });

  it("日期格式非法返回 400", async () => {
    const response = await fetch(`${base}/api/regenerate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ date: "2026/10/23" }),
    });
    expect(response.status).toBe(400);
    const payload = await jsonOf(response);
    expect(payload.code).toBe("bad_request");
    expect(payload.message).toContain("YYYY-MM-DD");
  });

  it("省略日期时默认今天", async () => {
    const response = await fetch(`${base}/api/regenerate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(200);
    const payload = await jsonOf(response);
    expect(payload.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("SSE 进度流", () => {
  it("/api/stream 返回 event-stream 且立刻推一条", async () => {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/stream`, { signal: controller.signal });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const { value } = await reader!.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain("data:");

    controller.abort();
  });
});

describe("控制台", () => {
  it("/console 返回登录页 HTML", async () => {
    const response = await fetch(`${base}/console`);
    expect(response.status).toBe(200);
    const html = await response.text();
    // 页面里有控制台的输入框或脚本
    expect(html.length).toBeGreaterThan(200);
  });

  it("未登录执行命令被拒（401）", async () => {
    const response = await fetch(`${base}/console/exec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ line: "top" }),
    });
    expect(response.status).toBe(401);
  });

  it("未登录拉日志流被拒", async () => {
    const response = await fetch(`${base}/console/events`);
    expect(response.status).toBe(401);
  });
});
