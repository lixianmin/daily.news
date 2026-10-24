import { describe, expect, it } from "bun:test";
import { extractHnMeta, extractTwitterLinks, parseGithubMeta } from "../src/meta.ts";

describe("parseGithubMeta", () => {
  it("从 GitHub Trending 行解析星数、语言、今日增量", () => {
    const line =
      "- **php/php-src** — The PHP Interpreter（⭐41,223 · C · ⬆️+287 today）  |  https://github.com/php/php-src";
    const meta = parseGithubMeta(line);
    expect(meta).not.toBeNull();
    expect(meta?.stars).toBe("41,223");
    expect(meta?.language).toBe("C");
    expect(meta?.todayStars).toBe("287");
  });

  it("缺星数时也能解析语言", () => {
    const line = "- **owner/repo** — A tool（Python）  |  https://github.com/owner/repo";
    const meta = parseGithubMeta(line);
    expect(meta?.language).toBe("Python");
    expect(meta?.stars).toBeUndefined();
  });

  it("行格式不对时返回 null", () => {
    expect(parseGithubMeta("随便一行文字")).toBeNull();
    expect(parseGithubMeta("")).toBeNull();
  });
});

describe("extractHnMeta", () => {
  it("从 HN 行解析 points 与评论数", () => {
    const line =
      "- **Quad9 (DNS Resolver) to Exit France** — (1027★ · 370則評論)  |  原文: https://quad9.net/x  |  討論: https://news.ycombinator.com/item?id=50195959";
    const meta = extractHnMeta(line);
    expect(meta?.points).toBe(1027);
    expect(meta?.comments).toBe(370);
  });

  it("解析不到时返回 null", () => {
    expect(extractHnMeta("- **Some Title** — no meta")).toBeNull();
  });
});

describe("extractTwitterLinks", () => {
  const raw = [
    "**lidang 立党 [1]** @lidangzzz [1]·Oct 22 [2]",
    "这是正文第一段。",
    "37 Replies 8 reposts 287 Likes 58111 views [3]",
    "---",
    "**宝玉 [4]** @dotey [4]·10h [5]",
    "我猜测 Tibo 搞这个活动。",
    "---",
    "[1] https://x.com/lidangzzz",
    "[2] https://x.com/lidangzzz/status/2113071390601458152",
    "[3] https://x.com/lidangzzz/status/2113071390601458152/analytics",
    "[4] https://x.com/dotey",
    "[5] https://x.com/dotey/status/2113299677785542772",
  ].join("\n");

  it("把 handle 映射到推文直链（不是主页）", () => {
    const links = extractTwitterLinks(raw);
    expect(links.get("lidangzzz")).toBe("https://x.com/lidangzzz/status/2113071390601458152");
    expect(links.get("dotey")).toBe("https://x.com/dotey/status/2113299677785542772");
  });

  it("analytics 链接被忽略", () => {
    const links = extractTwitterLinks(raw);
    for (const url of links.values()) {
      expect(url).not.toContain("/analytics");
    }
  });

  it("同一 handle 多次出现时取第一条推文", () => {
    const multi = [
      "**A [1]** @user [1]·1h [2]",
      "正文",
      "[1] https://x.com/user",
      "[2] https://x.com/user/status/111",
      "[3] https://x.com/user/status/222",
    ].join("\n");
    const links = extractTwitterLinks(multi);
    expect(links.get("user")).toBe("https://x.com/user/status/111");
  });

  it("图片等非 status 的脚注不被当推文链接", () => {
    const withImage = [
      "**A [1]** @user [1]·1h [2]",
      "正文",
      "[1] https://x.com/user",
      "[2] https://x.com/user/status/111",
      "[3] https://pbs.twimg.com/media/xxx.jpg",
    ].join("\n");
    const links = extractTwitterLinks(withImage);
    expect(links.get("user")).toBe("https://x.com/user/status/111");
  });

  it("空内容返回空 map", () => {
    expect(extractTwitterLinks("").size).toBe(0);
  });
});
