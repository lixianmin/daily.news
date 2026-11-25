import { describe, expect, it } from "bun:test";
import { parseTwitterRaw, renderTwitterRaw, type Tweet } from "../src/chrome/twitter.ts";

/** 一条推文样例。 */
const tweets: Tweet[] = [
  {
    name: "AGoldBull",
    handle: "@AGoldBull",
    time: "2026-11-08T01:00:00.000Z",
    text: "全网都看傻了。\n好莱坞编剧都不敢这么编的商战谍战大片。",
    links: null,
    url: "https://x.com/AGoldBull/status/2118923901447327963",
    replies: 58,
    reposts: 39,
    likes: 188,
    views: 100048,
  },
  {
    name: "宝玉",
    handle: "@dotey",
    time: "2026-11-08T02:00:00.000Z",
    text: "我猜测 Tibo 搞这个活动。",
    links: null,
    url: "https://x.com/dotey/status/2118992715488924001",
    replies: 12,
    reposts: 3,
    likes: 45,
    views: 1200,
  },
];

describe("parseTwitterRaw", () => {
  it("空输入返回空数组", () => {
    expect(parseTwitterRaw("")).toEqual([]);
    expect(parseTwitterRaw("just noise\nnothing here")).toEqual([]);
  });

  it("还原每条推文的作者、handle 与正文", () => {
    const parsed = parseTwitterRaw(renderTwitterRaw(tweets));
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.handle).toBe("@AGoldBull");
    expect(parsed[0]?.name).toBe("AGoldBull");
    expect(parsed[0]?.text).toContain("全网都看傻了。");
    expect(parsed[0]?.text).toContain("好莱坞编剧都不敢这么编的商战谍战大片。");
    expect(parsed[1]?.handle).toBe("@dotey");
  });

  it("推文直链取脚注区里的 status 链接（不是作者主页）", () => {
    const parsed = parseTwitterRaw(renderTwitterRaw(tweets));
    expect(parsed[0]?.url).toBe("https://x.com/AGoldBull/status/2118923901447327963");
    expect(parsed[1]?.url).toBe("https://x.com/dotey/status/2118992715488924001");
  });

  it("带序号，1 起", () => {
    const parsed = parseTwitterRaw(renderTwitterRaw(tweets));
    expect(parsed[0]?.id).toBe(1);
    expect(parsed[1]?.id).toBe(2);
  });

  it("正文行不以 ** 开头（还原抓取时加的前导空格）", () => {
    const raw = renderTwitterRaw([
      { ...tweets[0]!, text: "**重点**\n普通一行" },
    ]);
    const parsed = parseTwitterRaw(raw);
    expect(parsed[0]?.text).toBe("**重点**\n普通一行");
  });

  it("互动数行不算正文", () => {
    const parsed = parseTwitterRaw(renderTwitterRaw(tweets));
    expect(parsed[0]?.text).not.toContain("Replies");
    expect(parsed[0]?.text).not.toContain("views");
  });

  it("没有 status 链接时 url 为空", () => {
    const raw = [
      "**无名** @nobody [1]·2h [2]",
      "正文",
      "1 Replies 2 reposts 3 Likes 4 views",
      "",
      "[1] https://x.com/nobody",
    ].join("\n");
    const parsed = parseTwitterRaw(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.url).toBeUndefined();
  });

  it("正文为空的推文被丢掉", () => {
    const raw = [
      "**无名** @nobody [1]·2h [2]",
      "1 Replies 2 reposts 3 Likes 4 views",
      "",
      "[1] https://x.com/nobody",
      "[2] https://x.com/nobody/status/1",
    ].join("\n");
    expect(parseTwitterRaw(raw)).toEqual([]);
  });
});

describe("parseTwitterRaw：推文外链", () => {
  /** 一条带两条外链的推文。 */
  const withLinks: Tweet[] = [
    {
      ...tweets[0]!,
      text: "这条值得读：https://t.co/abc",
      links: ["https://t.co/abc", "https://t.co/def"],
    },
  ];

  it("外链写进脚注区，首行带引用组", () => {
    const raw = renderTwitterRaw(withLinks);
    expect(raw).toContain("https://t.co/abc");
    expect(raw).toContain("https://t.co/def");
    expect(raw.split("\n")[0]).toMatch(/\[\d+,\d+\]$/);
  });

  it("render → parse 往返后 articleUrls 一致", () => {
    const parsed = parseTwitterRaw(renderTwitterRaw(withLinks));
    expect(parsed[0]?.articleUrls).toEqual(["https://t.co/abc", "https://t.co/def"]);
  });

  it("没有外链时不写引用组，解析出来为空", () => {
    const raw = renderTwitterRaw(tweets);
    expect(raw.split("\n")[0]).not.toMatch(/\[\d+,\d+\]$/);
    expect(parseTwitterRaw(raw)[0]?.articleUrls ?? []).toEqual([]);
  });

  it("老格式（首行没有引用组）照样解析", () => {
    const raw = [
      "**AGoldBull** @AGoldBull [1]·18h [2]",
      "全网都看傻了。",
      "1 Replies 2 reposts 3 Likes 4 views",
      "",
      "[1] https://x.com/AGoldBull",
      "[2] https://x.com/AGoldBull/status/1",
    ].join("\n");
    const parsed = parseTwitterRaw(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.text).toBe("全网都看傻了。");
    expect(parsed[0]?.url).toBe("https://x.com/AGoldBull/status/1");
    expect(parsed[0]?.articleUrls ?? []).toEqual([]);
  });

  it("脚注里不是 http(s) 的链接被丢掉", () => {
    const raw = [
      "**AGoldBull** @AGoldBull [1]·18h [2] [3]",
      "正文",
      "",
      "[1] https://x.com/AGoldBull",
      "[2] https://x.com/AGoldBull/status/1",
      "[3] javascript:alert(1)",
    ].join("\n");
    expect(parseTwitterRaw(raw)[0]?.articleUrls ?? []).toEqual([]);
  });
});

describe("parseTwitterRaw：外链只留站外文章", () => {
  /** 首行引用组里挂着一串 X 自家的链接 + 一条 t.co。 */
  const raw = [
    "**AGoldBull** @AGoldBull [1]·18h [2] [3,4,5,6]",
    "正文",
    "",
    "[1] https://x.com/AGoldBull",
    "[2] https://x.com/AGoldBull/status/1",
    "[3] https://x.com/hashtag/AI?src=hashtag_click",
    "[4] https://x.com/dotey",
    "[5] https://x.com/dotey/status/999",
    "[6] https://t.co/abc",
  ].join("\n");

  it("hashtag / @mention / 引用推文的链接被丢掉，t.co 外链保留", () => {
    expect(parseTwitterRaw(raw)[0]?.articleUrls).toEqual(["https://t.co/abc"]);
  });

  it("www.x.com / mobile.twitter.com 这类变体也算 X 自家", () => {
    const variants = [
      "**A** @a [1]·1h [2] [3,4,5]",
      "正文",
      "",
      "[1] https://x.com/a",
      "[2] https://x.com/a/status/1",
      "[3] https://www.x.com/a",
      "[4] https://mobile.twitter.com/a/status/2",
      "[5] https://example.com/post",
    ].join("\n");
    expect(parseTwitterRaw(variants)[0]?.articleUrls).toEqual(["https://example.com/post"]);
  });

  it("正式外链（t.co / 直接域名）保留", () => {
    const raw = [
      "**A** @a [1]·1h [2] [3,4]",
      "正文",
      "",
      "[1] https://x.com/a",
      "[2] https://x.com/a/status/1",
      "[3] https://t.co/abc",
      "[4] https://example.com/2026/11/post",
    ].join("\n");
    expect(parseTwitterRaw(raw)[0]?.articleUrls).toEqual(["https://t.co/abc", "https://example.com/2026/11/post"]);
  });
});
