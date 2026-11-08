import { describe, expect, it } from "bun:test";
import { extractHnMeta, parseGithubMeta } from "../src/meta.ts";

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
