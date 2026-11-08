import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

describe("fetch.sh 不再抓 Twitter", () => {
  it("没有 dokobot 残留（Twitter 改走 pi-chrome）", async () => {
    const script = await readFile(SCRIPT_PATH, "utf8");
    expect(script).not.toContain("dokobot");
    expect(script).not.toContain("fetch_twitter");
  });

  it("默认来源只有三个", async () => {
    const script = await readFile(SCRIPT_PATH, "utf8");
    expect(script).toContain('SOURCES="gh,hn,zhihu"');
  });
});

describe("fetch.sh 条数限制", () => {
  it("默认取 10 条", async () => {
    const script = await readFile(SCRIPT_PATH, "utf8");
    expect(script).toContain('ITEM_LIMIT="${DAILY_NEWS_ITEM_LIMIT:-10}"');
  });

  it("ITEM_LIMIT 导出给 Python 子进程", async () => {
    const script = await readFile(SCRIPT_PATH, "utf8");
    // 不 export 的话 Python 的 os.environ 读不到
    // 导出可能有多个变量（ITEM_LIMIT / EXCERPT_LIMIT），只要求 ITEM_LIMIT 在 export 行里
    expect(script).toMatch(/^export\b.*\bITEM_LIMIT\b.*$/m);
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

describe("fetch.sh 知乎摘要片段", () => {
  /** 从脚本里抽出知乎那段 Python（heredoc 内容）。 */
  async function zhihuPython(): Promise<string> {
    const script = await readFile(SCRIPT_PATH, "utf8");
    const blocks = [...script.matchAll(/<<'PYEOF'\n([\s\S]*?)\nPYEOF/g)].map((m) => m[1] ?? "");
    const block = blocks.find((code) => code.includes("zhihu") || code.includes("hover"));
    if (block === undefined) {
      throw new Error("没找到知乎的 Python 段");
    }
    return block;
  }

  /** 跑一遍知乎那段 Python，返回生成的 markdown。 */
  async function runZhihu(raw: unknown, env: Record<string, string> = {}): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "fetch-zhihu-"));
    const rawPath = join(dir, "raw.json");
    await writeFile(rawPath, JSON.stringify(raw), "utf8");
    try {
      const proc = Bun.spawn(["python3", "-", rawPath], {
        stdin: new TextEncoder().encode(await zhihuPython()),
        env: { ...process.env, ...env },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout as ReadableStream).text(),
        new Response(proc.stderr as ReadableStream).text(),
      ]);
      const code = await proc.exited;
      if (code !== 0) {
        throw new Error(`python3 exit=${code}: ${stderr}`);
      }
      return stdout;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** 造一条 zhihu 数据，hover 指定长度。 */
  function fixture(hoverLength: number) {
    return [
      {
        id: "zhihu",
        items: [
          {
            title: "如何评价这场比赛？",
            id: "123",
            extra: { info: "359 万热度", hover: "字".repeat(hoverLength) },
          },
        ],
      },
    ];
  }

  it("长摘要不被截到 180 字（页面展开后要看完整段落）", async () => {
    const md = await runZhihu(fixture(900));
    const excerpt = md.split("— ")[1] ?? "";
    expect(excerpt.length).toBeGreaterThan(800);
    expect(excerpt).not.toContain("…");
  });

  it("超过上限才截断并加省略号", async () => {
    const md = await runZhihu(fixture(2000), { EXCERPT_LIMIT: "300" });
    const excerpt = (md.split("— ")[1] ?? "").split("（")[0] ?? "";
    expect(excerpt.length).toBeLessThanOrEqual(301);
    expect(excerpt).toContain("…");
  });

  it("默认上限 1500", async () => {
    const md = await runZhihu(fixture(1400));
    expect(md).not.toContain("…");
    expect((md.split("— ")[1] ?? "").length).toBeGreaterThan(1300);
  });
});
