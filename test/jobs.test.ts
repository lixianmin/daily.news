import { describe, expect, it } from "bun:test";
import { missingSources, runGenerateJob, type GenerateJobData, type JobContext } from "../src/jobs.ts";
import { SOURCE_KEYS, type DigestDay, type ProgressEvent, type SourceKey } from "../src/types.ts";

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

/** 记录调用的上下文。 */
function contextOf(options: {
  day?: DigestDay | null;
  failed?: SourceKey[];
  throws?: boolean;
  today?: string;
}) {
  const calls: Array<{ date: string; sources?: SourceKey[] }> = [];
  const retries: Array<{ date: string; sources: SourceKey[] }> = [];
  const events: ProgressEvent[] = [];
  const narrowed: SourceKey[][] = [];

  const ctx: JobContext = {
    generate: async (date, _onProgress, sources) => {
      calls.push({ date, sources });
      if (options.throws === true) {
        throw new Error("boom");
      }
      return { ok: true, failedSources: options.failed ?? [] };
    },
    readDay: async () => options.day ?? null,
    today: () => options.today ?? "2026-10-24",
    emit: (event) => {
      events.push(event);
    },
    scheduleRetry: async (date, sources) => {
      retries.push({ date, sources });
    },
    narrowSources: async (sources) => {
      narrowed.push(sources);
    },
  };

  return { ctx, calls, retries, events, narrowed };
}

describe("missingSources", () => {
  it("没有成品时所有来源都算缺", () => {
    expect(missingSources(null)).toEqual([...SOURCE_KEYS]);
  });

  it("只列出没成功的来源", () => {
    const day = dayOf("2026-10-24", ["zhihu", "github"]);
    expect(missingSources(day)).toEqual(["github", "zhihu"]);
  });

  it("全部成功时没有缺来源", () => {
    expect(missingSources(dayOf("2026-10-24"))).toEqual([]);
  });
});

describe("runGenerateJob：按 kind 决定补哪些来源", () => {
  it("today：没有成品时全量生成", async () => {
    const { ctx, calls } = contextOf({ day: null });
    await runGenerateJob({ kind: "today" }, ctx);
    expect(calls.length).toBe(1);
    expect(calls[0]?.date).toBe("2026-10-24");
    expect(calls[0]?.sources).toBeUndefined();
  });

  it("today：已有完整成品时跳过，不生成", async () => {
    const { ctx, calls, events } = contextOf({ day: dayOf("2026-10-24") });
    await runGenerateJob({ kind: "today" }, ctx);
    expect(calls.length).toBe(0);
    expect(events.at(-1)?.message).toContain("跳过");
  });

  it("today：成品残缺时只补缺的来源", async () => {
    const { ctx, calls } = contextOf({ day: dayOf("2026-10-24", ["zhihu"]) });
    await runGenerateJob({ kind: "today" }, ctx);
    expect(calls[0]?.sources).toEqual(["zhihu"]);
  });

  it("catchup：没有成品时全量生成", async () => {
    const { ctx, calls } = contextOf({ day: null });
    await runGenerateJob({ kind: "catchup", date: "2026-10-24" }, ctx);
    expect(calls[0]?.sources).toBeUndefined();
  });

  it("catchup：成品残缺时只补缺的来源", async () => {
    const { ctx, calls } = contextOf({ day: dayOf("2026-10-24", ["github"]) });
    await runGenerateJob({ kind: "catchup", date: "2026-10-24" }, ctx);
    expect(calls[0]?.sources).toEqual(["github"]);
  });

  it("manual：即使有完整成品也强制全量重生成", async () => {
    const { ctx, calls } = contextOf({ day: dayOf("2026-10-24") });
    await runGenerateJob({ kind: "manual", date: "2026-10-24" }, ctx);
    expect(calls.length).toBe(1);
    expect(calls[0]?.sources).toBeUndefined();
  });

  it("retry：只补指定来源", async () => {
    const { ctx, calls } = contextOf({ day: dayOf("2026-10-24") });
    await runGenerateJob({ kind: "retry", date: "2026-10-24", sources: ["zhihu"] }, ctx);
    expect(calls[0]?.sources).toEqual(["zhihu"]);
  });
});

describe("runGenerateJob：失败处理", () => {
  it("部分来源失败时排重试，且只重试失败的来源", async () => {
    const { ctx, retries } = contextOf({ failed: ["zhihu", "github"] });
    await runGenerateJob({ kind: "manual", date: "2026-10-24" }, ctx);
    expect(retries.length).toBe(1);
    expect(retries[0]?.date).toBe("2026-10-24");
    expect(retries[0]?.sources.sort()).toEqual(["github", "zhihu"]);
  });

  it("生成抛异常时排重试，来源按全部算", async () => {
    const { ctx, retries, events } = contextOf({ throws: true });
    await runGenerateJob({ kind: "manual", date: "2026-10-24" }, ctx);
    expect(retries[0]?.sources).toEqual([...SOURCE_KEYS]);
    expect(events.some((e) => e.stage === "error")).toBe(true);
  });

  it("全部成功时不排重试", async () => {
    const { ctx, retries } = contextOf({ failed: [] });
    await runGenerateJob({ kind: "manual", date: "2026-10-24" }, ctx);
    expect(retries.length).toBe(0);
  });

  it("retry 任务失败时抛错（交给队列重试同一个 job）并收窄来源", async () => {
    const { ctx, retries, narrowed } = contextOf({ failed: ["zhihu"] });
    let threw = false;
    try {
      await runGenerateJob({ kind: "retry", date: "2026-10-24", sources: ["zhihu", "github"] }, ctx);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(narrowed[0]).toEqual(["zhihu"]);
    // retry 任务自己不排新链——重试由队列做
    expect(retries.length).toBe(0);
  });

  it("retry 任务抛异常时把异常继续抛出去", async () => {
    const { ctx } = contextOf({ throws: true });
    let threw = false;
    try {
      await runGenerateJob({ kind: "retry", date: "2026-10-24", sources: ["zhihu"] }, ctx);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("retry 任务成功后不再抛错", async () => {
    const { ctx } = contextOf({ failed: [] });
    await runGenerateJob({ kind: "retry", date: "2026-10-24", sources: ["zhihu"] }, ctx);
    expect(true).toBe(true);
  });
});

describe("runGenerateJob：进度事件", () => {
  it("生成过程中的事件被透传出去", async () => {
    const events: ProgressEvent[] = [];
    const ctx: JobContext = {
      generate: async (_date, onProgress) => {
        onProgress({ stage: "fetch", message: "抓取中", at: "t1" });
        onProgress({ stage: "generate", message: "生成中", at: "t2" });
        return { ok: true, failedSources: [] };
      },
      readDay: async () => null,
      today: () => "2026-10-24",
      emit: (event) => {
        events.push(event);
      },
      scheduleRetry: async () => undefined,
    };
    await runGenerateJob({ kind: "manual", date: "2026-10-24" }, ctx);
    expect(events.map((e) => e.stage)).toContain("fetch");
    expect(events.map((e) => e.stage)).toContain("generate");
    expect(events.at(-1)?.stage).toBe("done");
  });

  it("结束时补一条 done 事件", async () => {
    const { ctx, events } = contextOf({ failed: [] });
    await runGenerateJob({ kind: "manual", date: "2026-10-24" }, ctx);
    const last = events.at(-1);
    expect(last?.stage).toBe("done");
    expect(last?.message).toContain("生成完成");
  });
});

describe("runGenerateJob：输入校验", () => {
  it("kind 为 today 时用当天日期，其余用 payload 里的日期", async () => {
    const { ctx, calls } = contextOf({ day: null, today: "2026-10-30" });
    const kinds: GenerateJobData[] = [
      { kind: "today" },
      { kind: "catchup", date: "2026-10-24" },
      { kind: "manual", date: "2026-10-25" },
      { kind: "retry", date: "2026-10-26", sources: ["zhihu"] },
    ];
    for (const kind of kinds) {
      await runGenerateJob(kind, ctx);
    }
    expect(calls.map((c) => c.date)).toEqual(["2026-10-30", "2026-10-24", "2026-10-25", "2026-10-26"]);
  });
});
