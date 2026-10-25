import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createScheduler } from "../src/scheduler.ts";
import type { ProgressEvent } from "../src/types.ts";
import { TEST_QUEUE_PATH, waitFor } from "./helpers/queue.ts";

/**
 * SSE 的历史重放。
 *
 * 曾经的 bug：新连接建立时服务端把历史事件（含 `done`）原样推给客户端，
 * 客户端一看 `done` 就 `location.reload()` → 新连接又重放 `done` → 死循环。
 * 表现为页面不停自我刷新、进度条一直转圈。
 *
 * 修法：重放的历史事件标 `live: false`，只有实时事件标 `live: true`。
 * 客户端只在 `live === true` 的 `done` 上刷新。
 */

/** 起一个带 SSE 路由的测试服务，路由逻辑与 src/api/stream.ts 保持一致。 */
async function startSseServer(scheduler: ReturnType<typeof createScheduler>) {
  const app = new Hono();

  app.get("/api/stream", (c) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        let closed = false;

        const push = (event: ProgressEvent, live: boolean): void => {
          if (closed) {
            return;
          }
          const payload = live ? { ...event, live: true } : { ...event, live: false };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        };

        push({ stage: "fetch", message: "已连接", at: new Date().toISOString() }, false);
        for (const event of scheduler.recentEvents()) {
          push(event, false);
        }

        const unsubscribe = scheduler.subscribe((event) => push(event, true));
        void unsubscribe;
      },
    });

    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  });

  const server = Bun.serve({ port: 0, fetch: app.fetch });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => void server.stop() };
}

/**
 * 读 SSE 流：读到 n 条事件、或超时为止。
 *
 * read() 本身会阻塞，所以超时必须包在 read 外面——
 * 只在循环里查 deadline 没用，read 不返回就永远出不来。
 */
async function readEvents(url: string, n: number, timeoutMs = 1200): Promise<ProgressEvent[]> {
  const res = await fetch(`${url}/api/stream`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const out: ProgressEvent[] = [];

  const deadline = Date.now() + timeoutMs;
  let buffer = "";

  while (out.length < n) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      break;
    }

    // 用 AbortSignal 给 read 加超时，避免永久阻塞
    const timer = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), remaining),
    );
    const chunk = await Promise.race([reader.read(), timer]);
    if (chunk === null || chunk.done) {
      break;
    }

    buffer += decoder.decode(chunk.value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (!raw.startsWith("data: ")) {
        continue;
      }
      try {
        out.push(JSON.parse(raw.slice(6)) as ProgressEvent);
      } catch {
        // 非 JSON，跳过
      }
    }
  }

  await reader.cancel().catch(() => undefined);
  return out;
}

describe("SSE 历史重放不会触发页面刷新", () => {
  it("新连接重放的 done 事件带 live: false（客户端不会因此刷新）", async () => {
    const scheduler = createScheduler({
      readDay: async () => null,
      today: () => "2026-10-24",
      generate: async () => true,
      dataPath: TEST_QUEUE_PATH,
    });
    await scheduler.start();

    // 先跑一次完成，产出 done 事件进历史
    await scheduler.regenerate("2026-10-24");
    await waitFor(() => scheduler.recentEvents().some((e) => e.stage === "done"));
    expect(scheduler.recentEvents().some((e) => e.stage === "done")).toBe(true);

    const { url, stop } = await startSseServer(scheduler);
    try {
      const events = await readEvents(url, 2);
      const done = events.find((event) => event.stage === "done");

      expect(done).toBeDefined();
      // 关键断言：历史重放必须是 live: false
      expect(done?.live).toBe(false);
    } finally {
      stop();
      await scheduler.stop();
    }
  });

  it("订阅期间产生的 done 是 live: true", async () => {
    const scheduler = createScheduler({
      readDay: async () => null,
      today: () => "2026-10-25",
      generate: async () => true,
      dataPath: TEST_QUEUE_PATH,
    });
    await scheduler.start();

    const { url, stop } = await startSseServer(scheduler);
    try {
      const pending = readEvents(url, 2);
      // 稍等，确保连接已建立
      await new Promise((resolve) => setTimeout(resolve, 50));
      await scheduler.regenerate("2026-10-25");

      const events = await pending;
      const done = events.find((event) => event.stage === "done");
      expect(done).toBeDefined();
      expect(done?.live).toBe(true);
    } finally {
      stop();
      await scheduler.stop();
    }
  });

  it("客户端只在 live 的 done 上刷新，且有防重入护栏", async () => {
    const source = await Bun.file(new URL("../public/app.js", import.meta.url)).text();
    expect(source).toContain('event.stage === "done" && isLive');
    expect(source).toContain("reloading");
    // 历史事件用静态圆点，不用转圈
    expect(source).toContain('class="dot"');
  });


  it("app.js 语法正确（纯 JS，tsc 抓不到语法错）", async () => {
    // 曾经的坑：app.js 里写了 TypeScript 的类型注解（(): void =>），
    // 浏览器直接 SyntaxError，整个脚本不执行——页面看着正常，其实所有交互都死了。
    // app.js 不参与 tsc --noEmit，所以只能自己编译一遍。
    const source = await Bun.file(new URL("../public/app.js", import.meta.url)).text();
    expect(() => new Function(source)).not.toThrow();
  });

  it("app.js 里没有 TypeScript 类型注解", async () => {
    const source = await Bun.file(new URL("../public/app.js", import.meta.url)).text();
    // 纯 JS 文件不该出现这些
    expect(source).not.toMatch(/\)\s*:\s*(void|string|number|boolean)\s*=>/);
  });

  it("showProgress 里 isLive 的声明在使用之前（避免 TDZ ReferenceError）", async () => {
    // 曾经的 bug：`const isLive` 声明在第一次使用之后，触发暂时性死区，
    // showProgress 抛 ReferenceError 又被 catch 吞掉，表现为进度条永远空白。
    const source = await Bun.file(new URL("../public/app.js", import.meta.url)).text();
    const body = source.slice(source.indexOf("function showProgress"));
    const decl = body.indexOf("const isLive");
    const firstUse = body.indexOf("isLive ?");
    expect(decl).toBeGreaterThanOrEqual(0);
    expect(firstUse).toBeGreaterThanOrEqual(0);
    expect(decl).toBeLessThan(firstUse);
  });
});
