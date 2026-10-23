import { describe, expect, it } from "bun:test";
import { escapeHtml, renderDayPage, renderIndexPage } from "../src/render.ts";
import type { DigestDay, DigestIndex } from "../src/types.ts";

const index: DigestIndex = {
  updatedAt: "2026-10-23T07:10:00+08:00",
  days: [
    {
      date: "2026-10-23",
      weekday: "星期五",
      generatedAt: "2026-10-23T07:10:00+08:00",
      total: 72,
      counts: { twitter: 12, github: 20, hackernews: 20, zhihu: 20 },
      sourcesOk: 4,
      headlines: ["owner/repo", "other/lib"],
    },
    {
      date: "2026-10-22",
      weekday: "星期四",
      generatedAt: "2026-10-22T07:10:00+08:00",
      total: 38,
      counts: { github: 20, hackernews: 18 },
      sourcesOk: 2,
      headlines: ["old/repo"],
    },
  ],
};

const day: DigestDay = {
  date: "2026-10-23",
  weekday: "星期五",
  generatedAt: "2026-10-23T07:10:00+08:00",
  model: "deepseek/deepseek-flash",
  sources: {
    github: { ok: true, count: 1 },
    zhihu: { ok: false, count: 0, error: "抓取失败" },
  },
  sections: [
    {
      key: "twitter",
      title: "Twitter 時間線（近48小時 · 分門別類總結）",
      kind: "categories",
      categories: [
        {
          title: "AI Models & Benchmarks",
          titleZh: "AI 模型與基準",
          items: [
            { en: "1. @simonw benchmarked Qwen.", zh: "@simonw 測試了 Qwen。", url: "https://x.com/simonw" },
          ],
        },
      ],
    },
    {
      key: "github",
      title: "GitHub Trending（今日趨勢）",
      kind: "items",
      items: [
        { title: "owner/repo", url: "https://github.com/owner/repo", en: "A fast CLI for X.", zh: "一個快速的 CLI。" },
      ],
    },
  ],
};

describe("escapeHtml", () => {
  it("转义尖括号引号与 &", () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
    );
    expect(escapeHtml("a & b")).toBe("a &amp; b");
    expect(escapeHtml("it's")).toBe("it&#39;s");
  });

  it("普通文本不变", () => {
    expect(escapeHtml("owner/repo")).toBe("owner/repo");
  });
});

describe("renderIndexPage", () => {
  it("列出所有日期并链接到详情页", () => {
    const html = renderIndexPage(index);
    expect(html).toContain("2026-10-23");
    expect(html).toContain("2026-10-22");
    expect(html).toContain('href="/d/2026-10-23"');
    expect(html).toContain('href="/d/2026-10-22"');
  });

  it("显示星期与条数", () => {
    const html = renderIndexPage(index);
    expect(html).toContain("星期五");
    expect(html).toContain("72");
  });

  it("来源不全时给出提示", () => {
    const html = renderIndexPage(index);
    // 10-22 只有 2/4 个来源
    expect(html).toMatch(/2\s*\/\s*4|2 个来源|缺/);
  });

  it("首页有搜索框与重新生成按钮", () => {
    const html = renderIndexPage(index);
    expect(html).toContain('id="q"');
    expect(html).toContain("重新生成");
  });

  it("空索引给出空状态文案", () => {
    const html = renderIndexPage({ updatedAt: "", days: [] });
    expect(html).toContain("暂无");
  });

  it("转义 headlines 里的危险字符", () => {
    const evil: DigestIndex = {
      updatedAt: "",
      days: [
        {
          date: "2026-10-23",
          weekday: "星期五",
          generatedAt: "",
          total: 1,
          counts: {},
          sourcesOk: 0,
          headlines: ['<img src=x onerror="alert(1)">'],
        },
      ],
    };
    const html = renderIndexPage(evil);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });
});

describe("renderDayPage", () => {
  it("渲染章节标题", () => {
    const html = renderDayPage(day);
    expect(html).toContain("Twitter 時間線");
    expect(html).toContain("GitHub Trending");
  });

  it("items 条目渲染为可点击链接", () => {
    const html = renderDayPage(day);
    expect(html).toContain('href="https://github.com/owner/repo"');
    expect(html).toContain("A fast CLI for X.");
    expect(html).toContain("一個快速的 CLI。");
  });

  it("categories 渲染分类标题（英文 + 繁中）与要点", () => {
    const html = renderDayPage(day);
    expect(html).toContain("AI Models &amp; Benchmarks");
    expect(html).toContain("AI 模型與基準");
    expect(html).toContain("@simonw benchmarked Qwen.");
    expect(html).toContain("@simonw 測試了 Qwen。");
  });

  it("失败来源显示警告", () => {
    const html = renderDayPage(day);
    expect(html).toContain("知乎");
    expect(html).toMatch(/⚠️|告警|失败/);
  });

  it("显示模型与生成时间", () => {
    const html = renderDayPage(day);
    expect(html).toContain("deepseek/deepseek-flash");
  });

  it("转义不含链接的条目内容", () => {
    const evil: DigestDay = {
      ...day,
      sections: [
        {
          key: "github",
          title: "GitHub Trending（今日趨勢）",
          kind: "items",
          items: [{ title: '<script>bad()</script>', en: "<b>bold</b>", zh: "" }],
        },
      ],
    };
    const html = renderDayPage(evil);
    expect(html).not.toContain("<script>bad()");
    expect(html).toContain("&lt;script&gt;");
  });

  it("zh 为空时只渲染英文，不留空行", () => {
    const partial: DigestDay = {
      ...day,
      sections: [
        {
          key: "github",
          title: "GitHub Trending（今日趨勢）",
          kind: "items",
          items: [{ title: "a/b", en: "Only English here.", zh: "" }],
        },
      ],
    };
    const html = renderDayPage(partial);
    expect(html).toContain("Only English here.");
    expect(html).not.toContain('class="zh"');
  });

  it("有前后日导航", () => {
    const html = renderDayPage(day, { newer: "2026-10-24", older: "2026-10-22" });
    expect(html).toContain('href="/d/2026-10-24"');
    expect(html).toContain('href="/d/2026-10-22"');
  });

  it("包含返回首页链接", () => {
    expect(renderDayPage(day)).toContain('href="/"');
  });
});
