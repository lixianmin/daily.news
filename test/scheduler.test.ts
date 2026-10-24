import { rmSync } from "node:fs";
import { describe, expect, it } from "bun:test";
import { Queue } from "bunqueue/client";
import { createScheduler, type Scheduler } from "../src/scheduler.ts";
import type { GenerateFn } from "../src/jobs.ts";
import { SOURCE_KEYS, type DigestDay, type ProgressEvent, type SourceKey } from "../src/types.ts";
import { TEST_QUEUE_NAME, TEST_QUEUE_PATH, waitFor } from "./helpers/queue.ts";

// 测试开始前清掉上一次的队列文件。manager 是懒初始化的，
// 这行跑在第一次 new Queue 之前，所以不会撞上已打开的数据库。
rmSync(TEST_QUEUE_PATH, { force: true });

/** 造一天成品：默认四个来源都成功。 */
function dayOf(date: string, bad: SourceKey[] = []): DigestDay {
  const sources: DigestDay["sources"] = {};
  for (const key of SOURCE_KEYS) {
    sources[key] = { ok: !bad.includes(key), count: 3 };
  }
  return {
    date,
    weekday: "星期五",
    generatedAt: "2026-10-23T23:00:00.000Z",
    model: "test/model",
    sources,
    sections: [],
  };
}

/** 起一个调度器。 */
function schedulerOf(options: {
  day?: DigestDay | null;
  generate?: GenerateFn;
  today?: string;
  now?: () => Date;
  retryDelayMs?: number;
  maxRetryAttempts?: number;
}): Scheduler {
  return createScheduler({
    readDay: async () => options.day ?? null,
    generate: options.generate ?? (async () => ({ ok: true, failedSources: [] })),
    today: () => options.today ?? "2026-10-24",
    dataPath: TEST_QUEUE_PATH,
    now: options.now,
    retryDelayMs: options.retryDelayMs,
    maxRetryAttempts: options.maxRetryAttempts,
  });
}

describe("手动触发", () => {
  it("触发生成并记录进度事件", async () => {
    const calls: string[] = [];
    const scheduler = schedulerOf({
      generate: async (date, onProgress) => {
        calls.push(date);
        onProgress({ stage: "fetch", message: "抓取中", at: "t1" });
        return { ok: true, failedSources: [] };
      },
    });
    await scheduler.start();

    const result = await scheduler.regenerate("2026-10-24");
    expect(result.started).toBe(true);

    const done = await waitFor(() => calls.length === 1);
    expect(done).toBe(true);
    expect(calls[0]).toBe("2026-10-24");
    expect(scheduler.recentEvents().map((e) => e.stage)).toContain("fetch");

    await scheduler.stop();
  });

  it("订阅者收到事件，退订后不再收到", async () => {
    const scheduler = schedulerOf({
      generate: async (_date, onProgress) => {
        onProgress({ stage: "fetch", message: "抓取中", at: "t1" });
        return { ok: true, failedSources: [] };
      },
    });
    await scheduler.start();

    const received: ProgressEvent[] = [];
    const unsubscribe = scheduler.subscribe((event) => received.push(event));
    await scheduler.regenerate("2026-10-24");
    await waitFor(() => received.length > 0);

    unsubscribe();
    const before = received.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(received.length).toBe(before);

    await scheduler.stop();
  });

  it("已有生成在跑时再次触发被拒，不叠加调用", async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scheduler = schedulerOf({
      generate: async () => {
        calls += 1;
        await gate;
        return { ok: true, failedSources: [] };
      },
    });
    await scheduler.start();

    await scheduler.regenerate("2026-10-24");
    await waitFor(() => scheduler.isRunning());

    const second = await scheduler.regenerate("2026-10-24");
    expect(second.started).toBe(false);
    expect(second.reason).toContain("在跑");

    release?.();
    await waitFor(() => !scheduler.isRunning());
    expect(calls).toBe(1);

    await scheduler.stop();
  });
});

describe("失败补生成", () => {
  it("部分来源失败时延时补跑，且只补失败的来源", async () => {
    const calls: Array<{ date: string; sources?: SourceKey[] }> = [];
    const scheduler = schedulerOf({
      retryDelayMs: 50,
      generate: async (date, _onProgress, sources) => {
        calls.push({ date, sources });
        return calls.length === 1
          ? { ok: true, failedSources: ["zhihu"] }
          : { ok: true, failedSources: [] };
      },
    });
    await scheduler.start();

    await scheduler.regenerate("2026-10-25");
    const retried = await waitFor(() => calls.length === 2, 5000);
    expect(retried).toBe(true);
    expect(calls[1]?.sources).toEqual(["zhihu"]);

    await scheduler.stop();
  });

  it("重试链耗尽后不再排新的重试（每天上限）", async () => {
    let calls = 0;
    const scheduler = schedulerOf({
      retryDelayMs: 20,
      maxRetryAttempts: 2,
      generate: async () => {
        calls += 1;
        return { ok: true, failedSources: ["zhihu"] };
      },
    });
    await scheduler.start();

    await scheduler.regenerate("2026-10-26");
    // 首次 + 2 次重试 = 3 次，不该更多
    await waitFor(() => calls >= 3, 5000);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(calls).toBe(3);

    await scheduler.stop();
  });
});

describe("重启恢复", () => {
  it("关闭再启动后，未到点的延时任务仍在队列里", async () => {
    const scheduler = schedulerOf({
      retryDelayMs: 60_000,
      generate: async () => ({ ok: true, failedSources: ["zhihu"] }),
    });
    await scheduler.start();

    await scheduler.regenerate("2026-10-27");
    await new Promise((resolve) => setTimeout(resolve, 300));

    await scheduler.stop();

    // 重新打开：延时任务必须还在
    const queue = new Queue<Record<string, unknown>>(TEST_QUEUE_NAME, {
      embedded: true,
      dataPath: TEST_QUEUE_PATH,
    });
    const delayed = await queue.getDelayed();
    expect(delayed.map((job) => job.id)).toContain("retry:2026-10-27");
    queue.close();
  });
});

describe("每日定时", () => {
  it("注册的下一次触发时间是东八区次日 07:00", async () => {
    const scheduler = schedulerOf({});
    await scheduler.start();

    const queue = new Queue<Record<string, unknown>>(TEST_QUEUE_NAME, {
      embedded: true,
      dataPath: TEST_QUEUE_PATH,
    });
    const info = await queue.getJobScheduler("daily-generate");
    expect(info).not.toBeNull();

    const next = new Date(info!.next);
    // 东八区 = UTC+8，07:00 对应 UTC 23:00（前一天）
    const shanghaiHour = (next.getUTCHours() + 8) % 24;
    expect(shanghaiHour).toBe(7);
    expect(next.getUTCMinutes()).toBe(0);

    queue.close();
    await scheduler.stop();
  });
});

describe("启动补跑", () => {
  it("今天已有完整成品时不生成", async () => {
    let calls = 0;
    const scheduler = schedulerOf({
      day: dayOf("2026-10-24"),
      now: () => new Date("2026-10-24T00:00:00Z"),
      generate: async () => {
        calls += 1;
        return { ok: true, failedSources: [] };
      },
    });
    await scheduler.start();

    await scheduler.checkOnStart();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(calls).toBe(0);

    await scheduler.stop();
  });

  it("还没到生成时刻时不抢跑", async () => {
    let calls = 0;
    const scheduler = schedulerOf({
      now: () => new Date("2026-10-23T19:00:00Z"), // 东八区 03:00
      generate: async () => {
        calls += 1;
        return { ok: true, failedSources: [] };
      },
    });
    await scheduler.start();

    await scheduler.checkOnStart();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(calls).toBe(0);

    await scheduler.stop();
  });

  it("过了生成时刻且今天缺失时补跑", async () => {
    const calls: string[] = [];
    const scheduler = schedulerOf({
      today: "2026-10-28",
      now: () => new Date("2026-10-28T00:00:00Z"), // 东八区 08:00
      generate: async (date) => {
        calls.push(date);
        return { ok: true, failedSources: [] };
      },
    });
    await scheduler.start();

    await scheduler.checkOnStart();
    const ran = await waitFor(() => calls.length === 1, 3000);
    expect(ran).toBe(true);
    expect(calls[0]).toBe("2026-10-28");

    await scheduler.stop();
  });

  it("成品残缺时补跑只补缺的来源", async () => {
    const calls: Array<{ sources?: SourceKey[] }> = [];
    const scheduler = schedulerOf({
      today: "2026-10-29",
      day: dayOf("2026-10-29", ["zhihu"]),
      now: () => new Date("2026-10-29T00:00:00Z"),
      generate: async (_date, _onProgress, sources) => {
        calls.push({ sources });
        return { ok: true, failedSources: [] };
      },
    });
    await scheduler.start();

    await scheduler.checkOnStart();
    const ran = await waitFor(() => calls.length === 1, 3000);
    expect(ran).toBe(true);
    expect(calls[0]?.sources).toEqual(["zhihu"]);

    await scheduler.stop();
  });
});
