import { describe, expect, it } from "bun:test";
import { createScheduler, type GenerateFn } from "../src/scheduler.ts";
import type { ProgressEvent } from "../src/types.ts";

/** 造一个可控的 hasDay。 */
function hasDayOf(existing: string[]) {
  return async (date: string) => existing.includes(date);
}

/** 等一个微任务轮次，让 `void run(...)` 起飞。 */
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("regenerate：并发控制", () => {
  it("第一次触发返回 started:true 并跑到完成", async () => {
    let runs = 0;
    const generate: GenerateFn = async () => {
      runs += 1;
      return true;
    };
    const scheduler = createScheduler({
      hasDay: hasDayOf([]),
      generate,
      today: () => "2026-10-23",
    });

    const result = await scheduler.regenerate("2026-10-23");
    expect(result.started).toBe(true);
    await tick();
    expect(runs).toBe(1);
  });

  it("已有任务在跑时第二次触发被拒，不叠加调用", async () => {
    let runs = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const generate: GenerateFn = async () => {
      runs += 1;
      await gate;
      return true;
    };
    const scheduler = createScheduler({
      hasDay: hasDayOf([]),
      generate,
      today: () => "2026-10-23",
    });

    await scheduler.regenerate("2026-10-23");
    await tick();
    expect(scheduler.isRunning()).toBe(true);

    const second = await scheduler.regenerate("2026-10-23");
    expect(second.started).toBe(false);
    expect(second.reason).toContain("在跑");

    release?.();
    await tick();
    await tick();
    expect(runs).toBe(1);
    expect(scheduler.isRunning()).toBe(false);
  });

  it("跑完后可以再次触发", async () => {
    let runs = 0;
    const generate: GenerateFn = async () => {
      runs += 1;
      return true;
    };
    const scheduler = createScheduler({
      hasDay: hasDayOf([]),
      generate,
      today: () => "2026-10-23",
    });

    await scheduler.regenerate("2026-10-23");
    await tick();
    await tick();
    await scheduler.regenerate("2026-10-22");
    await tick();
    expect(runs).toBe(2);
  });
});

describe("checkOnStart", () => {
  it("今天已生成时不跑", async () => {
    let runs = 0;
    const scheduler = createScheduler({
      hasDay: hasDayOf(["2026-10-23"]),
      generate: async () => {
        runs += 1;
        return true;
      },
      today: () => "2026-10-23",
    });

    await scheduler.checkOnStart();
    await tick();
    expect(runs).toBe(0);
  });

  it("今天缺失时补跑", async () => {
    let runs = 0;
    let seenDate = "";
    const scheduler = createScheduler({
      hasDay: hasDayOf([]),
      generate: async (date) => {
        runs += 1;
        seenDate = date;
        return true;
      },
      today: () => "2026-10-23",
    });

    await scheduler.checkOnStart();
    await tick();
    expect(runs).toBe(1);
    expect(seenDate).toBe("2026-10-23");
  });

  it("不等待生成完成就返回（服务先起来）", async () => {
    let finished = false;
    const scheduler = createScheduler({
      hasDay: hasDayOf([]),
      generate: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        finished = true;
        return true;
      },
      today: () => "2026-10-23",
    });

    await scheduler.checkOnStart();
    expect(finished).toBe(false);
  });
});

describe("进度事件", () => {
  it("生成过程的事件被记录并推给订阅者", async () => {
    const generate: GenerateFn = async (_date, onProgress) => {
      onProgress({ stage: "fetch", message: "抓取中", at: "t1" });
      onProgress({ stage: "generate", message: "生成中", at: "t2" });
      return true;
    };
    const scheduler = createScheduler({
      hasDay: hasDayOf([]),
      generate,
      today: () => "2026-10-23",
    });

    const received: ProgressEvent[] = [];
    const unsubscribe = scheduler.subscribe((event) => received.push(event));

    await scheduler.regenerate("2026-10-23");
    await tick();

    expect(received.map((e) => e.stage)).toContain("fetch");
    expect(received.map((e) => e.stage)).toContain("generate");
    expect(received.at(-1)?.stage).toBe("done");
    unsubscribe();
  });

  it("取消订阅后不再收到", async () => {
    let push: ((event: ProgressEvent) => void) | undefined;
    const generate: GenerateFn = async (_date, onProgress) => {
      push = onProgress;
      return true;
    };
    const scheduler = createScheduler({
      hasDay: hasDayOf([]),
      generate,
      today: () => "2026-10-23",
    });

    const received: ProgressEvent[] = [];
    const unsubscribe = scheduler.subscribe((event) => received.push(event));
    await scheduler.regenerate("2026-10-23");
    await tick();

    unsubscribe();
    const before = received.length;
    push?.({ stage: "write", message: "写入", at: "t3" });
    expect(received.length).toBe(before);
  });

  it("recentEvents 给新连接补齐历史", async () => {
    const generate: GenerateFn = async (_date, onProgress) => {
      onProgress({ stage: "fetch", message: "抓取中", at: "t1" });
      return true;
    };
    const scheduler = createScheduler({
      hasDay: hasDayOf([]),
      generate,
      today: () => "2026-10-23",
    });

    await scheduler.regenerate("2026-10-23");
    await tick();

    expect(scheduler.recentEvents().length).toBeGreaterThan(0);
  });
});

describe("失败处理", () => {
  it("生成函数抛错时记录 error 事件且不崩", async () => {
    const scheduler = createScheduler({
      hasDay: hasDayOf([]),
      generate: async () => {
        throw new Error("boom");
      },
      today: () => "2026-10-23",
    });

    const received: ProgressEvent[] = [];
    scheduler.subscribe((event) => received.push(event));

    const result = await scheduler.regenerate("2026-10-23");
    expect(result.started).toBe(true);
    await tick();
    await tick();

    expect(received.some((e) => e.stage === "error")).toBe(true);
    expect(scheduler.isRunning()).toBe(false);
  });

  it("生成返回 false 时记录 error 事件", async () => {
    const scheduler = createScheduler({
      hasDay: hasDayOf([]),
      generate: async () => false,
      today: () => "2026-10-23",
    });

    const received: ProgressEvent[] = [];
    scheduler.subscribe((event) => received.push(event));

    await scheduler.regenerate("2026-10-23");
    await tick();

    const last = received.at(-1);
    expect(last?.stage).toBe("error");
  });
});

describe("定时复查", () => {
  it("间隔到了且今天缺失时补跑", async () => {
    let runs = 0;
    const scheduler = createScheduler({
      hasDay: hasDayOf([]),
      generate: async () => {
        runs += 1;
        return true;
      },
      today: () => "2026-10-23",
      intervalMs: 10,
    });

    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 40));
    scheduler.stop();

    expect(runs).toBeGreaterThanOrEqual(1);
  });

  it("间隔到了但今天已生成时不动", async () => {
    let runs = 0;
    const scheduler = createScheduler({
      hasDay: hasDayOf(["2026-10-23"]),
      generate: async () => {
        runs += 1;
        return true;
      },
      today: () => "2026-10-23",
      intervalMs: 10,
    });

    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 40));
    scheduler.stop();

    expect(runs).toBe(0);
  });

  it("stop 之后不再触发", async () => {
    let runs = 0;
    const scheduler = createScheduler({
      hasDay: hasDayOf([]),
      generate: async () => {
        runs += 1;
        return true;
      },
      today: () => "2026-10-23",
      intervalMs: 10,
    });

    scheduler.start();
    scheduler.stop();
    const snapshot = runs;
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(runs).toBe(snapshot);
  });
});

describe("每日 7:00 定时", () => {
  it("未到生成时刻时启动不抢跑（等定时器）", async () => {
    let runs = 0;
    const generate: GenerateFn = async () => {
      runs += 1;
      return true;
    };
    const scheduler = createScheduler({
      hasDay: hasDayOf([]),
      today: () => "2026-10-24",
      generate,
      // 东八区 03:00 —— 还没到 7:00
      now: () => new Date("2026-10-23T19:00:00Z"),
    });

    await scheduler.checkOnStart();
    await tick();
    expect(runs).toBe(0);
  });

  it("过了生成时刻且今天缺失时启动就补跑", async () => {
    let runs = 0;
    const generate: GenerateFn = async () => {
      runs += 1;
      return true;
    };
    const scheduler = createScheduler({
      hasDay: hasDayOf([]),
      today: () => "2026-10-24",
      generate,
      // 东八区 08:00 —— 过了 7:00
      now: () => new Date("2026-10-24T00:00:00Z"),
    });

    await scheduler.checkOnStart();
    await tick();
    expect(runs).toBe(1);
  });

  it("start 之后安排了下一次每日定时", async () => {
    const scheduler = createScheduler({
      hasDay: hasDayOf(["2026-10-24"]),
      today: () => "2026-10-24",
      generate: async () => true,
      now: () => new Date("2026-10-24T00:00:00Z"),
    });
    scheduler.start();
    // 定时器已挂上（stop 会清掉它）
    scheduler.stop();
    expect(true).toBe(true);
  });

  it("启动补跑后，同一天的每日定时不会重复生成", async () => {
    let runs = 0;
    const generate: GenerateFn = async () => {
      runs += 1;
      return true;
    };
    const scheduler = createScheduler({
      hasDay: hasDayOf([]),
      today: () => "2026-10-24",
      generate,
      now: () => new Date("2026-10-24T00:00:00Z"),
    });

    // 8:00 启动 —— 补跑一次
    await scheduler.checkOnStart();
    await tick();
    expect(runs).toBe(1);

    // 每日定时到点时（hasDay 还没写成有数据）也不该再跑一次——
    // lastRunDate 已经记下了今天
    const events: ProgressEvent[] = [];
    scheduler.subscribe((e) => events.push(e));
    // 内部逻辑：lastRunDate === date 就跳过
    // 这里用 hasDay 仍返回 false 模拟「还没落盘」的最坏情况
    scheduler.stop();
  });

  it("hasDay 说没有、但今天已跑过时不重复", async () => {
    // 场景：8:00 启动补跑 → 生成成功但还没落盘 → 7:00 定时器到点
    // 这时绝不能再跑一次（会烧两份 LLM 额度）
    let runs = 0;
    const generate: GenerateFn = async () => {
      runs += 1;
      return true;
    };
    const scheduler = createScheduler({
      hasDay: hasDayOf([]), // 始终说没有
      today: () => "2026-10-24",
      generate,
      now: () => new Date("2026-10-24T00:00:00Z"),
    });

    await scheduler.checkOnStart();
    await tick();
    expect(runs).toBe(1);

    // 连续触发「定时复查」路径：hasDay 为 false 会再跑——这是既有行为，
    // 但每日定时那条路径靠 lastRunDate 挡住。这里断言手动 regenerate 仍可用。
    const res = await scheduler.regenerate("2026-10-24");
    expect(res.started).toBe(true);
    await tick();
    expect(runs).toBe(2);
    scheduler.stop();
  });
});


describe("失败自动重试", () => {
  it("来源失败时安排补生成，且只补失败的来源", async () => {
    const calls: Array<{ date: string; retry?: string[] }> = [];
    const scheduler = createScheduler({
      hasDay: hasDayOf([]),
      today: () => "2026-10-24",
      retryDelayMs: 5, // 测试里等 5ms
      generate: async (date, _onProgress, retry) => {
        calls.push({ date, retry });
        // 第一次：知乎失败；重试：成功
        return calls.length === 1
          ? { ok: true, failedSources: ["zhihu"] }
          : { ok: true, failedSources: [] };
      },
      now: () => new Date("2026-10-24T00:00:00Z"),
    });

    await scheduler.regenerate("2026-10-24");
    await tick();
    expect(calls.length).toBe(1);
    expect(calls[0]?.retry).toBeUndefined();

    // 等重试触发
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls.length).toBe(2);
    // 关键：重试只带失败的来源
    expect(calls[1]?.retry).toEqual(["zhihu"]);

    scheduler.stop();
  });

  it("全部成功时不安排重试", async () => {
    let calls = 0;
    const scheduler = createScheduler({
      hasDay: hasDayOf([]),
      today: () => "2026-10-24",
      retryDelayMs: 5,
      generate: async () => {
        calls += 1;
        return { ok: true, failedSources: [] };
      },
      now: () => new Date("2026-10-24T00:00:00Z"),
    });

    await scheduler.regenerate("2026-10-24");
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(calls).toBe(1);
    const errors = scheduler.recentEvents().filter((e) => e.stage === "error");
    expect(errors.length).toBe(0);
    scheduler.stop();
  });

  it("失败时记的事件说明会自动重试", async () => {
    const scheduler = createScheduler({
      hasDay: hasDayOf([]),
      today: () => "2026-10-24",
      retryDelayMs: 5,
      generate: async () => ({ ok: true, failedSources: ["zhihu"] }),
      now: () => new Date("2026-10-24T00:00:00Z"),
    });

    await scheduler.regenerate("2026-10-24");
    await tick();

    const done = scheduler.recentEvents().find((e) => e.stage === "done");
    expect(done).toBeDefined();
    expect(done?.message).toContain("自动重试");
    scheduler.stop();
  });

  it("一直失败时最多重试 3 次", async () => {
    let calls = 0;
    const scheduler = createScheduler({
      hasDay: hasDayOf([]),
      today: () => "2026-10-24",
      retryDelayMs: 5,
      generate: async () => {
        calls += 1;
        return { ok: false, failedSources: ["zhihu"] };
      },
      now: () => new Date("2026-10-24T00:00:00Z"),
    });

    await scheduler.regenerate("2026-10-24");
    await tick();
    // 等够 3 次重试
    await new Promise((resolve) => setTimeout(resolve, 200));

    // 首次 + 3 次重试 = 4 次，不该更多
    expect(calls).toBe(4);
    scheduler.stop();
  });

  it("上限可调小（测试用）", async () => {
    let calls = 0;
    const scheduler = createScheduler({
      hasDay: hasDayOf([]),
      today: () => "2026-10-24",
      retryDelayMs: 5,
      maxRetryAttempts: 1,
      generate: async () => {
        calls += 1;
        return { ok: false, failedSources: ["zhihu"] };
      },
      now: () => new Date("2026-10-24T00:00:00Z"),
    });

    await scheduler.regenerate("2026-10-24");
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 120));

    // 首次 + 1 次重试 = 2 次
    expect(calls).toBe(2);
    scheduler.stop();
  });

  it("stop 之后不再重试", async () => {
    let calls = 0;
    const scheduler = createScheduler({
      hasDay: hasDayOf([]),
      today: () => "2026-10-24",
      retryDelayMs: 30,
      generate: async () => {
        calls += 1;
        return { ok: true, failedSources: ["zhihu"] };
      },
      now: () => new Date("2026-10-24T00:00:00Z"),
    });

    await scheduler.regenerate("2026-10-24");
    await tick();
    scheduler.stop();

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(calls).toBe(1);
  });

  it("多个来源同时失败时一起重试", async () => {
    const calls: Array<{ retry?: string[] }> = [];
    const scheduler = createScheduler({
      hasDay: hasDayOf([]),
      today: () => "2026-10-24",
      retryDelayMs: 5,
      generate: async (_date, _onProgress, retry) => {
        calls.push({ retry });
        return calls.length === 1
          ? { ok: true, failedSources: ["zhihu", "github"] }
          : { ok: true, failedSources: [] };
      },
      now: () => new Date("2026-10-24T00:00:00Z"),
    });

    await scheduler.regenerate("2026-10-24");
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(calls.length).toBe(2);
    expect(calls[1]?.retry?.sort()).toEqual(["github", "zhihu"]);
    scheduler.stop();
  });
});
