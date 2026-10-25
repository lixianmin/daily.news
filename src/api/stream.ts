import { createApi } from "@needle/honox";
import type { Scheduler } from "../scheduler.ts";
import type { ProgressEvent } from "../types.ts";

/** SSE 心跳间隔。代理与浏览器会掐掉长时间静默的连接。 */
const SSE_HEARTBEAT_MS = 15_000;

/**
 * 生成进度流。
 *
 * 新连接先补齐最近的事件（`live: false`），页面不必等下一步才知道在干什么；
 * 之后推送的都是实时事件。客户端只对 `live: true` 的 `done` 触发刷新——
 * 把重放的历史 `done` 当成实时的就会 `location.reload()` → 重连 → 再重放，
 * 页面不停自我刷新。
 */
export function createStreamApi(scheduler: Scheduler) {
  const api = createApi("api/stream");

  api.get("/api/stream", (ctx) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        let closed = false;

        const push = (event: ProgressEvent, live: boolean): void => {
          if (closed) {
            return;
          }
          try {
            const payload = { ...event, live };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
          } catch {
            closed = true;
          }
        };

        // 这些是历史快照（live=false），不能触发客户端的刷新动作
        push({ stage: "fetch", message: "已连接", at: new Date().toISOString() }, false);
        for (const event of scheduler.recentEvents()) {
          push(event, false);
        }

        const unsubscribe = scheduler.subscribe((event) => push(event, true));
        const heartbeat = setInterval(() => {
          if (closed) {
            return;
          }
          try {
            controller.enqueue(encoder.encode(": ping\n\n"));
          } catch {
            closed = true;
          }
        }, SSE_HEARTBEAT_MS);

        const cleanup = (): void => {
          if (closed) {
            return;
          }
          closed = true;
          clearInterval(heartbeat);
          unsubscribe();
          try {
            controller.close();
          } catch {
            // 已经关了
          }
        };

        ctx.req.raw.signal.addEventListener("abort", cleanup);
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

  return api;
}
