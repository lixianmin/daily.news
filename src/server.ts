import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { createConsole } from "@needle/logo/console";
import {
  CONSOLE_PASSWORD,
  CONSOLE_SECRET,
  CONSOLE_USER,
  PORT,
  HOSTNAME,
  todayInShanghai,
} from "./config.ts";
import { generateDay, type GenerateDayResult } from "./generator.ts";
import { log, logFiles } from "./log.ts";
import { renderDayPage, renderIndexPage, renderSearchHits } from "./render.ts";
import { createScheduler, type Scheduler } from "./scheduler.ts";
import { createStore, type Store } from "./store.ts";
import { createTranslator } from "./translator.ts";
import { flushLogs } from "./log.ts";
import type { ProgressEvent, SourceKey } from "./types.ts";
import { SOURCE_KEYS } from "./types.ts";

const SERVER_VERSION = "0.1.0";

/** SSE 心跳间隔。代理与浏览器会掐掉长时间静默的连接。 */
const SSE_HEARTBEAT_MS = 15_000;

export interface ServerHandle {
  port: number;
  scheduler: Scheduler;
  close: () => Promise<void>;
}

export interface ServerOptions {
  store?: Store;
  port?: number;
  hostname?: string;
  /** 跳过启动自检（测试用）。 */
  skipStartupCheck?: boolean;
  /** 替换真实生成函数（测试用）。不传则跑真实抓取 + 模型调用。 */
  generate?: (date: string, onProgress: (event: ProgressEvent) => void) => Promise<boolean>;
}

/** 控制台前缀判定。`/console` 与 `/console/...` 都算，`/consolefoo` 不算。 */
function isConsolePath(pathname: string): boolean {
  return pathname === "/console" || pathname.startsWith("/console/");
}

/** 回环地址判定。写操作只放行本机。 */
function isLoopback(address: string): boolean {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1" ||
    address.startsWith("127.")
  );
}

function jsonError(message: string, status: 400 | 403 | 404 | 500): Response {
  return Response.json({ error: message }, { status });
}

export async function createServer(options: ServerOptions = {}): Promise<ServerHandle> {
  const store = options.store ?? createStore({ dataDir: (await import("./config.ts")).DATA_DIR });
  const translator = createTranslator();
  const logger = log();

  // --- 调度器 ---
  const scheduler = createScheduler({
    hasDay: async (date) => (await store.readDay(date)) !== null,
    today: () => todayInShanghai(),
    generate:
      options.generate ??
      (async (date, onProgress) => {
        const result: GenerateDayResult = await generateDay({ date, store, translator, onProgress });
        return result.ok;
      }),
  });

  const app = new Hono();

  // --- 页面 ---
  app.get("/", async (c) => {
    const index = await store.readIndex();
    return c.html(renderIndexPage(index));
  });

  app.get("/d/:date", async (c) => {
    const date = c.req.param("date");
    const day = await store.readDay(date);
    if (day === null) return c.html(renderNotFound(date), 404);

    // 前后日导航
    const dates = await store.listDates();
    const at = dates.indexOf(date);
    const newer = at > 0 ? dates[at - 1] : undefined;
    const older = at >= 0 && at < dates.length - 1 ? dates[at + 1] : undefined;

    return c.html(renderDayPage(day, { newer, older }));
  });

  app.get("/app.js", async (c) => {
    try {
      const js = await readFile(join(import.meta.dir, "..", "public", "app.js"), "utf8");
      return c.body(js, 200, { "content-type": "application/javascript; charset=utf-8" });
    } catch {
      return c.body("// app.js missing", 404, { "content-type": "application/javascript" });
    }
  });

  // --- API ---
  app.get("/api/days", async (c) => {
    const index = await store.readIndex();
    return c.json(index);
  });

  app.get("/api/day/:date", async (c) => {
    const day = await store.readDay(c.req.param("date"));
    if (day === null) return jsonError("没有这一天的数据", 404);
    return c.json(day);
  });

  app.get("/api/search", async (c) => {
    const query = c.req.query("q") ?? "";
    const limitRaw = Number(c.req.query("limit") ?? "");
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : undefined;
    const hits = await store.search(query, limit);
    return c.json({ query, hits });
  });

  app.post("/api/regenerate", async (c) => {
    // 本机限制在 fetch 层做了（见下方 Bun.serve），这里只管参数
    const body = await c.req.json().catch(() => ({}));
    const requested = typeof body?.date === "string" && body.date !== "" ? body.date : todayInShanghai();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(requested)) return jsonError("日期格式应为 YYYY-MM-DD", 400);

    const result = await scheduler.regenerate(requested);
    if (!result.started) return c.json({ started: false, reason: result.reason }, 409);
    logger.info("regenerate accepted", { date: requested });
    return c.json({ started: true, date: requested });
  });

  // --- SSE：生成进度 ---
  app.get("/api/stream", (c) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        let closed = false;

        const push = (event: ProgressEvent): void => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          } catch {
            closed = true;
          }
        };

        // 新连接先补齐最近的事件，页面不必等下一步才知道在干什么
        push({ stage: "fetch", message: "已连接", at: new Date().toISOString() });
        for (const event of scheduler.recentEvents()) push(event);

        const unsubscribe = scheduler.subscribe(push);
        const heartbeat = setInterval(() => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(": ping\n\n"));
          } catch {
            closed = true;
          }
        }, SSE_HEARTBEAT_MS);

        const cleanup = (): void => {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          unsubscribe();
          try {
            controller.close();
          } catch {
            // 已经关了
          }
        };

        c.req.raw.signal.addEventListener("abort", cleanup);
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        // 关掉 nginx 之类反向代理的缓冲，SSE 才能实时
        "x-accel-buffering": "no",
      },
    });
  });

  app.get("/health", async (c) => {
    const index = await store.readIndex();
    return c.json({
      ok: true,
      version: SERVER_VERSION,
      days: index.days.length,
      latest: index.days[0]?.date ?? null,
      running: scheduler.isRunning(),
      today: todayInShanghai(),
    });
  });

  app.get("/api/search.html", async (c) => {
    const hits = await store.search(c.req.query("q") ?? "");
    return c.html(renderSearchHits(hits));
  });

  // --- 调试控制台 ---
  const consoleUser = CONSOLE_USER;
  const consolePassword = CONSOLE_PASSWORD;
  const configured = consoleUser !== "" && consolePassword !== "";
  if (!configured) {
    logger.warn("console credentials missing: /console will reject all logins", {
      hint: "在 .env 里设置 CONSOLE_USER / CONSOLE_PASSWORD / CONSOLE_SECRET",
    });
  }

  const debug = createConsole({
    logger,
    title: "daily.news",
    version: SERVER_VERSION,
    basePath: "/console",
    logFiles: logFiles(),
    auth: {
      users: configured ? { [consoleUser]: consolePassword } : {},
      ...(CONSOLE_SECRET === "" ? {} : { secret: CONSOLE_SECRET }),
    },
    commands: [
      {
        name: "days",
        note: "列出已生成的日期与来源完整度",
        run: async () => {
          const index = await store.readIndex();
          return {
            kind: "table" as const,
            columns: ["日期", "星期", "总条数", "来源", "生成时间"],
            rows: index.days.slice(0, 30).map((day) => [
              day.date,
              day.weekday,
              String(day.total),
              `${day.sourcesOk}/${SOURCE_KEYS.length}`,
              day.generatedAt.replace("T", " ").slice(0, 19),
            ]),
          };
        },
      },
      {
        name: "regen",
        note: "重新生成某天（省略日期 = 今天）",
        args: "[yyyy-mm-dd]",
        run: async ({ args }) => {
          const date = args[0] ?? todayInShanghai();
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            throw new Error("日期格式应为 YYYY-MM-DD");
          }
          const result = await scheduler.regenerate(date);
          return {
            kind: "text" as const,
            text: result.started ? `已开始重新生成 ${date}，进度见日志流` : `未启动：${result.reason ?? "未知"}`,
          };
        },
      },
      {
        name: "today",
        note: "今天的状态：生成到哪一步、有没有成品",
        run: async () => {
          const date = todayInShanghai();
          const day = await store.readDay(date);
          const running = scheduler.isRunning();
          const last = scheduler.recentEvents().at(-1);

          if (day !== null) {
            return {
              kind: "text" as const,
              text: `${date} 已生成 · ${day.sections.length} 章节 · 模型 ${day.model}${running ? " · 正在重新生成中" : ""}`,
            };
          }
          if (running) {
            return {
              kind: "text" as const,
              text: `${date} 生成中${last === undefined ? "" : ` · ${last.message}`}`,
            };
          }
          return { kind: "text" as const, text: `${date} 还没有成品，也没在跑。执行 regen 触发一次。` };
        },
      },
    ],
  });

  // 控制台挂两条：`/console` 与 `/console/*`（结尾有没有斜杠都要能进）
  app.all("/console", (c) => debug.handler(c.req.raw));
  app.all("/console/*", (c) => debug.handler(c.req.raw));

  app.notFound((c) => jsonError(`没有这个路径：${new URL(c.req.url).pathname}`, 404));

  // --- 启动 ---
  //
  // 用 Bun.serve 而不是 needle 的 node serve：只有它能通过 `server.requestIP()`
  // 拿到真实连接地址。写操作限本机靠这个判断，不能靠可伪造的 Host / Origin 头。
  const hostname = options.hostname ?? HOSTNAME;
  const port = options.port ?? PORT;

  const bunServer = Bun.serve({
    port,
    hostname,
    fetch(request, srv) {
      const { pathname } = new URL(request.url);

      if (isConsolePath(pathname)) return debug.handler(request);

      // 会烧 LLM 额度的写操作只允许本机触发
      if (request.method === "POST" && pathname === "/api/regenerate") {
        const address = srv.requestIP(request)?.address ?? "";
        if (!isLoopback(address)) {
          logger.warn("regenerate rejected: not local", { address });
          return jsonError("只允许本机触发重新生成", 403);
        }
      }

      return app.fetch(request);
    },
  });

  if (options.skipStartupCheck !== true) {
    void scheduler.checkOnStart();
    scheduler.start();
  }

  logger.info("server listening", {
    url: `http://127.0.0.1:${bunServer.port}`,
    console: `http://127.0.0.1:${bunServer.port}/console`,
    hostname,
  });

  return {
    port: bunServer.port ?? port,
    scheduler,
    close: async () => {
      scheduler.stop();
      debug.dispose();
      await bunServer.stop();
    },
  };
}

function renderNotFound(date: string): string {
  return `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>没有这一天</title></head>
<body style="font:16px/1.6 -apple-system,sans-serif;max-width:640px;margin:60px auto;padding:0 16px">
<h1>没有 ${date} 的数据</h1>
<p><a href="/">← 返回列表</a></p>
</body></html>`;
}

if (import.meta.main) {
  const handle = await createServer();
  const shutdown = async (signal: string): Promise<void> => {
    log().info("shutting down", { signal });
    // 先把缓冲区冲掉再退出，否则最后一批 info 日志会丢
    flushLogs();
    await handle.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

export type { SourceKey };
