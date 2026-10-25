import { LEVELS, logo, stdoutSink, type Level, type LogFiles } from "@needle/logo";
import { createFileSink, createLogFiles } from "@needle/logo/node";
import { logsDir } from "./config.ts";
import { viper } from "./viper.ts";

/**
 * 本服务的日志器。
 *
 * 用 `@needle/logo` 的理由很具体：这个服务本身是"调试对象"——生成失败、
 * JSON 解析失败、机翻降级都只在运行中一闪而过，事后必须能查。所以：
 *   1. 按级别落盘（info.log / warn.log / error.log，按大小轮转）
 *   2. 同时推给 /shell 的实时日志流，可以边跑边看
 *
 * 挂在**全局 `logo`** 上而不是另建实例：`@needle/shell` 的 `createSource` 默认订阅
 * 全局 logo（`createHonox` 不会替面板注入 logger），另建实例等于面板右栏永远空着。
 * 业务侧统一 `import { logger } from "./logo.ts"`。
 */
export const logger = logo;

/**
 * 读级别配置。
 *
 * 写错级别当成启动期错误直接炸，不静默回退：`filter_level: wran` 这种拼错
 * 如果被忽略，线上会一路按 info 跑，等到要看 debug 时才发现一直没记。
 */
function readLevel(): Level {
  const value = viper.getString("logger.filter_level", "info");
  if (!(value in LEVELS)) {
    throw new Error(`logger.filter_level 只能是 ${Object.keys(LEVELS).join(" / ")}，拿到 "${value}"`);
  }
  return value as Level;
}

/**
 * 日志目录跟着数据目录（`<data.dir>/logs`），不做成配置项。
 *
 * launchd 的 StandardErrorPath、`fetch.sh` 的清理逻辑、README 都按这个路径写；
 * 多一个配置项只多一处能配错。
 */
export function logDir(): string {
  return logsDir();
}

/** 给面板的 `log.list` 用：列出/读取日志文件。 */
export function logFiles(): LogFiles {
  return createLogFiles({ dir: logDir() });
}

/** 只挂一次：测试里每个用例都建一份 app，重复挂就是同一行落 N 遍盘。 */
let initialized = false;

/**
 * 初始化日志：定级别、挂文件 sink。
 *
 * 在 `main.ts` 里最先调用：晚于业务导入的话，启动阶段那一批日志就永远进不了文件。
 */
export function initLog(): { logFiles: LogFiles } {
  if (initialized) {
    return { logFiles: logFiles() };
  }
  initialized = true;

  const level = readLevel();
  logger.setLevel(level);
  // 摘掉默认的 stdout sink：日志只进文件与面板。launchd 的 StandardOutPath 已经
  // 在收 stdout，留着等于同一行落两遍盘；跑测试时也会刷屏。
  logger.removeSink(stdoutSink);
  // minLevel 跟着 filter_level 走：级别开到 debug 才需要 debug.log，
  // 否则只是凭空多一个永远为空的文件。
  logger.addSink(createFileSink({ dir: logDir(), minLevel: level }));
  return { logFiles: logFiles() };
}

/** 退出前冲掉缓冲区（info 是攒批写的，不 dispose 会丢最后一批）。 */
export function flushLogs(): void {
  logger.dispose();
}
