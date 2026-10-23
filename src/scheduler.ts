import { log } from "./log.ts";
import type { ProgressEvent } from "./types.ts";

/** 复查间隔：每小时看一眼今天有没有生成。 */
const RECHECK_INTERVAL_MS = 60 * 60 * 1000;

/** 保留的进度事件条数。够页面新连上时看到最近几步。 */
const MAX_EVENTS = 50;

/** 跑一次生成。返回是否成功。由 server 注入，便于测试替换。 */
export type GenerateFn = (date: string, onProgress: (event: ProgressEvent) => void) => Promise<boolean>;

export interface SchedulerOptions {
  /** 判断某天是否已有成品。 */
  hasDay: (date: string) => Promise<boolean>;
  generate: GenerateFn;
  /** 今天（东八区）的日期。 */
  today: () => string;
  /** 定时复查的间隔，测试时可调小。 */
  intervalMs?: number;
}

export interface Scheduler {
  /** 启动：今天没生成就跑一次。 */
  checkOnStart(): Promise<void>;
  /** 开始每小时复查。 */
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

  function record(event: ProgressEvent): void {
    events.push(event);
    if (events.length > MAX_EVENTS) events.shift();
    for (const listener of listeneters) {
      try {
        listener(event);
      } catch {
        // 单个订阅者出错不该影响其它订阅者
      }
    }
  }

  async function run(date: string, reason: string): Promise<boolean> {
    if (running) {
      log().warn("generate skipped: already running", { date, reason });
      return false;
    }
    running = true;
    log().info("generate triggered", { date, reason });
    try {
      const ok = await options.generate(date, record);
      record({
        stage: ok ? "done" : "error",
        message: ok ? `${date} 生成完成` : `${date} 生成失败`,
        at: new Date().toISOString(),
      });
      return ok;
    } catch (error) {
      log().error("generate threw", { date, reason, error: String(error) });
      record({ stage: "error", message: `生成异常：${String(error)}`, at: new Date().toISOString() });
      return false;
    } finally {
      running = false;
    }
  }

  return {
    async checkOnStart() {
      const date = options.today();
      if (await options.hasDay(date)) {
        log().info("startup check: today already generated", { date });
        return;
      }
      log().info("startup check: today missing, generating", { date });
      // 不 await 让服务先起来：首页立刻可用，进度通过 SSE 推
      void run(date, "startup");
    },

    start() {
      if (timer !== undefined) return;
      const intervalMs = options.intervalMs ?? RECHECK_INTERVAL_MS;
      timer = setInterval(() => {
        const date = options.today();
        void (async () => {
          if (running) return;
          if (await options.hasDay(date)) return;
          await run(date, "interval");
        })();
      }, intervalMs);
      // 定时器不该拖住进程退出
      timer.unref?.();
    },

    stop() {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },

    async regenerate(date) {
      if (running) return { started: false, reason: "已有生成任务在跑" };
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
