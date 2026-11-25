import { describe, expect, it } from "bun:test";
import { fetchArticleText, MIN_ARTICLE_CHARS } from "../src/article.ts";

/** 假响应：状态 + content-type + 正文。 */
function htmlResponse(body: string, contentType = "text/html; charset=utf-8", status = 200): Response {
  return new Response(body, { status, headers: { "content-type": contentType } });
}

/** 一段够长的正文（超过 400 字下限）。 */
const ARTICLE_BODY = "这是文章的第一段，讲的是模型把长文读完之后如何回到原文。".repeat(20);

/** 一页接近真实站点的 HTML：导航与脚本要剔掉，正文要留下。 */
const PAGE = [
  "<!doctype html>",
  "<html><head><title>标题</title><style>.x{color:red}</style></head>",
  "<body>",
  "<nav>首页 / 科技 / 关于我们</nav>",
  "<header>站点头部</header>",
  "<script>window.__DATA__ = {secret: 1};</script>",
  "<noscript>请开启 JS</noscript>",
  `<article><h1>标题</h1><p>${ARTICLE_BODY}</p><p>第二段 &amp; 结尾&hellip;</p></article>`,
  "<footer>版权所有</footer>",
  "<form><input value=\"搜索\"></form>",
  "</body></html>",
].join("\n");

describe("fetchArticleText", () => {
  it("抓 HTML 并抽出纯文本，剔掉脚本与导航", async () => {
    const outcome = await fetchArticleText("https://example.com/post", {
      fetch: async () => htmlResponse(PAGE),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.url).toBe("https://example.com/post");
    expect(outcome.text).toContain("这是文章的第一段");
    expect(outcome.text).toContain("第二段 & 结尾…");
    expect(outcome.text).not.toContain("secret");
    expect(outcome.text).not.toContain("首页 / 科技");
    expect(outcome.text).not.toContain("版权所有");
    expect(outcome.text).not.toContain("<p>");
  });

  it("用桌面 Chrome 的 UA 请求（很多站点靠 UA 决定给不给正文）", async () => {
    let sentUa = "";
    await fetchArticleText("https://example.com/post", {
      fetch: async (_input, init) => {
        sentUa = new Headers(init?.headers).get("user-agent") ?? "";
        return htmlResponse(PAGE);
      },
    });

    expect(sentUa).toContain("Macintosh");
    expect(sentUa).toContain("Chrome");
  });

  it("非 text/html 判失败（PDF / JSON）", async () => {
    const outcome = await fetchArticleText("https://example.com/a.pdf", {
      fetch: async () => htmlResponse("%PDF-1.7", "application/pdf"),
    });
    expect(outcome.ok).toBe(false);
  });

  it("非 2xx 判失败", async () => {
    const outcome = await fetchArticleText("https://example.com/gone", {
      fetch: async () => htmlResponse(PAGE, "text/html", 404),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.reason).toContain("404");
  });

  it("网络错误不抛，返回失败", async () => {
    const outcome = await fetchArticleText("https://example.com/boom", {
      fetch: async () => {
        throw new Error("ECONNRESET");
      },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.reason).toContain("ECONNRESET");
  });

  it("抽出来短于下限判失败（登录墙 / JS 壳）", async () => {
    const thin = `<html><body><div>请登录后查看全文</div></body></html>`;
    expect("请登录后查看全文".length).toBeLessThan(MIN_ARTICLE_CHARS);
    const outcome = await fetchArticleText("https://example.com/wall", {
      fetch: async () => htmlResponse(thin),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.reason).toContain("太短");
  });

  it("响应体超过 5MB 判失败（不是截断：抓不到就退回推文原文）", async () => {
    const huge = `<html><body><p>${"a".repeat(5 * 1024 * 1024 + 1)}</p></body></html>`;
    const outcome = await fetchArticleText("https://example.com/huge", {
      fetch: async () => htmlResponse(huge),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.reason).toContain("5MB");
  });

  it("非 http(s) 地址直接失败，不发请求", async () => {
    let called = false;
    const outcome = await fetchArticleText("ftp://example.com/a", {
      fetch: async () => {
        called = true;
        return htmlResponse(PAGE);
      },
    });
    expect(outcome.ok).toBe(false);
    expect(called).toBe(false);
  });
});
