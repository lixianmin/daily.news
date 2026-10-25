import { Queue, Worker, type Job } from "bunqueue/client";
import { hourInShanghai, queueDbPath } from "./config.ts";
import {
  GENERATE_JOB,
  missingSources,
  runGenerateJob,
  type GenerateFn,
  type GenerateJobData,
} from "./jobs.ts";
import { logger } from "./logo.ts";
import type { DigestDay, ProgressEvent, SourceKey } from "./types.ts";

/** 队列名。 */
const QUEUE_NAME = "daily-news";

/** 每日生成的 cron id。 */
const DAILY_CRON_ID = "daily-generate";

/** 时区。存储与统计固定东八区，cron 也按东八区算。 */
const TIMEZONE = "Asia/Shanghai";

/** 每日生成时刻（东八区小时）。 */
const DAILY_GENERATE_HOUR = 7;

/** 补生成间隔。 */
const RETRY_DELAY_MS = 10 * 60 * 1000;

/** 补生成最大尝试次数（含第一次）。 */
const MAX_RETRY_ATTEMPTS = 3;

/** 保留的进度事件条数。够页面新连上时看到最近几步。 */
const MAX_EVENTS = 50;

export interface SchedulerOptions {
  /** 读某天成品；null = 没有。 */
  readDay: (date: string) => Promise<DigestDay | null>;
  /** 跑一次生成。由 server 注入，便于测试替换。 */
  generate: GenerateFn;
  /** 今天（东八区）的日期。 */
  today: () => string;
  /** 队列文件路径。测试用临时文件。 */
  dataPath?: string;
  /** 每日生成时刻（东八区小时）。测试可调。 */
  generateHour?: number;
  /** 补生成间隔（毫秒）。测试可调小。 */
  retryDelayMs?: number;
  /** 补生成最大尝试次数。测试可调小。 */
  maxRetryAttempts?: number;
  /** 当前时间。测试可注入固定值。 */
  now?: () => Date;
}

export interface Scheduler {
  /** 启动队列、worker 与每日定时。 */
  start(): Promise<void>;
  /** 停掉 worker 与队列。 */
  stop(): Promise<void>;
  /**
   * 启动补跑：今天还没成品且已过生成时刻就排一次。
   *
   * 每日 cron 的「错过的时段在重启后补跑」覆盖了「服务在生成时刻不在线」，
   * 这里覆盖的是「服务是后来才装的」——那时 cron 还没注册过，今天没有时段。
   */
  checkOnStart(): Promise<void>;
  /**
   * 手动触发某天的重新生成。
   *
   * 已有生成任务在跑时返回 `started: false`，不排队——重复点击不该叠加成
   * 多次 LLM 调用。
   */
  regenerate(date: string): Promise<{ started: boolean; reason?: string }>;
  /** 是否有生成正在跑。 */
  isRunning(): boolean;
  /** 最近的事件，供 SSE 新连接补齐历史。 */
  recentEvents(): ProgressEvent[];
  /** 订阅进度事件。返回取消订阅函数。 */
  subscribe(listener: (event: ProgressEvent) => void): () => void;
}

export function createScheduler(options: SchedulerOptions): Scheduler {
  const listeners = new Set<(event: ProgressEvent) => void>();
  const events: ProgressEvent[] = [];

  let running = false;
  let queue: Queue<GenerateJobData> | undefined;
  let worker: Worker<GenerateJobData> | undefined;

  const generateHour = options.generateHour ?? DAILY_GENERATE_HOUR;
  const retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
  const maxRetryAttempts = options.maxRetryAttempts ?? MAX_RETRY_ATTEMPTS;

  function record(event: ProgressEvent): void {
    events.push(event);
    if (events.length > MAX_EVENTS) {
      events.shift();
    }
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // 单个订阅者出错不该影响其它订阅者
      }
    }
  }

  /**
   * 排一次补生成。
   *
   * jobId 固定成 `retry:<date>`：同一天的重试链只有一条。重试链在跑、
   * 跑完了、或者已经把次数用光（state = failed），都不再排新的——
   * 这就是「每天每来源最多 3 次」的上限。
   */
  async function scheduleRetry(date: string, sources: SourceKey[]): Promise<void> {
    if (queue === undefined) {
      return;
    }
    const jobId = `retry:${date}`;
    const state = await queue.getJobState(jobId);
    if (state !== "unknown") {
      logger.info("retry not scheduled: chain already exists", { date, state });
      return;
    }
    await queue.add(
      GENERATE_JOB,
      { kind: "retry", date, sources },
      {
        jobId,
        delay: retryDelayMs,
        attempts: maxRetryAttempts,
        backoff: { type: "fixed", delay: retryDelayMs },
      },
    );
    logger.warn("generate incomplete, retry scheduled", {
      date,
      sources,
      delayMinutes: Math.max(1, Math.round(retryDelayMs / 60000)),
      attempts: maxRetryAttempts,
    });
  }

  /** 处理一个生成任务。 */
  async function runJob(job: Job<GenerateJobData>): Promise<void> {
    running = true;
    try {
      await runGenerateJob(job.data, {
        generate: options.generate,
        readDay: options.readDay,
        today: options.today,
        emit: (event) => {
          record(event);
          // 队列侧也留一份，排障时能看到这个 job 走到哪一步
          void job.log(`${event.stage}: ${event.message}`).catch(() => undefined);
          if (event.ratio !== undefined) {
            void job.updateProgress(event.ratio).catch(() => undefined);
          }
        },
        scheduleRetry,
        narrowSources: async (sources) => {
          await job.updateData({ ...job.data, sources } as GenerateJobData);
        },
      });
    } finally {
      running = false;
    }
  }

  return {
    async start() {
      if (queue !== undefined) {
        return;
      }
      const dataPath = options.dataPath ?? queueDbPath();

      let created: Queue<GenerateJobData>;
      let createdWorker: Worker<GenerateJobData>;
      try {
        created = new Queue<GenerateJobData>(QUEUE_NAME, { embedded: true, dataPath });
        createdWorker = new Worker<GenerateJobData>(QUEUE_NAME, runJob, {
          embedded: true,
          dataPath,
          // 生成任务绝不并发：一次只跑一个，别把额度烧在重叠的抓取上
          concurrency: 1,
        });
      } catch (error) {
        // 队列起不来（库文件损坏、权限不足）→ 服务照常起，页面照常读，
        // 只是没有定时生成。静默降级会让「今天怎么没生成」变成查不到原因的事故。
        logger.error("scheduler unavailable: queue init failed", { error: String(error) });
        return;
      }

      createdWorker.on("error", (error) => {
        logger.error("queue worker error", { error: String(error) });
      });
      createdWorker.on("failed", (job, error) => {
        logger.error("job failed", { id: job.id, name: job.name, error: String(error) });
      });

      queue = created;
      worker = createdWorker;

      // 每日定时：东八区 07:00。错过的时段在重启后补跑（skipMissedOnRestart: false）。
      try {
        await created.upsertJobScheduler(
          DAILY_CRON_ID,
          {
            pattern: `0 ${generateHour} * * *`,
            timezone: TIMEZONE,
            skipMissedOnRestart: false,
          },
          { name: GENERATE_JOB, data: { kind: "today" } satisfies GenerateJobData },
        );
      } catch (error) {
        logger.error("daily cron registration failed", { error: String(error) });
      }

      logger.info("scheduler started", { dataPath, queue: QUEUE_NAME, hour: generateHour });
    },

    async stop() {
      await worker?.close();
      worker = undefined;
      queue?.close();
      queue = undefined;
    },

    async checkOnStart() {
      const date = options.today();
      const day = await options.readDay(date);
      // 有成品且不缺来源才算完整：部分失败的成品也要补
      if (day !== null && missingSources(day).length === 0) {
        logger.info("startup check: today already generated", { date });
        return;
      }
      // 还没到今天的生成时刻就别抢跑——凌晨启动时生成「今天」的日报，
      // 那时热榜才刚开始，意义不大。等每日定时器到点再生成。
      const now = options.now?.() ?? new Date();
      if (hourInShanghai(now) < generateHour) {
        logger.info("startup check: before daily hour, waiting for timer", {
          date,
          hour: hourInShanghai(now),
        });
        return;
      }
      if (queue === undefined) {
        return;
      }
      await queue.add(
        GENERATE_JOB,
        { kind: "catchup", date } satisfies GenerateJobData,
        { jobId: `catchup:${date}` },
      );
      logger.info("startup check: today missing, queued", { date });
    },

    async regenerate(date) {
      if (running) {
        return { started: false, reason: "已有生成任务在跑" };
      }
      if (queue === undefined) {
        return { started: false, reason: "调度器未启动" };
      }
      // 同一个 jobId：连点不会排成多次生成
      await queue.add(
        GENERATE_JOB,
        { kind: "manual", date } satisfies GenerateJobData,
        { jobId: `manual:${date}` },
      );
      logger.info("regenerate queued", { date });
      return { started: true };
    },

    isRunning() {
      return running;
    },

    recentEvents() {
      return [...events];
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
