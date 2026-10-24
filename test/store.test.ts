import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStore } from "../src/store.ts";
import type { DigestDay } from "../src/types.ts";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "daily-news-test-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

/** 造一天的最小成品。 */
function day(date: string, overrides: Partial<DigestDay> = {}): DigestDay {
  return {
    date,
    weekday: "星期五",
    generatedAt: `${date}T07:00:00+08:00`,
    model: "deepseek/deepseek-flash",
    sources: {
      github: { ok: true, count: 2 },
      hackernews: { ok: true, count: 1 },
    },
    sections: [
      {
        key: "github",
        title: "GitHub Trending（今日趨勢）",
        kind: "items",
        items: [
          { title: "owner/repo", url: "https://github.com/owner/repo", en: "A fast CLI for X.", zh: "" },
          { title: "other/lib", url: "https://github.com/other/lib", en: "A Python library.", zh: "" },
        ],
      },
      {
        key: "hackernews",
        title: "Hacker News（過去24小時熱點）",
        kind: "items",
        items: [{ title: "Show HN: Zed", url: "https://news.ycombinator.com/item?id=1", en: "An editor.", zh: "" }],
      },
    ],
    ...overrides,
  };
}

describe("writeDay / readDay", () => {
  it("落盘后能读回来，字段一致", async () => {
    const store = createStore({ dataDir });
    const input = day("2026-10-23");
    await store.writeDay(input);

    const loaded = await store.readDay("2026-10-23");
    expect(loaded?.date).toBe("2026-10-23");
    expect(loaded?.model).toBe("deepseek/deepseek-flash");
    expect(loaded?.sections).toHaveLength(2);
  });

  it("不存在的日期返回 null", async () => {
    const store = createStore({ dataDir });
    expect(await store.readDay("1999-01-01")).toBeNull();
  });

  it("落盘文件是合法 JSON（原子写不留半截）", async () => {
    const store = createStore({ dataDir });
    await store.writeDay(day("2026-10-23"));

    const raw = await readFile(join(dataDir, "days", "2026-10-23.json"), "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
    // 临时文件必须已被 rename 掉
    const entries = [...new Bun.Glob("days/*.tmp-*").scanSync({ cwd: dataDir })];
    expect(entries).toHaveLength(0);
  });

  it("损坏的 day 文件被跳过而不是抛错", async () => {
    const store = createStore({ dataDir });
    await mkdir(join(dataDir, "days"), { recursive: true });
    await writeFile(join(dataDir, "days", "2026-10-22.json"), "{ 这不是 JSON", "utf8");
    await store.writeDay(day("2026-10-23"));

    expect(await store.readDay("2026-10-22")).toBeNull();
    const index = await store.readIndex();
    expect(index.days.map((d) => d.date)).toEqual(["2026-10-23"]);
  });
});

describe("index.json", () => {
  it("写入后索引包含统计信息", async () => {
    const store = createStore({ dataDir });
    await store.writeDay(day("2026-10-23"));

    const index = await store.readIndex();
    expect(index.days).toHaveLength(1);
    const entry = index.days[0]!;
    expect(entry.date).toBe("2026-10-23");
    expect(entry.total).toBe(3);
    expect(entry.counts.github).toBe(2);
    expect(entry.counts.hackernews).toBe(1);
    expect(entry.sourcesOk).toBe(2);
    expect(entry.headlines).toContain("owner/repo");
  });

  it("多天按日期倒序", async () => {
    const store = createStore({ dataDir });
    await store.writeDay(day("2026-10-21"));
    await store.writeDay(day("2026-10-23"));
    await store.writeDay(day("2026-10-22"));

    const index = await store.readIndex();
    expect(index.days.map((d) => d.date)).toEqual(["2026-10-23", "2026-10-22", "2026-10-21"]);
  });

  it("同一天重写覆盖，不产生重复条目", async () => {
    const store = createStore({ dataDir });
    await store.writeDay(day("2026-10-23"));
    await store.writeDay(day("2026-10-23", { model: "zai-coding-cn/glm-5.3-flash" }));

    const index = await store.readIndex();
    expect(index.days).toHaveLength(1);

    const loaded = await store.readDay("2026-10-23");
    expect(loaded?.model).toBe("zai-coding-cn/glm-5.3-flash");
  });

  it("索引缺失时从 days 目录重建", async () => {
    const store = createStore({ dataDir });
    await store.writeDay(day("2026-10-23"));
    await rm(join(dataDir, "index.json"));

    const index = await store.readIndex();
    expect(index.days.map((d) => d.date)).toEqual(["2026-10-23"]);
  });

  it("索引没有的旧 day 文件也会被纳入（保持自愈）", async () => {
    const store = createStore({ dataDir });
    await store.writeDay(day("2026-10-23"));

    // 模拟历史遗留：直接塞一个 day 文件，不经过 writeDay
    await writeFile(join(dataDir, "days", "2026-10-20.json"), JSON.stringify(day("2026-10-20")), "utf8");

    const index = await store.readIndex();
    expect(index.days.map((d) => d.date)).toEqual(["2026-10-23", "2026-10-20"]);
  });
});

describe("search", () => {
  it("匹配英文摘要", async () => {
    const store = createStore({ dataDir });
    await store.writeDay(day("2026-10-23"));

    const hits = await store.search("Python");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.title).toBe("other/lib");
  });

  it("匹配标题且大小写不敏感", async () => {
    const store = createStore({ dataDir });
    await store.writeDay(day("2026-10-23"));

    expect(await store.search("OWNER/REPO")).toHaveLength(1);
  });

  it("跨天搜索", async () => {
    const store = createStore({ dataDir });
    await store.writeDay(day("2026-10-23"));
    await store.writeDay(day("2026-10-22"));

    const hits = await store.search("owner/repo");
    expect(hits.map((h) => h.date).sort()).toEqual(["2026-10-22", "2026-10-23"]);
  });

  it("空查询返回空数组", async () => {
    const store = createStore({ dataDir });
    await store.writeDay(day("2026-10-23"));
    expect(await store.search("   ")).toEqual([]);
  });

  it("limit 生效", async () => {
    const store = createStore({ dataDir });
    await store.writeDay(day("2026-10-23"));
    await store.writeDay(day("2026-10-22"));

    expect(await store.search("owner/repo", 1)).toHaveLength(1);
  });

  it("Twitter 分类要点也能搜到", async () => {
    const store = createStore({ dataDir });
    await store.writeDay(
      day("2026-10-23", {
        sections: [
          {
            key: "twitter",
            title: "Twitter 時間線（近48小時 · 分門別類總結）",
            kind: "categories",
            categories: [
              {
                title: "AI Models & Benchmarks",
                titleZh: "",
                items: [{ en: "@simonw benchmarked Qwen.", zh: "", url: "https://x.com/simonw" }],
              },
            ],
          },
        ],
      }),
    );

    const hits = await store.search("Qwen");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.section).toBe("Twitter 時間線（近48小時 · 分門別類總結）");
  });
});

describe("listDates", () => {
  it("返回倒序日期列表", async () => {
    const store = createStore({ dataDir });
    await store.writeDay(day("2026-10-21"));
    await store.writeDay(day("2026-10-23"));

    expect(await store.listDates()).toEqual(["2026-10-23", "2026-10-21"]);
  });

  it("空目录返回空数组", async () => {
    const store = createStore({ dataDir });
    expect(await store.listDates()).toEqual([]);
  });
});
