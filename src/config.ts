import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 数据根目录。
 *
 * 默认放 ~/Documents 下的独立目录而不是 ~/Downloads：这些是长期保留的
 * 文档类产物，不该混进下载目录被清理工具扫走。环境变量可覆盖（测试用）。
 */
export const DATA_DIR = process.env["DAILY_NEWS_DATA_DIR"] ?? join(homedir(), "Documents", "daily-news");

/** 服务端口。5003 由用户指定，本机空闲，与 screenhub 8787、video-downloader 8891 都不冲突。 */
export const PORT = Number(process.env["DAILY_NEWS_PORT"] ?? 5003);

/**
 * 监听地址。
 *
 * 绑 0.0.0.0 是为了手机在同一 WiFi 下能看。只读页面公开，
 * 写操作（/api/regenerate）与控制台另有防护。
 */
export const HOSTNAME = process.env["DAILY_NEWS_HOST"] ?? "0.0.0.0";

/** 抓取产物保留天数。原始数据只为排障，7 天足够回溯一周。 */
export const RUNS_RETENTION_DAYS = 7;

/** 日志保留天数。 */
export const LOGS_RETENTION_DAYS = 30;

/**
 * 队列持久化文件。
 *
 * bunqueue 内嵌模式的一个 SQLite 文件：延时任务、cron 时段都在里面，
 * 进程重启后接着跑。默认跟数据放一起。
 */
export function queueDbPath(dataDir: string = DATA_DIR): string {
  return join(dataDir, "jobs.db");
}

/** 主通道：deepseek，key 从 ~/.zshrc.sh 抽取（launchd 不读 shell rc）。 */
export const PRIMARY_PROVIDER = process.env["PRIMARY_PROVIDER"] ?? "deepseek";
export const PRIMARY_MODEL = process.env["PRIMARY_MODEL"] ?? "deepseek-flash";

/** 兜底通道：zai-coding-cn，凭证在 ~/.pi/agent/auth.json，与主通道不同服务商。 */
export const FALLBACK_PROVIDER = process.env["FALLBACK_PROVIDER"] ?? "zai-coding-cn";
export const FALLBACK_MODEL = process.env["FALLBACK_MODEL"] ?? "glm-5.3-flash";

/** pi 可执行文件：优先自托管版（随 pi 升级），回落 brew 版。 */
export function piBin(): string {
  const explicit = process.env["PI_BIN"];
  if (explicit !== undefined && explicit !== "") {
    return explicit;
  }
  return join(homedir(), ".pi", "agent", "bin", "pi");
}

/** 抓取脚本路径。 */
export function fetchScript(): string {
  return join(import.meta.dir, "..", "scripts", "fetch.sh");
}

/** JSON 输出规范，随 prompt 一起传给模型。 */
export function promptFile(): string {
  return join(import.meta.dir, "..", "prompts", "format.md");
}

export function runsDir(date: string): string {
  return join(DATA_DIR, "runs", date);
}

export function logsDir(): string {
  return join(DATA_DIR, "logs");
}

/**
 * 控制台凭据。三者都从环境变量读，不放代码里。
 *
 * `CONSOLE_SECRET` 缺省时 needle 会随机生成并在启动时 warn——那种情况下
 * 服务重启后所有登录态失效，需要重新 `auth`。
 */
export const CONSOLE_USER = process.env["CONSOLE_USER"] ?? "";
export const CONSOLE_PASSWORD = process.env["CONSOLE_PASSWORD"] ?? "";
export const CONSOLE_SECRET = process.env["CONSOLE_SECRET"] ?? "";

/**
 * JWT 验签密钥。
 *
 * 空串 = 只解不验（core 的 JWT 中间件解出 payload 但不验签，uid 不可信）。
 * 现在还没有登录、没有签发方，所以默认为空。
 */
export const JWT_SECRET = process.env["DAILY_NEWS_JWT_SECRET"] ?? "";

/** 东八区偏移（毫秒）。存储与统计固定用东八区。 */
const TZ_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 昨天的东八区日期，`YYYY-MM-DD`。 */
export function todayInShanghai(now: Date = new Date()): string {
  return new Date(now.getTime() + TZ_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * 把 ISO 时间转成东八区的 `YYYY-MM-DD HH:mm`。
 *
 * 存储一律用 UTC ISO（排序、比较都安全），但**显示**必须转东八区——
 * 直接截 ISO 字符串会看到 UTC 时间，跟用户认知里的日期差 8 小时。
 * 比如 `2026-10-23T23:59:49Z` 实际是东八区的 `2026-10-24 07:59:49`。
 */
export function formatShanghai(iso: string, withMinutes = true): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }
  const shifted = new Date(parsed.getTime() + TZ_OFFSET_MS).toISOString();
  return withMinutes ? shifted.slice(0, 16).replace("T", " ") : shifted.slice(0, 10);
}

/** 东八区当前是几点（0~23）。 */
export function hourInShanghai(now: Date = new Date()): number {
  return new Date(now.getTime() + TZ_OFFSET_MS).getUTCHours();
}

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"] as const;

/** 把 `YYYY-MM-DD` 换成 "星期五"。解析失败返回空串。 */
export function weekdayOf(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }
  const index = parsed.getUTCDay();
  const name = WEEKDAYS[index];
  return name === undefined ? "" : `星期${name}`;
}
