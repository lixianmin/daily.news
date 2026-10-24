import { log } from "./log.ts";
import { hourInShanghai, msUntilNextShanghaiHour } from "./config.ts";
import { SOURCE_KEYS, type ProgressEvent, type SourceKey } from "./types.ts";

/** 复查间隔：每小时看一眼今天有没有生成。 */
const RECHECK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * 每日生成时刻（东八区小时）。
 *
 * 早 7 点生成：早上的热榜反映的是「昨天到今早」的热点，读者上班路上
 * 就能看到；中午再生成意义不大，那天的热点已经翻篇了。
 */
export const DAILY_GENERATE_HOUR = 7;

/** 保留的进度事件条数。够页面新连上时看到最近几步。 */
const MAX_EVENTS = 50;

/**
 * 失败重试。
 *
 * 某个来源生成失败（比如知乎接口抽风、模型解析失败）不该就此躺平——
 * 定时任务会自己补上。间隔 10 分钟，最多 3 次。
 *
 * 只重试失败的来源：整份重跑既浪费额度，也可能把已经成功的章节
 * 换成新的（热榜会变）。
 */
export const RETRY_DELAY_MS = 10 * 60 * 1000;
export const MAX_RETRY_ATTEMPTS = 3;

/**
 * 跑一次生成。由 server 注入，便于测试替换。
 *
 * 返回值带 `failedSources`：哪些来源没成功，调度器据此安排补生成。
 */
export interface GenerateOutcome {
  ok: boolean;
  /** 本轮失败的来源。 */
  failedSources?: SourceKey[];
}

export type GenerateFn = (
  date: string,
  onProgress: (event: ProgressEvent) => void,
  /** 只补这些来源（重试时用）。 */
  retryFailedSources?: SourceKey[],
) => Promise<boolean | GenerateOutcome>;

export interface SchedulerOptions {
  /** 判断某天是否已有成品。 */
  hasDay: (date: string) => Promise<boolean>;
  /** 补生成的延迟，测试时可调小。 */
  retryDelayMs?: number;
  /** 补生成的最大次数，测试时可调小。 */
  maxRetryAttempts?: number;
  generate: GenerateFn;
  /** 今天（东八区）的日期。 */
  today: () => string;
  /** 定时复查的间隔，测试时可调小。 */
  intervalMs?: number;
  /** 当前时间。测试时可注入固定值。 */
  now?: () => Date;
}

export interface Scheduler {
  /** 启动：今天没生成就跑一次。 */
  checkOnStart(): Promise<void>;
  /** 开始每小时复查 + 每日定时。 */
  start(): void;
  stop(): void;
  /**
   * 手动触发某天的重新生成。
   *
   * 已有任务在跑时返回 `started: false`，不排队——重复点击不该叠加成
   * 多次 LLM 调用。
   */
  regenerate(date: string): Promise<{ started: boolean; reason?: string }>;
  isRunning(): boolean;
  /** 最近的事件，供 SSE 新连接补齐历史。 */
  recentEvents(): ProgressEvent[];
  /** 订阅进度事件。返回取消订阅函数。 */
  subscribe(listener: (event: ProgressEvent) => void): () => void;
}

export function createScheduler(options: SchedulerOptions): Scheduler {
  const listeneters = new Set<(event: ProgressEvent) => void>();
  const events: ProgressEvent[] = [];

  let running = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let dailyTimer: ReturnType<typeof setTimeout> | undefined;
  /** 今天已经跑过（不管成功没成功）。防重复生成。 */
  let lastRunDate: string | undefined;
  /** 待补生成的来源 → 已重试次数。 */
  const retryAttempts = new Map<string, number>();
  /** 待补生成的定时器。 */
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** 待补生成的日期与来源。 */
  let pendingRetry: { date: string; sources: SourceKey[] } | undefined;

  function record(event: ProgressEvent): void {
    events.push(event);
    if (events.length > MAX_EVENTS) {
      events.shift();
    }
    for (const listener of listeneters) {
      try {
        listener(event);
      } catch {
        // 单个订阅者出错不该影响其它订阅者
      }
    }
  }

  /**
   * 安排下一次每日生成。
   *
   * 用 setTimeout 而不是 setInterval：到点后重新计算下一次的间隔，
   * 这样跨夏令时、跨系统休眠都不会漂移（系统睡过 8 点，醒来后
   * setInterval 会立刻补一次，setTimeout 则重新算）。
   */
  function scheduleDaily(): void {
    if (dailyTimer !== undefined) {
      clearTimeout(dailyTimer);
      dailyTimer = undefined;
    }

    // 换了一天就清掉昨天的重试状态——
    // 昨天的失败不该让今天的生成被跳过
    const today = options.today();
    if (pendingRetry !== undefined && pendingRetry.date !== today) {
      clearRetry();
      retryAttempts.clear();
    }

    const now = options.now?.() ?? new Date();
    const delay = msUntilNextShanghaiHour(DAILY_GENERATE_HOUR, now);
    const fireAt = new Date(now.getTime() + delay);
    log().info("daily generate scheduled", {
      at: fireAt.toISOString(),
      hour: DAILY_GENERATE_HOUR,
    });

    dailyTimer = setTimeout(() => {
      dailyTimer = undefined;
      void (async () => {
        const date = options.today();
        // 今天已经跑过（可能启动时补跑过）就不重复
        if (lastRunDate === date) {
          log().info("daily generate skipped: already ran today", { date });
        } else if (await options.hasDay(date)) {
          log().info("daily generate skipped: already generated", { date });
        } else {
          await run(date, "daily");
        }
        // 排下一天的
        scheduleDaily();
      })();
    }, delay);
    dailyTimer.unref?.();
  }

  /**
   * 跑一次生成。
   *
   * `retrySources` 给了就只补这些来源（失败重试）。
   */
  async function run(
    date: string,
    reason: string,
    retrySources?: SourceKey[],
  ): Promise<boolean> {
    if (running) {
      log().warn("generate skipped: already running", { date, reason });
      return false;
    }
    running = true;
    lastRunDate = date;
    log().info("generate triggered", { date, reason, retrySources: retrySources ?? null });
    try {
      const raw = await options.generate(date, record, retrySources);
      const outcome: GenerateOutcome =
        typeof raw === "boolean" ? { ok: raw } : raw;
      const ok = outcome.ok;

      // 有来源失败 → 安排补生成
      const failed = outcome.failedSources ?? [];
      if (failed.length > 0) {
        scheduleRetry(date, failed, reason);
      } else {
        // 全都成功了，清掉重试状态
        clearRetry();
        for (const key of failed) {
          retryAttempts.delete(key);
        }
      }

      record({
        stage: ok ? "done" : "error",
        message:
          failed.length > 0
            ? `${date} 部分完成：${failed.length} 个来源失败，${Math.round(RETRY_DELAY_MS / 60000)} 分钟后自动重试`
            : ok
              ? `${date} 生成完成`
              : `${date} 生成失败`,
        at: new Date().toISOString(),
      });
      return ok;
    } catch (error) {
      log().error("generate threw", { date, reason, error: String(error) });
      record({ stage: "error", message: `生成异常：${String(error)}`, at: new Date().toISOString() });
      // 抛异常也算失败：整体来源都算失败，安排重试
      scheduleRetry(date, [...SOURCE_KEYS], reason);
      return false;
    } finally {
      running = false;
    }
  }

  /**
   * 安排补生成。
   *
   * 失败的来源各自记重试次数，超过上限就放弃——一直重试下去
   * 会变成烧额度的循环。
   */
  function scheduleRetry(date: string, sources: SourceKey[], reason: string): void {
    const retryable = sources.filter((source) => {
      const attempts = retryAttempts.get(source) ?? 0;
      if (attempts >= (options.maxRetryAttempts ?? MAX_RETRY_ATTEMPTS)) {
        log().error("retry abandoned: too many attempts", { date, source, attempts });
        return false;
      }
      return true;
    });

    if (retryable.length === 0) {
      log().warn("no retryable sources left", { date, sources });
      return;
    }

    // 合并到已有的待重试里
    const merged = new Set(pendingRetry?.date === date ? pendingRetry.sources : []);
    for (const source of retryable) {
      merged.add(source);
    }

    pendingRetry = { date, sources: [...merged] };
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
    }

    const delayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
    const minutes = Math.max(1, Math.round(delayMs / 60000));
    log().warn("generate incomplete, retry scheduled", {
      date,
      sources: [...merged],
      delayMinutes: minutes,
      attempt: (retryAttempts.get(retryable[0] ?? "") ?? 0) + 1,
      reason,
    });

    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      const pending = pendingRetry;
      pendingRetry = undefined;
      if (pending === undefined) {
        return;
      }

      // 记一次重试
      for (const source of pending.sources) {
        retryAttempts.set(source, (retryAttempts.get(source) ?? 0) + 1);
      }

      record({
        stage: "fetch",
        message: `第 ${(retryAttempts.get(pending.sources[0] ?? "") ?? 1)} 次重试：${pending.sources.join("、")}`,
        at: new Date().toISOString(),
      });

      void run(pending.date, "retry", pending.sources);
    }, delayMs);
    retryTimer.unref?.();
  }

  /** 清掉待重试的状态。 */
  function clearRetry(): void {
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    pendingRetry = undefined;
  }

  return {
    async checkOnStart() {
      const date = options.today();
      if (await options.hasDay(date)) {
        log().info("startup check: today already generated", { date });
        return;
      }
      // 还没到今天的生成时刻就别抢跑——凌晨启动时生成「今天」的日报，
      // 那时热榜才刚开始，意义不大。等每日定时器到点再生成。
      const now = options.now?.() ?? new Date();
      if (hourInShanghai(now) < DAILY_GENERATE_HOUR) {
        log().info("startup check: before daily hour, waiting for timer", {
          date,
          hour: hourInShanghai(now),
        });
        return;
      }
      log().info("startup check: today missing, generating", { date });
      // 不 await 让服务先起来：首页立刻可用，进度通过 SSE 推
      void run(date, "startup");
    },

    start() {
      if (timer !== undefined) {
        return;
      }
      const intervalMs = options.intervalMs ?? RECHECK_INTERVAL_MS;
      timer = setInterval(() => {
        const date = options.today();
        void (async () => {
          if (running) {
            return;
          }
          // 今天已经跑过就不重复（生成成功但还没落盘的窗口期内，
          // 每小时复查会看到 hasDay=false，重复跑就是白烧额度）
          if (lastRunDate === date) {
            return;
          }
          if (await options.hasDay(date)) {
            return;
          }
          await run(date, "interval");
        })();
      }, intervalMs);
      // 定时器不该拖住进程退出
      timer.unref?.();

      scheduleDaily();
    },

    stop() {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      if (dailyTimer !== undefined) {
        clearTimeout(dailyTimer);
        dailyTimer = undefined;
      }
      clearRetry();
    },

    async regenerate(date) {
      if (running) {
        return { started: false, reason: "已有生成任务在跑" };
      }
      // 同样不 await：HTTP 请求立即返回，进度走 SSE
      void run(date, "manual");
      return { started: true };
    },

    isRunning() {
      return running;
    },

    recentEvents() {
      return [...events];
    },

    subscribe(listener) {
      listeneters.add(listener);
      return () => {
        listeneters.delete(listener);
      };
    },
  };
}
