import { join } from "node:path";
import { newLogger, type Logger } from "@needle/logo";
import { createFileSink, createLogFiles } from "@needle/logo/node";
import { DATA_DIR, logsDir } from "./config.ts";

/**
 * 本服务的日志器。
 *
 * 用 @needle/logo 的理由很具体：这个服务本身是"调试对象"——生成失败、
 * JSON 解析失败、机翻降级都只在运行中一闪而过，事后必须能查。所以：
 *   1. 按级别落盘（info.log / warn.log / error.log，按大小轮转）
 *   2. 同时推给 /console 的实时日志流，可以边跑边看
 *
 * 按数据目录缓存：生产只有一个目录，测试用临时目录互不干扰。
 */
const cache = new Map<string, Logger>();

export function logDir(dataDir: string = DATA_DIR): string {
  return logsDir();
}

/** 取某个数据目录对应的日志器；第一次调用时挂上文件 sink。 */
export function log(dataDir: string = DATA_DIR): Logger {
  const cached = cache.get(dataDir);
  if (cached) return cached;

  const logger = newLogger({ name: "daily.news" });
  logger.addSink(createFileSink({ dir: join(dataDir, "logs") }));
  cache.set(dataDir, logger);
  return logger;
}

/** 给控制台的 `log.list` 用：列出/读取日志文件。 */
export function logFiles(dataDir: string = DATA_DIR) {
  return createLogFiles({ dir: join(dataDir, "logs") });
}

/** 退出前冲掉缓冲区（info 是攒批写的，不 dispose 会丢最后一批）。 */
export function flushLogs(): void {
  for (const logger of cache.values()) logger.dispose();
  cache.clear();
}
