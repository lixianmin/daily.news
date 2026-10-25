import { describe, expect, it } from "bun:test";
import { escapeHtml, renderDayPage, renderIndexPage, renderSearchHits } from "../src/render.ts";
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
            {
              en: "1. @simonw benchmarked Qwen and reported a 90% score on the new benchmark.",
              zh: "1. @simonw 測試了 Qwen，在新基準上拿到 90%。",
              url: "https://x.com/simonw/status/123",
            },
          ],
        },
      ],
    },
    {
      key: "github",
      title: "GitHub Trending（今日趨勢）",
      kind: "items",
      items: [
        {
          title: "owner/repo",
          url: "https://github.com/owner/repo",
          en: "A fast CLI for X that runs entirely in your terminal.",
          zh: "一個完全在终端里运行的 X 快速 CLI。",
          meta: { source: "github", github: { stars: "41,223", language: "C", todayStars: "287" } },
        },
      ],
    },
    {
      key: "hackernews",
      title: "Hacker News（過去24小時熱點）",
      kind: "items",
      items: [
        {
          title: "Quad9 to Exit France",
          url: "https://quad9.net/news/blog/au-revoir-france/",
          en: "The DNS resolver is leaving France after years of local regulation pressure.",
          zh: "这家 DNS 解析器在多年本地监管压力后离开法国。",
          meta: { source: "hackernews", hn: { points: 1027, comments: 370 } },
          extraLinks: [{ label: "讨论", url: "https://news.ycombinator.com/item?id=50195959" }],
        },
      ],
    },
  ],
};

describe("escapeHtml", () => {
  it("转义尖括号引号与 &", () => {
    const out = escapeHtml('<script>alert("x")</script> & more');
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("<");
    expect(out).not.toContain(">");
    expect(out).not.toContain('"');
    // 转义后仍是可读文本：实体名保留，但不含裸尖括号
    expect(out).toContain("lt;");
    expect(out).toContain("gt;");
    expect(out).toContain("quot;");
    expect(out).toContain("amp;");
  });

  it("普通文本不变", () => {
    expect(escapeHtml("owner/repo")).toBe("owner/repo");
  });
});

describe("renderIndexPage：侧边栏", () => {
  it("侧边栏列出历史日期", () => {
    const html = renderIndexPage(index);
    expect(html).toContain('class="sidebar"');
    expect(html).toContain("/d/2026-10-23");
    expect(html).toContain("/d/2026-10-22");
  });

  it("侧边栏有 History 分组", () => {
    const html = renderIndexPage(index, "2026-10-23");
    expect(html).toContain("History");
  });

  it("详情页的侧边栏列出本日章节并带锚点", () => {
    const html = renderDayPage(day, {}, index.days, "2026-10-23");
    expect(html).toContain('href="#sec-github"');
    expect(html).toContain('href="#sec-twitter"');
    expect(html).toContain("data-spy=");
  });

  it("左上角品牌区是指向主页的链接", () => {
    const html = renderIndexPage(index);
    expect(html).toContain('<a class="brand" href="/"');
  });

  it("详情页左上角品牌区同样指向主页", () => {
    const html = renderDayPage(day, {}, index.days, "2026-10-23");
    expect(html).toContain('<a class="brand" href="/"');
  });
});

describe("renderIndexPage：日期列表", () => {
  it("列出所有日期并链接到详情页", () => {
    const html = renderIndexPage(index);
    expect(html).toContain("2026-10-23");
    expect(html).toContain('href="/d/2026-10-22"');
  });

  it("显示条数与各来源计数", () => {
    const html = renderIndexPage(index);
    expect(html).toContain("72");
    expect(html).toContain("items");
    expect(html).toContain("GitHub 20");
  });

  it("今天带 TODAY 标记", () => {
    const html = renderIndexPage(index, "2026-10-23");
    expect(html).toContain("TODAY");
  });

  it("首页有搜索框与重新生成按钮", () => {
    const html = renderIndexPage(index);
    expect(html).toContain("data-search");
    expect(html).toContain("重新生成");
  });

  it("首页有可拖动的浮动目录", () => {
    const html = renderIndexPage(index);
    expect(html).toContain('id="tocFab"');
    expect(html).toContain('id="tocFloat"');
    expect(html).toContain('id="tocHead"');
    // 浮动目录里也要有历史日期链接
    expect(html).toContain('class="toc-link');
  });

  it("空索引给出空状态文案", () => {
    const html = renderIndexPage({ updatedAt: "", days: [] });
    expect(html).toContain("还没有任何数据");
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
    expect(html).toContain("lt;img src=x");
  });
});

describe("renderDayPage：卡片", () => {
  it("条目渲染为卡片，含标题与摘要", () => {
    const html = renderDayPage(day);
    expect(html).toContain('class="card"');
    expect(html).toContain("owner/repo");
    expect(html).toContain("A fast CLI for X");
  });

  it("标题链接到原始地址", () => {
    const html = renderDayPage(day);
    expect(html).toContain('href="https://github.com/owner/repo"');
  });

  it("有明确的「原文」按钮", () => {
    const html = renderDayPage(day);
    expect(html).toContain("原文");
    expect(html).toContain('class="link-btn"');
  });

  it("GitHub 元信息渲染成 chip", () => {
    const html = renderDayPage(day);
    expect(html).toContain("41,223");
    expect(html).toContain("C");
    expect(html).toContain("+287 today");
  });

  it("Hacker News 元信息渲染成 chip", () => {
    const html = renderDayPage(day);
    expect(html).toContain("1027 points");
    expect(html).toContain("370 comments");
  });

  it("HN 的讨论页作为附加链接", () => {
    const html = renderDayPage(day);
    expect(html).toContain("https://news.ycombinator.com/item?id=50195959");
    expect(html).toContain("讨论");
  });

  it("长摘要默认夹两行并带展开按钮", () => {
    const long = "A very long summary. ".repeat(20);
    const longDay: DigestDay = {
      ...day,
      sections: [
        {
          key: "github",
          title: "GitHub Trending（今日趨勢）",
          kind: "items",
          items: [{ title: "a/b", en: long, zh: "", url: "https://github.com/a/b" }],
        },
      ],
    };
    const html = renderDayPage(longDay);
    expect(html).toContain("clamp");
    expect(html).toContain("More");
  });

  it("短摘要不显示展开按钮", () => {
    const html = renderDayPage(day);
    expect(html).not.toContain("More ▾");
  });

  it("Twitter 要点里的 handle 变成链接", () => {
    const html = renderDayPage(day);
    expect(html).toContain('href="https://x.com/simonw/status/123"');
    expect(html).toContain("@simonw");
  });

  it("来源标签出现在每张卡片上", () => {
    const html = renderDayPage(day);
    expect(html).toContain('class="src src-github"');
    expect(html).toContain(">GitHub<");
    expect(html).toContain('class="src src-hackernews"');
  });

  it("中英左右两列：英文在左、繁中在右", () => {
    const html = renderDayPage(day);
    expect(html).toContain('class="duo"');
    expect(html).toContain('class="sum en"');
    expect(html).toContain('class="sum zh"');
    // 繁中内容确实被渲染出来了
    expect(html).toContain("一個完全在终端里运行的 X 快速 CLI。");
  });

  it("Twitter 分类标题也有中英对照", () => {
    const html = renderDayPage(day);
    expect(html).toContain("AI 模型與基準");
  });

  it("失败来源显示警告", () => {
    const html = renderDayPage(day);
    expect(html).toContain("知乎");
    expect(html).toContain("本次未成功");
  });

  it("显示模型与生成时间", () => {
    const html = renderDayPage(day);
    expect(html).toContain("deepseek/deepseek-flash");
  });

  it("有前后日导航与返回列表", () => {
    const html = renderDayPage(day, { newer: "2026-10-24", older: "2026-10-22" });
    expect(html).toContain('href="/d/2026-10-24"');
    expect(html).toContain('href="/d/2026-10-22"');
    expect(html).toContain('href="/"');
  });

  it("Twitter 要点也标来源", () => {
    // Twitter 走分类列表而不是 renderItemCard，不标来源就跟其它章节不一致
    const html = renderDayPage(day);
    const twitter = html.slice(html.indexOf("sec-twitter"));
    expect(twitter).toContain("src-twitter");
    expect(twitter).toContain("Twitter");
  });

  it("有可拖动的浮动目录", () => {
    const html = renderDayPage(day);
    expect(html).toContain('id="tocFab"');
    expect(html).toContain('id="tocFloat"');
    expect(html).toContain('id="tocHead"');
    // 章节锚点
    expect(html).toContain('href="#sec-');
  });

  it("非当天的页面不显示重新生成按钮", () => {
    // 昨天的内容已经定稿，再生成没意义
    const html = renderDayPage(day, {}, [], "2026-10-24");
    expect(html).not.toContain('id="regen"');
  });

  it("当天的页面显示重新生成按钮", () => {
    const html = renderDayPage(day, {}, [], "2026-10-23");
    expect(html).toContain('id="regen"');
  });
});

describe("renderSearchHits", () => {
  it("渲染命中并带链接", () => {
    const html = renderSearchHits([
      { date: "2026-10-23", section: "GitHub", title: "owner/repo", en: "A fast CLI.", url: "https://github.com/owner/repo" },
    ]);
    expect(html).toContain("owner/repo");
    expect(html).toContain('href="https://github.com/owner/repo"');
    expect(html).toContain("A fast CLI.");
  });

  it("空结果显示提示", () => {
    expect(renderSearchHits([])).toContain("没有匹配的结果");
  });
});
