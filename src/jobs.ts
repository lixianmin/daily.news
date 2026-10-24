import { SOURCE_KEYS, type DigestDay, type ProgressEvent, type SourceKey } from "./types.ts";

/** 生成类任务的 job 名。队列里所有生成任务共用一个名字，靠 payload 区分。 */
export const GENERATE_JOB = "generate-day";

/**
 * 生成任务的 payload。
 *
 * `today` 的日期在**执行时**才算（每日 cron 用）；其余在入队时就定死。
 */
export type GenerateJobData =
  | { kind: "today" }
  | { kind: "catchup"; date: string }
  | { kind: "manual"; date: string }
  | { kind: "retry"; date: string; sources: SourceKey[] };

/** 生成结果。`failedSources` 是本轮没成的来源。 */
export interface GenerateOutcome {
  ok: boolean;
  failedSources?: SourceKey[];
}

/** 生成函数。由 server 注入，便于测试替换。 */
export type GenerateFn = (
  date: string,
  onProgress: (event: ProgressEvent) => void,
  /** 只补这些来源（补生成时用）。 */
  retryFailedSources?: SourceKey[],
) => Promise<boolean | GenerateOutcome>;

/** 处理一个生成任务需要的东西。 */
export interface JobContext {
  generate: GenerateFn;
  /** 读某天成品；null = 没有。 */
  readDay: (date: string) => Promise<DigestDay | null>;
  /** 今天（东八区）。 */
  today: () => string;
  /** 发一条进度事件。 */
  emit: (event: ProgressEvent) => void;
  /** 排一次补生成。 */
  scheduleRetry: (date: string, sources: SourceKey[]) => Promise<void>;
  /** 收窄本 job 下次重试的范围。队列特有能力，用回调注入。 */
  narrowSources?: (sources: SourceKey[]) => Promise<void>;
}

/**
 * 某天还缺哪些来源。
 *
 * 「当天是不是完整」只看来源状态，不看有没有文件——部分失败的成品也是成品，
 * 但它缺的那几个来源必须补上。
 */
export function missingSources(day: DigestDay | null): SourceKey[] {
  if (day === null) {
    return [...SOURCE_KEYS];
  }
  return SOURCE_KEYS.filter((key) => day.sources[key]?.ok !== true);
}

/**
 * 跑一次生成任务。
 *
 * 失败的处理分两种：
 * - 每日/补跑/手动：把失败来源排进重试链，本 job 正常结束；
 * - 重试任务本身：收窄来源后抛错，由队列重试**同一个** job（attempts 封顶）。
 */
export async function runGenerateJob(data: GenerateJobData, ctx: JobContext): Promise<void> {
  const date = data.kind === "today" ? ctx.today() : data.date;
  const day = await ctx.readDay(date);
  const missing = missingSources(day);

  // 每日与启动补跑：当天已经有完整成品就别再烧额度
  if (data.kind === "today" || data.kind === "catchup") {
    if (day !== null && missing.length === 0) {
      ctx.emit({
        stage: "done",
        message: `${date} 已有成品，跳过`,
        at: new Date().toISOString(),
      });
      return;
    }
  }

  // 补哪些来源：手动全量覆盖；重试任务只补指定的；其余有成品就只补缺的
  let sources: SourceKey[] | undefined;
  if (data.kind === "retry") {
    sources = data.sources;
  } else if (data.kind === "manual") {
    sources = undefined;
  } else if (day !== null) {
    sources = missing;
  } else {
    sources = undefined;
  }

  let ok = false;
  let failed: SourceKey[] = [];
  try {
    const raw = await ctx.generate(date, ctx.emit, sources);
    const outcome: GenerateOutcome = typeof raw === "boolean" ? { ok: raw } : raw;
    ok = outcome.ok;
    failed = outcome.failedSources ?? [];
  } catch (error) {
    // 重试任务把异常抛回去，队列会重试同一个 job
    if (data.kind === "retry") {
      throw error;
    }
    ctx.emit({
      stage: "error",
      message: `生成异常：${String(error)}`,
      at: new Date().toISOString(),
    });
    await ctx.scheduleRetry(date, [...SOURCE_KEYS]);
    return;
  }

  if (data.kind === "retry") {
    if (!ok) {
      ctx.emit({
        stage: "error",
        message: `${date} 补生成失败`,
        at: new Date().toISOString(),
      });
      throw new Error(`补生成失败：${date}`);
    }
    if (failed.length > 0) {
      // 收窄范围：下一次尝试只补还失败的来源
      await ctx.narrowSources?.(failed);
      throw new Error(`来源失败：${failed.join("、")}`);
    }
    ctx.emit({
      stage: "done",
      message: `${date} 补生成完成`,
      at: new Date().toISOString(),
    });
    return;
  }

  if (!ok) {
    ctx.emit({
      stage: "error",
      message: `${date} 生成失败`,
      at: new Date().toISOString(),
    });
    await ctx.scheduleRetry(date, [...SOURCE_KEYS]);
    return;
  }

  if (failed.length > 0) {
    await ctx.scheduleRetry(date, failed);
    ctx.emit({
      stage: "done",
      message: `${date} 部分完成：${failed.length} 个来源失败，已安排补生成`,
      at: new Date().toISOString(),
    });
    return;
  }

  ctx.emit({
    stage: "done",
    message: `${date} 生成完成`,
    at: new Date().toISOString(),
  });
}
