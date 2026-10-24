import { describe, expect, it } from "bun:test";
import { enrichSection, limitSectionItems } from "../src/enrich.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { DigestSection } from "../src/types.ts";

let runsDir: string;

async function setup(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "daily-news-enrich-"));
  runsDir = join(dir, "runs", "2026-10-23");
  await mkdir(runsDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(runsDir, name), content, "utf8");
  }
  return dir;
}

describe("enrichSection：GitHub 元信息", () => {
  it("按标题回填星数、语言、今日增量", async () => {
    const dir = await setup({
      "gh.md": [
        "- **owner/repo** — A tool（⭐41,223 · C · ⬆️+287 today）  |  https://github.com/owner/repo",
        "- **other/lib** — Another（Python）  |  https://github.com/other/lib",
      ].join("\n"),
    });

    const section: DigestSection = {
      key: "github",
      title: "GitHub Trending（今日趨勢）",
      kind: "items",
      items: [
        { title: "owner/repo", en: "A tool.", zh: "", url: "https://github.com/owner/repo" },
        { title: "other/lib", en: "Another.", zh: "", url: "https://github.com/other/lib" },
      ],
    };

    const result = await enrichSection(section, { runsDir, date: "2026-10-23" });
    expect(result.kind).toBe("items");
    if (result.kind !== "items") {
      return;
    }

    const first = result.items[0]!;
    expect(first.meta).toEqual({
      source: "github",
      github: { stars: "41,223", language: "C", todayStars: "287" },
    });
    expect(result.items[1]?.meta?.source).toBe("github");
    await rm(dir, { recursive: true, force: true });
  });
});

describe("enrichSection：Hacker News 元信息与去重", () => {
  const hnMd = [
    "- **Quad9 to Exit France** — (1027★ · 370則評論)  |  原文: https://quad9.net/x  |  討論: https://news.ycombinator.com/item?id=1",
  ].join("\n");

  it("回填 points 与 comments，并加讨论页链接", async () => {
    const dir = await setup({ "hn.md": hnMd });
    const section: DigestSection = {
      key: "hackernews",
      title: "Hacker News",
      kind: "items",
      items: [{ title: "Quad9 to Exit France", en: "The resolver is leaving France.", zh: "", url: "https://quad9.net/x" }],
    };

    const result = await enrichSection(section, { runsDir, date: "2026-10-23" });
    if (result.kind !== "items") {
      return;
    }

    expect(result.items[0]?.meta).toEqual({
      source: "hackernews",
      hn: { points: 1027, comments: 370 },
    });
    expect(result.items[0]?.extraLinks?.[0]?.label).toBe("讨论");
    await rm(dir, { recursive: true, force: true });
  });

  it("剥掉摘要里重复的 points 与 comments", async () => {
    const dir = await setup({ "hn.md": hnMd });
    const section: DigestSection = {
      key: "hackernews",
      title: "Hacker News",
      kind: "items",
      items: [
        {
          title: "Quad9 to Exit France",
          en: "The resolver is leaving France after data-retention pressure; 1027 points and 370 comments on HN.",
          zh: "",
          url: "https://quad9.net/x",
        },
      ],
    };

    const result = await enrichSection(section, { runsDir, date: "2026-10-23" });
    if (result.kind !== "items") {
      return;
    }

    const en = result.items[0]!.en;
    expect(en).not.toContain("1027");
    expect(en).not.toContain("370");
    expect(en).toContain("leaving France");
    await rm(dir, { recursive: true, force: true });
  });

  it("去重后不留多余标点", async () => {
    const dir = await setup({ "hn.md": hnMd });
    const section: DigestSection = {
      key: "hackernews",
      title: "Hacker News",
      kind: "items",
      items: [
        {
          title: "Quad9 to Exit France",
          en: "The resolver is leaving France, 1027 points and 370 comments.",
          zh: "",
          url: "https://quad9.net/x",
        },
      ],
    };

    const result = await enrichSection(section, { runsDir, date: "2026-10-23" });
    if (result.kind !== "items") {
      return;
    }
    expect(result.items[0]!.en).toBe("The resolver is leaving France");
    await rm(dir, { recursive: true, force: true });
  });

  it("没有元信息的摘要不动", async () => {
    const dir = await setup({ "hn.md": hnMd });
    const section: DigestSection = {
      key: "hackernews",
      title: "Hacker News",
      kind: "items",
      items: [{ title: "Unknown Title", en: "Some summary with 5 points mentioned.", zh: "", url: "https://x.test" }],
    };

    const result = await enrichSection(section, { runsDir, date: "2026-10-23" });
    if (result.kind !== "items") {
      return;
    }
    expect(result.items[0]!.en).toBe("Some summary with 5 points mentioned.");
    await rm(dir, { recursive: true, force: true });
  });
});

describe("enrichSection：Twitter 推文直链", () => {
  it("把作者主页换成推文直链", async () => {
    const dir = await setup({
      "twitter_raw.txt": [
        "**某推 [1]** @simonw [1]·1h [2]",
        "正文",
        "[1] https://x.com/simonw",
        "[2] https://x.com/simonw/status/2113071390601458152",
      ].join("\n"),
    });

    const section: DigestSection = {
      key: "twitter",
      title: "Twitter",
      kind: "categories",
      categories: [
        {
          title: "AI",
          titleZh: "",
          items: [{ en: "1. @simonw said something.", zh: "", url: "https://x.com/simonw" }],
        },
      ],
    };

    const result = await enrichSection(section, { runsDir, date: "2026-10-23" });
    if (result.kind !== "categories") {
      return;
    }
    expect(result.categories[0]?.items[0]?.url).toBe("https://x.com/simonw/status/2113071390601458152");
    await rm(dir, { recursive: true, force: true });
  });

  it("原始数据里没有直链时保留主页", async () => {
    const dir = await setup({ "twitter_raw.txt": "没有脚注区" });
    const section: DigestSection = {
      key: "twitter",
      title: "Twitter",
      kind: "categories",
      categories: [{ title: "AI", titleZh: "", items: [{ en: "1. @simonw said something.", zh: "", url: "https://x.com/simonw" }] }],
    };

    const result = await enrichSection(section, { runsDir, date: "2026-10-23" });
    if (result.kind !== "categories") {
      return;
    }
    expect(result.categories[0]?.items[0]?.url).toBe("https://x.com/simonw");
    await rm(dir, { recursive: true, force: true });
  });
});

describe("enrichSection：缺原始数据", () => {
  it("没有 gh.md 时不报错，meta 留空", async () => {
    const dir = await setup({});
    const section: DigestSection = {
      key: "github",
      title: "GitHub",
      kind: "items",
      items: [{ title: "owner/repo", en: "A tool.", zh: "", url: "https://github.com/owner/repo" }],
    };

    const result = await enrichSection(section, { runsDir, date: "2026-10-23" });
    if (result.kind !== "items") {
      return;
    }
    expect(result.items[0]?.meta).toBeUndefined();
    await rm(dir, { recursive: true, force: true });
  });
});

describe("limitSectionItems", () => {
  const item = (title: string) => ({
    title,
    en: "Some summary.",
    zh: "某摘要。",
    url: "https://example.com/x",
  });

  it("超过上限时截断到 10 条", () => {
    const items = Array.from({ length: 25 }, (_, i) => item(`item-${i}`));
    const section = {
      key: "github" as const,
      title: "GitHub Trending",
      kind: "items" as const,
      items,
    };
    const limited = limitSectionItems(section);
    expect(limited.kind).toBe("items");
    if (limited.kind !== "items") {
      return;
    }
    expect(limited.items.length).toBe(10);
    // 保留的是前 10 条，顺序不变
    expect(limited.items[0]?.title).toBe("item-0");
    expect(limited.items[9]?.title).toBe("item-9");
  });

  it("不足上限时原样返回", () => {
    const section = {
      key: "zhihu" as const,
      title: "知乎熱榜",
      kind: "items" as const,
      items: [item("a"), item("b")],
    };
    const limited = limitSectionItems(section);
    if (limited.kind !== "items") {
      throw new Error("kind changed");
    }
    expect(limited.items.length).toBe(2);
  });

  it("不碰 Twitter 的分类结构", () => {
    // Twitter 是分主题归纳，不是逐条列表，不受条数限制
    const section = {
      key: "twitter" as const,
      title: "Twitter",
      kind: "categories" as const,
      categories: [
        { title: "AI", titleZh: "AI", items: [{ en: "a", zh: "b" }] },
      ],
    };
    const limited = limitSectionItems(section);
    expect(limited.kind).toBe("categories");
  });
});
