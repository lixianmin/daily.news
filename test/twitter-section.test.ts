import { describe, expect, it } from "bun:test";
import { assignTweets, buildTwitterChunk, buildTwitterSection } from "../src/twitter.ts";
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
