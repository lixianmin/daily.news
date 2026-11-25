import { describe, expect, it } from "bun:test";
import { assignTweets, buildTwitterChunk, buildTwitterSection, expandTweets } from "../src/twitter.ts";
import type { ArticleOutcome } from "../src/article.ts";
import type { RawTweet } from "../src/chrome/twitter.ts";
import type { TargetLang, Translator } from "../src/translate.ts";

/** 两条推文。 */
const tweets: RawTweet[] = [
  {
    id: 1,
    name: "AGoldBull",
    handle: "@AGoldBull",
    time: "18h",
    text: "全网都看傻了。",
    url: "https://x.com/AGoldBull/status/111",
  },
  {
    id: 2,
    name: "宝玉",
    handle: "@dotey",
    time: "10h",
    text: "我猜测 Tibo 搞这个活动。",
    url: "https://x.com/dotey/status/222",
  },
];

/** 假翻译器：按目标语言加前缀（一次一批）。 */
const fakeTranslator: Translator = async (texts: string[], target: TargetLang) =>
  texts.map((text) => `[${target}]${text}`);

describe("buildTwitterChunk", () => {
  it("每条推文带 id 与 handle", () => {
    const chunk = buildTwitterChunk(tweets);
    expect(chunk).toContain('id="1"');
    expect(chunk).toContain('id="2"');
    expect(chunk).toContain('@AGoldBull');
    expect(chunk).toContain('@dotey');
  });

  it("保留正文（模型要靠正文分主题）", () => {
    const chunk = buildTwitterChunk(tweets);
    expect(chunk).toContain("全网都看傻了。");
    expect(chunk).toContain("<tweet");
  });

  it("空输入返回空串", () => {
    expect(buildTwitterChunk([])).toBe("");
  });
});

describe("assignTweets", () => {
  it("按编号把推文分到分类", () => {
    const assignments = assignTweets(tweets, [
      { title: "AI Models", tweetIds: [1] },
      { title: "Open Source", tweetIds: [2] },
    ]);
    expect(assignments).toHaveLength(2);
    expect(assignments[0]?.tweets[0]?.id).toBe(1);
    expect(assignments[1]?.tweets[0]?.id).toBe(2);
  });

  it("模型漏掉的推文进兜底分类，一条不丢", () => {
    const assignments = assignTweets(tweets, [{ title: "AI Models", tweetIds: [1] }]);
    expect(assignments).toHaveLength(2);
    expect(assignments[1]?.tweets.map((t) => t.id)).toEqual([2]);
  });

  it("模型分不了主题时全部进兜底分类", () => {
    const assignments = assignTweets(tweets, undefined);
    expect(assignments).toHaveLength(1);
    expect(assignments[0]?.tweets).toHaveLength(2);
  });

  it("编号不存在的推文被忽略", () => {
    const assignments = assignTweets(tweets, [{ title: "x", tweetIds: [99] }]);
    expect(assignments).toHaveLength(1);
    expect(assignments[0]?.tweets).toHaveLength(2);
  });
});

describe("buildTwitterSection", () => {
  it("每条要点带推文直链与作者 handle", async () => {
    const section = await buildTwitterSection({
      tweets,
      translator: fakeTranslator,
      categorize: async () => [{ title: "AI Models", tweetIds: [1, 2] }],
    });

    expect(section.kind).toBe("categories");
    if (section.kind !== "categories") {
      return;
    }
    const item = section.categories[0]?.items[0];
    expect(item?.url).toBe("https://x.com/AGoldBull/status/111");
    expect(item?.handle).toBe("@AGoldBull");
    expect(item?.time).toBe("18h");
  });

  it("正文是翻译结果，不是模型总结", async () => {
    const section = await buildTwitterSection({
      tweets,
      translator: fakeTranslator,
      categorize: async () => [{ title: "AI Models", tweetIds: [1, 2] }],
    });

    if (section.kind !== "categories") {
      return;
    }
    const item = section.categories[0]?.items[0];
    expect(item?.en).toBe("[en]全网都看傻了。");
    expect(item?.zh).toBe("[zh-TW]全网都看傻了。");
  });

  it("模型分不了主题时照样出章节", async () => {
    const section = await buildTwitterSection({
      tweets,
      translator: fakeTranslator,
      categorize: async () => undefined,
    });

    expect(section.kind).toBe("categories");
    if (section.kind !== "categories") {
      return;
    }
    expect(section.categories).toHaveLength(1);
    expect(section.categories[0]?.items).toHaveLength(2);
  });
});

describe("buildTwitterChunk：600 字只是给模型分主题的窗口", () => {
  it("只把前 600 字喂给分类模型", async () => {
    const { CATEGORIZE_PREVIEW_CHARS } = await import("../src/twitter.ts");
    const long = "x".repeat(1_000);
    const chunk = buildTwitterChunk([{ ...tweets[0]!, text: long }]);
    expect(chunk).toContain("x".repeat(CATEGORIZE_PREVIEW_CHARS));
    expect(chunk).not.toContain("x".repeat(CATEGORIZE_PREVIEW_CHARS + 1));
  });
});

describe("正文不截断", () => {
  it("1000+ 字的推文进翻译器时长度不变", async () => {
    const long = "长".repeat(1_200);
    const seen: string[] = [];
    const translator: Translator = async (texts: string[], target: TargetLang) => {
      seen.push(...texts);
      return texts.map((text) => `[${target}]${text}`);
    };

    const section = await buildTwitterSection({
      tweets: [{ ...tweets[0]!, text: long }],
      translator,
      categorize: async () => [{ title: "Long", tweetIds: [1] }],
    });

    expect(seen).toContain(long);
    expect(seen.find((text) => text.includes("长"))?.length).toBe(long.length);
  });
});

/** 假文章抓取：按 url 查表，记录调用顺序。 */
function fakeArticles(table: Record<string, string> = {}) {
  const calls: string[] = [];
  return {
    calls,
    fetchArticle: async (url: string): Promise<ArticleOutcome> => {
      calls.push(url);
      const text = table[url];
      if (text === undefined) {
        return { ok: false, reason: "404" };
      }
      return { ok: true, url, text };
    },
  };
}

describe("expandTweets", () => {
  const linked: RawTweet = {
    ...tweets[0]!,
    text: "这条值得读。",
    articleUrls: ["https://t.co/abc"],
  };

  it("正文 = 推文正文 + 空行 + 文章全文", async () => {
    const { fetchArticle } = fakeArticles({ "https://t.co/abc": "文章第一段。\n文章第二段。" });
    const [expanded] = await expandTweets([linked], { fetchArticle });

    expect(expanded?.text).toBe("这条值得读。\n\n文章第一段。\n文章第二段。");
    expect(expanded?.id).toBe(linked.id);
    expect(expanded?.url).toBe(linked.url);
  });

  it("抓不到时退回推文原文", async () => {
    const { fetchArticle } = fakeArticles();
    const [expanded] = await expandTweets([linked], { fetchArticle });
    expect(expanded?.text).toBe("这条值得读。");
  });

  it("只取第一条抓成功的链接", async () => {
    const { calls, fetchArticle } = fakeArticles({
      "https://t.co/b": "B 的文章全文。",
      "https://t.co/c": "C 的文章全文。",
    });
    const tweet: RawTweet = { ...linked, articleUrls: ["https://t.co/a", "https://t.co/b", "https://t.co/c"] };
    const [expanded] = await expandTweets([tweet], { fetchArticle });

    expect(calls).toEqual(["https://t.co/a", "https://t.co/b"]);
    expect(expanded?.text).toBe("这条值得读。\n\nB 的文章全文。");
  });

  it("一条推文挂一串链时最多试 3 条", async () => {
    const { calls, fetchArticle } = fakeArticles();
    const tweet: RawTweet = {
      ...linked,
      articleUrls: ["https://t.co/1", "https://t.co/2", "https://t.co/3", "https://t.co/4"],
    };
    await expandTweets([tweet], { fetchArticle });
    expect(calls).toHaveLength(3);
  });

  it("没有外链的推文不发请求", async () => {
    const { calls, fetchArticle } = fakeArticles();
    const result = await expandTweets(tweets, { fetchArticle });
    expect(calls).toEqual([]);
    expect(result.map((tweet) => tweet.text)).toEqual(tweets.map((tweet) => tweet.text));
  });

  it("并发不超过 3", async () => {
    let inFlight = 0;
    let peak = 0;
    const slow = async (url: string): Promise<ArticleOutcome> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return { ok: true, url, text: "慢文章正文。" };
    };
    const many: RawTweet[] = Array.from({ length: 7 }, (_, index) => ({
      ...linked,
      id: index + 1,
      articleUrls: [`https://t.co/slow${index}`],
    }));

    await expandTweets(many, { fetchArticle: slow });
    expect(peak).toBe(3);
  });
});

describe("buildTwitterSection：正文带上外链文章", () => {
  it("英文列含文章全文，繁中列是它的译文", async () => {
    const article = "The full article body. ".repeat(60).trim();
    const { fetchArticle } = fakeArticles({ "https://t.co/abc": article });
    const seen: string[] = [];
    const translator: Translator = async (texts: string[], target: TargetLang) => {
      seen.push(...texts);
      return texts.map((text) => `[${target}]${text}`);
    };

    const section = await buildTwitterSection({
      tweets: [{ ...tweets[1]!, text: "Read this thread.", articleUrls: ["https://t.co/abc"] }],
      translator,
      categorize: async () => [{ title: "Long Reads", tweetIds: [2] }],
      expand: { fetchArticle },
    });

    if (section.kind !== "categories") {
      return;
    }
    const item = section.categories[0]?.items[0];
    const expected = `Read this thread.\n\n${article}`;
    expect(item?.en).toBe(expected);
    expect(item?.zh).toBe(`[zh-TW]${expected}`);
    expect(seen).toContain(expected);
  });
});
