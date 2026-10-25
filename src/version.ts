import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 版本号只有仓库根 `package.json` 一个来源（AGENTS.md §14）。
 *
 * 不硬编码：`/health` 与面板标题各写一份 `0.1.0`，改版本时必然漏掉一处。
 * 启动时读一次，之后常驻内存。
 */
export const APP_VERSION = (
  JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as { version: string }
).version;
