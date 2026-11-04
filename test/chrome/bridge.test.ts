import { describe, expect, it } from "bun:test";
import { ChromeBridge } from "../../src/chrome/bridge.ts";
import type { BridgeCommand } from "../../src/chrome/protocol.ts";

/**
 * 桥（127.0.0.1:17318）的两种角色。
 *
 * 真实环境里端口被 Chrome 伴侣扩展写死，服务与 pi session 抢同一个端口：
 * 先起的当 owner（server），后起的当 client（转发给 owner）。
 * 这里用假扩展顶替 Chrome：长轮询 `/next` 取命令，做完 `POST /result` 回结果。
 */

interface FakeExtension {
  stop: () => void;
  commands: BridgeCommand[];
}

/** 起一个假扩展。handler 返回命令的结果。 */
function startFakeExtension(baseUrl: string, handler: (command: BridgeCommand) => unknown): FakeExtension {
  const commands: BridgeCommand[] = [];
  let stopped = false;
  const loop = async (): Promise<void> => {
    while (!stopped) {
      try {
        const response = await fetch(`${baseUrl}/next?name=fake-extension`, { cache: "no-store" });
        const payload = (await response.json()) as { type?: string; command?: BridgeCommand };
        if (payload.type === "command" && payload.command !== undefined) {
          commands.push(payload.command);
          let result: unknown;
          let ok = true;
          let error: string | undefined;
          try {
            result = handler(payload.command);
          } catch (caught) {
            ok = false;
            error = (caught as Error).message;
          }
          await fetch(`${baseUrl}/result`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: payload.command.id, ok, result, error }),
          });
        }
      } catch {
        await sleep(20);
      }
    }
  };
  void loop();
  return {
    stop: () => {
      stopped = true;
    },
    commands,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("ChromeBridge owner 模式", () => {
  it("自己占端口，命令往返扩展", async () => {
    const bridge = await ChromeBridge.connect({ port: 0 });
    expect(bridge.role).toBe("server");

    const extension = startFakeExtension(bridge.url, (command) => {
      if (command.action === "page.evaluate") {
        return { value: 42 };
      }
      return { ok: true };
    });

    try {
      const result = await bridge.send("page.evaluate", { expression: "1+1" }, 10_000);
      expect(result).toEqual({ value: 42 });
      expect(extension.commands[0]?.action).toBe("page.evaluate");
      expect(extension.commands[0]?.params).toEqual({ expression: "1+1" });
    } finally {
      extension.stop();
      await bridge.stop();
    }
  });

  it("扩展在轮询时 status.connected 为 true", async () => {
    const bridge = await ChromeBridge.connect({ port: 0 });
    const extension = startFakeExtension(bridge.url, () => ({ ok: true }));
    try {
      await sleep(200);
      const status = await bridge.status();
      expect(status.connected).toBe(true);
      expect(status.mode).toBe("server");
      expect(status.clientName).toBe("fake-extension");
    } finally {
      extension.stop();
      await bridge.stop();
    }
  });

  it("没人轮询时命令超时并给出可读原因", async () => {
    const bridge = await ChromeBridge.connect({ port: 0 });
    try {
      const promise = bridge.send("page.evaluate", { expression: "1" }, 300);
      await expect(promise).rejects.toThrow(/没有在轮询|没及时取走/);
    } finally {
      await bridge.stop();
    }
  });

  it("扩展回错时命令抛出扩展给的错误", async () => {
    const bridge = await ChromeBridge.connect({ port: 0 });
    const extension = startFakeExtension(bridge.url, () => {
      throw new Error("Unknown action: page.evaluate");
    });
    try {
      await expect(bridge.send("page.evaluate", {}, 5_000)).rejects.toThrow("Unknown action: page.evaluate");
    } finally {
      extension.stop();
      await bridge.stop();
    }
  });

  it("扩展来源的 /next 带上 CORS 头，其它来源被拒", async () => {
    // 短轮询：/next 是长轮询，默认 25s，测试里等不起
    const bridge = await ChromeBridge.connect({ port: 0, pollTimeoutMs: 200 });
    try {
      const allowed = await fetch(`${bridge.url}/next?name=x`, { headers: { origin: "chrome-extension://abc" } });
      expect(allowed.headers.get("access-control-allow-origin")).toBe("chrome-extension://abc");

      const denied = await fetch(`${bridge.url}/next?name=x`, { headers: { origin: "https://evil.example" } });
      expect(denied.status).toBe(403);
    } finally {
      await bridge.stop();
    }
  });

  it("/command 只接受本地进程（带浏览器 origin 的请求被拒）", async () => {
    const bridge = await ChromeBridge.connect({ port: 0 });
    try {
      const denied = await fetch(`${bridge.url}/command`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "chrome-extension://abc" },
        body: JSON.stringify({ action: "tab.list", params: {} }),
      });
      expect(denied.status).toBe(403);
    } finally {
      await bridge.stop();
    }
  });
});

describe("ChromeBridge client 模式", () => {
  it("端口被占时降级成 client，命令转发给 owner", async () => {
    const owner = await ChromeBridge.connect({ port: 0 });
    const extension = startFakeExtension(owner.url, (command) => {
      if (command.action === "tab.list") {
        return [{ id: 1, url: "https://x.com/home" }];
      }
      return { ok: true };
    });

    const client = await ChromeBridge.connect({ port: owner.boundPort });
    try {
      expect(client.role).toBe("client");
      const result = await client.send("tab.list", {}, 10_000);
      expect(result).toEqual([{ id: 1, url: "https://x.com/home" }]);
    } finally {
      extension.stop();
      await client.stop();
      await owner.stop();
    }
  });

  it("client 的 status 问 owner 要", async () => {
    const owner = await ChromeBridge.connect({ port: 0 });
    const extension = startFakeExtension(owner.url, () => ({ ok: true }));
    const client = await ChromeBridge.connect({ port: owner.boundPort });
    try {
      await sleep(200);
      const status = await client.status();
      expect(status.mode).toBe("server"); // owner 自己报的是 server
      expect(status.connected).toBe(true);
    } finally {
      extension.stop();
      await client.stop();
      await owner.stop();
    }
  });
});
