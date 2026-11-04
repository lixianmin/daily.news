import { createApi, traceOf } from "@needle/honox";
import type { DisplayControl } from "../display.ts";
import { renderRemotePage } from "../render.ts";

/**
 * Remote Control：远程开关显示器。
 *
 * 只管显示器，不管主机睡不睡——需求里划的边界。命令怎么拼在 `src/display.ts`，
 * 这里只做 HTTP：把结果翻译成响应，并把每一次开关都记进日志
 * （谁在什么时候关了屏幕，要查得到）。
 */
export function createRemoteApi(display: DisplayControl) {
  const api = createApi("api/remote.ts");

  api.get("/remote", async (ctx) => {
    return ctx.html(renderRemotePage());
  });

  api.post("/api/remote/wake", async (ctx) => {
    const trace = traceOf(ctx).info({ action: "wake" });
    const result = await display.wakeDisplay();
    if (!result.ok) {
      trace.warn({ action: "wake", ok: false, code: result.code, stderr: result.stderr });
      return trace.internalError(`唤醒屏幕失败：${result.stderr}`);
    }
    return trace.json({ ok: true, action: "wake" });
  });

  api.post("/api/remote/sleep", async (ctx) => {
    const trace = traceOf(ctx).info({ action: "sleep" });
    const result = await display.sleepDisplay();
    if (!result.ok) {
      trace.warn({ action: "sleep", ok: false, code: result.code, stderr: result.stderr });
      return trace.internalError(`关闭屏幕失败：${result.stderr}`);
    }
    return trace.json({ ok: true, action: "sleep" });
  });

  return api;
}
