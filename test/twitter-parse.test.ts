import { describe, expect, it } from "bun:test";
import { parseTwitterRaw, renderTwitterRaw, type Tweet } from "../src/chrome/twitter.ts";

/** 一条推文样例。 */
const tweets: Tweet[] = [
  {
    name: "AGoldBull",
    handle: "@AGoldBull",
    time: "2026-11-08T01:00:00.000Z",
    text: "全网都看傻了。\n好莱坞编剧都不敢这么编的商战谍战大片。",
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
