import { describe, expect, it } from "bun:test";
import { sign } from "hono/jwt";
import { createHono, newUid, type CoreLogger } from "../src/core/index.ts";

/** 记录日志调用的假 logger。 */
interface LogCall {
  level: "info" | "warn" | "error";
  message: string;
  fields?: Record<string, unknown>;
}

function fakeLogger(): { logger: CoreLogger; calls: LogCall[] } {
  const calls: LogCall[] = [];
  const push =
    (level: LogCall["level"]) =>
    (message: string, fields?: Record<string, unknown>): void => {
      calls.push({ level, message, fields });
    };
  return {
    calls,
    logger: { info: push("info"), warn: push("warn"), error: push("error") },
  };
}

const SECRET = "test-secret";
const UID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

describe("createHono", () => {
  it("返回能起路由的 Hono 实例", async () => {
    const app = createHono();
    app.get("/ping", (c) => c.text("pong"));

    const res = await app.request("/ping");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("pong");
  });
});

describe("请求日志中间件", () => {
  it("请求开始与结束各一条 info，字段尽量全", async () => {
    const { logger, calls } = fakeLogger();
    const app = createHono({ logger });
    app.get("/ping", (c) => c.text("pong"));

    await app.request("/ping?x=1", {
      headers: { "user-agent": "test-agent", "x-forwarded-for": "1.2.3.4" },
    });

    const infos = calls.filter((call) => call.level === "info");
    expect(infos.length).toBe(2);

    const [start, end] = infos;
    expect(start?.message).toBe("request start");
    expect(start?.fields?.["method"]).toBe("GET");
    expect(start?.fields?.["path"]).toBe("/ping");
    expect(start?.fields?.["query"]).toBe("x=1");
    expect(start?.fields?.["url"]).toContain("/ping?x=1");
    expect(start?.fields?.["protocol"]).toBe("http");
    expect(start?.fields?.["host"]).toContain("localhost");
    expect(start?.fields?.["ip"]).toBe("1.2.3.4");
    expect(start?.fields?.["userAgent"]).toBe("test-agent");
    expect(start?.fields?.["hasAuthorization"]).toBe(false);
    expect(typeof start?.fields?.["requestId"]).toBe("string");

    expect(end?.message).toBe("request end");
    expect(end?.fields?.["status"]).toBe(200);
    expect(typeof end?.fields?.["elapsedMs"]).toBe("number");
    // 同一次请求的开始与结束用同一个 requestId
    expect(end?.fields?.["requestId"]).toBe(start?.fields?.["requestId"]);
    // 没有登录时 uid 为空，但字段要在
    expect(end?.fields?.["uid"]).toBeUndefined();
    expect(end?.fields?.["authenticated"]).toBe(false);
  });

  it("token 本身不进日志", async () => {
    const { logger, calls } = fakeLogger();
    const app = createHono({ logger, jwtSecret: SECRET });
    app.get("/ping", (c) => c.text("pong"));

    const token = await sign({ uid: UID }, SECRET);
    await app.request("/ping", { headers: { authorization: `Bearer ${token}` } });

    expect(JSON.stringify(calls)).not.toContain(token);
    const start = calls.find((call) => call.message === "request start");
    expect(start?.fields?.["hasAuthorization"]).toBe(true);
  });

  it("处理函数抛异常时记 error，异常对象带进日志", async () => {
    const { logger, calls } = fakeLogger();
    const app = createHono({ logger });
    app.get("/boom", () => {
      throw new Error("boom");
    });

    const res = await app.request("/boom");

    expect(res.status).toBe(500);
    const failures = calls.filter((call) => call.level === "error");
    expect(failures.length).toBe(1);
    expect(failures[0]?.message).toBe("request failed");
    expect(failures[0]?.fields?.["status"]).toBe(500);
    expect((failures[0]?.fields?.["error"] as Error | undefined)?.message).toBe("boom");
  });

  it("返回 5xx 时补一条 error 日志", async () => {
    const { logger, calls } = fakeLogger();
    const app = createHono({ logger });
    app.get("/bad", (c) => c.text("bad", 500));

    await app.request("/bad");

    const errors = calls.filter((call) => call.level === "error");
    expect(errors.length).toBe(1);
    expect(errors[0]?.message).toBe("request failed");
    expect(errors[0]?.fields?.["status"]).toBe(500);
  });
});

describe("JWT 中间件", () => {
  it("带合法 token 时解出 uid", async () => {
    const { logger } = fakeLogger();
    const app = createHono({ logger, jwtSecret: SECRET });
    app.get("/me", (c) => c.json({ uid: c.get("user")?.uid ?? null }));

    const token = await sign({ uid: UID }, SECRET);
    const res = await app.request("/me", { headers: { authorization: `Bearer ${token}` } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ uid: UID });
  });

  it("没有 token 时匿名放行", async () => {
    const { logger } = fakeLogger();
    const app = createHono({ logger, jwtSecret: SECRET });
    app.get("/me", (c) => c.json({ uid: c.get("user")?.uid ?? null }));

    const res = await app.request("/me");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ uid: null });
  });

  it("token 坏掉时匿名放行，不打挂请求", async () => {
    const { logger, calls } = fakeLogger();
    const app = createHono({ logger, jwtSecret: SECRET });
    app.get("/me", (c) => c.json({ uid: c.get("user")?.uid ?? null }));

    const res = await app.request("/me", { headers: { authorization: "Bearer not-a-jwt" } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ uid: null });
    const end = calls.find((call) => call.message === "request end");
    expect(typeof end?.fields?.["authError"]).toBe("string");
  });

  it("没配 secret 时只解不验，uid 标为未验签", async () => {
    const { logger } = fakeLogger();
    const app = createHono({ logger });
    app.get("/me", (c) => c.json({ uid: c.get("user")?.uid ?? null, verified: c.get("user")?.verified ?? null }));

    const token = await sign({ uid: UID }, SECRET);
    const res = await app.request("/me", { headers: { authorization: `Bearer ${token}` } });

    expect(await res.json()).toEqual({ uid: UID, verified: false });
  });

  it("uid 缺失时视为没解出用户", async () => {
    const { logger } = fakeLogger();
    const app = createHono({ logger, jwtSecret: SECRET });
    app.get("/me", (c) => c.json({ uid: c.get("user")?.uid ?? null }));

    const token = await sign({ nickname: "谁" }, SECRET);
    const res = await app.request("/me", { headers: { authorization: `Bearer ${token}` } });

    expect(await res.json()).toEqual({ uid: null });
  });
});

describe("newUid", () => {
  it("是 26 位 Crockford base32", () => {
    expect(newUid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("随时间递增", () => {
    const first = newUid();
    const second = newUid();

    expect(second > first).toBe(true);
  });
});
