import { createHonox, type HonoxApp } from "@needle/honox";
import type { Logger } from "@needle/logo";
import type { Command } from "@needle/shell";
import { registerApis } from "./api/index.ts";
import { DATA_DIR, HOSTNAME, PORT, formatShanghai, queueDbPath, todayInShanghai } from "./config.ts";
import { generateDay } from "./generator.ts";
import { flushLogs, initLog, logger } from "./logo.ts";
import { createScheduler, type Scheduler } from "./scheduler.ts";
import { createStore, type Store } from "./store.ts";
import { createTranslator } from "./translator.ts";
import type { ProgressEvent, SourceKey } from "./types.ts";
import { SOURCE_KEYS } from "./types.ts";
import { APP_VERSION } from "./version.ts";
import { viper } from "./viper.ts";

/** 面板路径。`/shell` 是 `createHonox` 的默认值，写出来是为了 grep 得到。 */
const SHELL_BASE_PATH = "/shell";

export interface ServerHandle {
  port: number;
  scheduler: Scheduler;
  close: () => Promise<void>;
}

export interface ServerOptions {
  store?: Store;
  port?: number;
  hostname?: string;
  /** 跳过启动自检（测试用）。 */
  skipStartupCheck?: boolean;
  /** 队列文件路径。测试用。 */
  queuePath?: string;
  /** 替换真实生成函数（测试用）。不传则跑真实抓取 + 模型调用。 */
  generate?: (date: string, onProgress: (event: ProgressEvent) => void) => Promise<boolean>;
  /** 面板账号。测试用；生产从配置的 `shell.user` / `shell.password` 拼出来。 */
  shellUsers?: Record<string, string>;
  /** 面板 token 密钥。测试用；生产从 `shell.secret` 读。 */
  shellSecret?: string;
}

/**
 * 面板账号。
 *
 * 配置里是**单个** user/password 而不是映射：映射只能写在 yml 里，而这个口令
 * 不该进 git（`.env` 用 `APP_SHELL__USER` / `APP_SHELL__PASSWORD` 注入）。
 * 两者缺一个就不挂面板——没配面板比挂一个没人能管的入口安全。
 */
function readShellUsers(): Record<string, string> {
  const user = viper.getString("shell.user", "");
  const password = viper.getString("shell.password", "");
  if (user === "" || password === "") {
    return {};
  }
  return { [user]: password };
}

/**
 * 构造 Hono 应用：路由、中间件、调度器、面板。
 *
 * 与监听分离——测试要能在随机端口上起一份，生产走 Hono 的默认导出形式。
 */
export async function buildApp(options: ServerOptions = {}) {
  const store = options.store ?? createStore({ dataDir: DATA_DIR });
  const translator = createTranslator();

  // 日志最先初始化：它给全局 logo 挂文件 sink，晚于业务导入的话，
  // 启动阶段那一批日志就永远进不了文件。
  const { logFiles } = initLog();

  // --- 调度器 ---
  const scheduler = createScheduler({
    readDay: async (date) => store.readDay(date),
    today: () => todayInShanghai(),
    // 队列跟数据放一起：延时任务与成品同生共死
    dataPath: options.queuePath ?? queueDbPath(store.dataDir),
    generate:
      options.generate ??
      (async (date, onProgress, retryFailedSources) => {
        const result = await generateDay({
          date,
          store,
          translator,
          onProgress,
          // 重试时只补失败的来源，已成功的章节原样保留
          ...(retryFailedSources === undefined ? {} : { retryFailedSources }),
        });
        return { ok: result.ok, failedSources: result.failedSources };
      }),
  });

  // --- 面板 ---
  const shellUsers = options.shellUsers ?? readShellUsers();
  const shellSecret = options.shellSecret ?? viper.getString("shell.secret", "");
  const shell =
    Object.keys(shellUsers).length === 0
      ? undefined
      : {
          basePath: SHELL_BASE_PATH,
          auth: {
            users: shellUsers,
            // 空串不传：库会随机生成（重启掉登录），比拿 "" 当签名密钥安全
            ...(shellSecret === "" ? {} : { secret: shellSecret }),
          },
          title: "daily.news",
          version: APP_VERSION,
          logFiles,
          commands: createShellCommands(store, scheduler),
        };

  // createHonox 返回现成的 Hono 实例：rid → 兜底日志 → JWT → 门禁 已装好，
  // 路由直接挂在它上面。rid 由库发 ULID，多实例不重号。
  const app = createHonox({
    logger,
    // 全站匿名（见 api/index.ts），没有签发方；这个密钥只在客户端主动带 token
    // 时用于验签，留空即「解不开」，不影响任何路由。
    auth: { secret: viper.getString("auth.secret", "") },
    ...(shell === undefined ? {} : { shell }),
  });

  registerApis(app, { store, scheduler });

  // 队列与 worker 总是要起来的——它才是定时生成的主体
  await scheduler.start();
  if (options.skipStartupCheck !== true) {
    // 补跑是往队列里塞任务，所以必须排在 start 之后
    await scheduler.checkOnStart();
  }

  return { app, scheduler, logger };
}

/**
 * 面板命令。
 *
 * 三个都是"看一眼现在什么状态"，没有写数据的：重新生成走 `regen`，
 * 它只是往队列里塞一个任务，与 HTTP 那条路径同一个入口。
 */
function createShellCommands(store: Store, scheduler: Scheduler): Command[] {
  return [
    {
      name: "days",
      note: "列出已生成的日期与来源完整度",
      run: async () => {
        const index = await store.readIndex();
        return {
          kind: "table" as const,
          columns: ["日期", "星期", "总条数", "来源", "生成时间"],
          rows: index.days.slice(0, 30).map((day) => [
            day.date,
            day.weekday,
            String(day.total),
            `${day.sourcesOk}/${SOURCE_KEYS.length}`,
            formatShanghai(day.generatedAt, true),
          ]),
        };
      },
    },
    {
      name: "regen",
      note: "重新生成某天（省略日期 = 今天）",
      args: "[yyyy-mm-dd]",
      run: async ({ args }) => {
        const date = args[0] ?? todayInShanghai();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          throw new Error("日期格式应为 YYYY-MM-DD");
        }
        const result = await scheduler.regenerate(date);
        return {
          kind: "text" as const,
          text: result.started ? `已开始重新生成 ${date}，进度见日志流` : `未启动：${result.reason ?? "未知"}`,
        };
      },
    },
    {
      name: "today",
      note: "今天的状态：生成到哪一步、有没有成品",
      run: async () => {
        const date = todayInShanghai();
        const day = await store.readDay(date);
        const running = scheduler.isRunning();
        const last = scheduler.recentEvents().at(-1);

        if (day !== null) {
          return {
            kind: "text" as const,
            text: `${date} 已生成 · ${day.sections.length} 章节 · 模型 ${day.model}${running ? " · 正在重新生成中" : ""}`,
          };
        }
        if (running) {
          return {
            kind: "text" as const,
            text: `${date} 生成中${last === undefined ? "" : ` · ${last.message}`}`,
          };
        }
        return { kind: "text" as const, text: `${date} 还没有成品，也没在跑。执行 regen 触发一次。` };
      },
    },
  ];
}

/**
 * 起服务。
 *
 * 生产不用它：Hono 在 Bun 上的官方形式是 `export default { port, fetch }`——
 * Bun 运行时认这个默认导出并自己监听，路由、中间件、上下文、错误处理全是 Hono 的。
 * 这个函数只给测试用（随机端口 + 可控的关闭时机）。
 */
export async function createServer(options: ServerOptions = {}): Promise<ServerHandle> {
  const built = await buildApp(options);

  const hostname = options.hostname ?? HOSTNAME;
  const port = options.port ?? PORT;

  const bunServer = Bun.serve({ port, hostname, fetch: built.app.fetch });

  logger.info("server listening", {
    url: `http://127.0.0.1:${bunServer.port ?? port}`,
    shell: `http://127.0.0.1:${bunServer.port ?? port}${SHELL_BASE_PATH}`,
    hostname,
  });

  return {
    port: bunServer.port ?? port,
    scheduler: built.scheduler,
    close: async () => {
      await built.scheduler.stop();
      await bunServer.stop();
    },
  };
}

/**
 * 生产入口：Hono 在 Bun 上的官方形式。
 *
 * 顶层声明（不能在 `if` 块里 export default）；非主模块时不启动。
 */
const built: { app: HonoxApp; scheduler: Scheduler; logger: Logger } | null = import.meta.main
  ? await buildApp()
  : null;

if (built !== null) {
  logger.info("server starting", {
    url: `http://127.0.0.1:${PORT}`,
    shell: `http://127.0.0.1:${PORT}${SHELL_BASE_PATH}`,
    hostname: HOSTNAME,
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info("shutting down", { signal });
    await built.scheduler.stop();
    // 先把缓冲区冲掉再退出，否则最后一批 info 日志会丢
    flushLogs();
    process.exit(0);
  };
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
}

export default {
  port: PORT,
  hostname: HOSTNAME,
  fetch: built?.app.fetch ?? (() => new Response("not started", { status: 503 })),
};

export type { SourceKey };
