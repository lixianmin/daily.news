import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type ServerHandle } from "../src/main.ts";
import { createStore, type Store } from "../src/store.ts";
import type { CommandResult, DisplayControl } from "../src/display.ts";
import { TEST_QUEUE_PATH } from "./helpers/queue.ts";

/** 测试里读 JSON 的出口。Response.json() 返回 unknown，这里统一收窄。 */
function jsonOf(response: Response): Promise<any> {
  return response.json() as Promise<any>;
}

/** 假显示器：只记调用，不碰真机器。 */
function fakeDisplay(result?: Partial<CommandResult>) {
  const calls: string[] = [];
  const display: DisplayControl = {
    sleepDisplay: async () => {
      calls.push("sleep");
      return { ok: true, code: 0, stderr: "", ...result };
    },
    wakeDisplay: async () => {
      calls.push("wake");
      return { ok: true, code: 0, stderr: "", ...result };
    },
  };
  return { calls, display };
}

let dataDir: string;
let store: Store;
let server: ServerHandle;
let base: string;
let display: ReturnType<typeof fakeDisplay>;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "daily-news-remote-"));
  store = createStore({ dataDir });
  display = fakeDisplay();

  server = await createServer({
    store,
    port: 0,
    hostname: "127.0.0.1",
    skipStartupCheck: true,
    queuePath: TEST_QUEUE_PATH,
    generate: async () => true,
    display: display.display,
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  await server.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("Remote Control 页面", () => {
  it("页面 200 且有两个按钮", async () => {
    const response = await fetch(`${base}/remote`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("Remote Control");
    expect(html).toContain("id=\"remoteWake\"");
    expect(html).toContain("id=\"remoteSleep\"");
  });

  it("remote.js 能编译（纯 JS 不参与 tsc）", async () => {
    const source = await readFile(join(import.meta.dir, "..", "public", "remote.js"), "utf8");
    expect(() => new Function(source)).not.toThrow();
  });
});

describe("Remote Control 接口", () => {
  it("唤醒屏幕", async () => {
    const response = await fetch(`${base}/api/remote/wake`, { method: "POST" });
    expect(response.status).toBe(200);
    expect(await jsonOf(response)).toEqual({ ok: true, action: "wake" });
    expect(display.calls).toEqual(["wake"]);
  });

  it("关闭屏幕", async () => {
    const response = await fetch(`${base}/api/remote/sleep`, { method: "POST" });
    expect(response.status).toBe(200);
    expect(await jsonOf(response)).toEqual({ ok: true, action: "sleep" });
    expect(display.calls).toEqual(["sleep"]);
  });

  it("命令失败时返回 500 与错误码", async () => {
    await server.close();
    const failed = fakeDisplay({ ok: false, code: 1, stderr: "boom" });
    server = await createServer({
      store,
      port: 0,
      hostname: "127.0.0.1",
      skipStartupCheck: true,
      queuePath: TEST_QUEUE_PATH,
      generate: async () => true,
      display: failed.display,
    });
    base = `http://127.0.0.1:${server.port}`;

    const response = await fetch(`${base}/api/remote/sleep`, { method: "POST" });
    expect(response.status).toBe(500);
    const payload = await jsonOf(response);
    expect(payload.code).toBe("internal_error");
    expect(String(payload.message)).toContain("boom");
  });
});
