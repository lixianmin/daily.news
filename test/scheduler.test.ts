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
