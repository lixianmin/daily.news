import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * 抓取脚本的条数限制。
 *
 * 曾经的坑：fetch.sh 里写 `rows[:$ITEM_LIMIT]`，以为 shell 变量会展开——
 * 但 heredoc 用的是 `<<'PYEOF'`（带引号），shell 变量在 heredoc 里不展开，
 * Python 收到的是字面量 `rows[:$ITEM_LIMIT]`，直接报错，抓取静默变成 0 条。
 *
 * 所以这里断言：Python 段里只能通过 os.environ 读条数，不能出现裸的 $ 变量。
 */
const SCRIPT_PATH = join(import.meta.dir, "..", "scripts", "fetch.sh");

describe("fetch.sh 条数限制", () => {
  it("默认取 10 条", async () => {
    const script = await readFile(SCRIPT_PATH, "utf8");
    expect(script).toContain('ITEM_LIMIT="${DAILY_NEWS_ITEM_LIMIT:-10}"');
  });

  it("ITEM_LIMIT 导出给 Python 子进程", async () => {
    const script = await readFile(SCRIPT_PATH, "utf8");
    // 不 export 的话 Python 的 os.environ 读不到
    expect(script).toMatch(/^export ITEM_LIMIT$/m);
  });

  it("Python 段通过 os.environ 读条数", async () => {
    const script = await readFile(SCRIPT_PATH, "utf8");
    expect(script).toContain('os.environ.get("ITEM_LIMIT"');
  });

  it("Python 段里没有裸的 shell 变量（heredoc 不展开）", async () => {
    const script = await readFile(SCRIPT_PATH, "utf8");
    // 抽取所有 heredoc 段
    const blocks = [...script.matchAll(/<<'PYEOF'\n([\s\S]*?)\nPYEOF/g)].map((m) => m[1] ?? "");
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      // Python 代码里不该出现 $VAR 形式
      expect(block).not.toMatch(/\$[A-Za-z_]/);
    }
  });

  it("Python 段的 heredoc 都带引号（避免 shell 意外展开）", async () => {
    const script = await readFile(SCRIPT_PATH, "utf8");
    // 只看 python3 那几处——别处（meta.txt）需要展开 shell 变量，是故意的
    const lines = script.split("\n");
    const pythonHeredocs = lines.filter((l) => l.includes("python3") && l.includes("<<"));
    expect(pythonHeredocs.length).toBeGreaterThan(0);
    for (const line of pythonHeredocs) {
      expect(line).toContain("<<'PYEOF'");
    }
  });
});
