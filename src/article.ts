/**
 * 推文外链文章的正文抓取。
 *
 * 目的只有一个：把链接指向的文章**全文**当正文用（与推文正文拼在一起），
 * 不做摘要、不用模型改写。抓不到（登录墙、JS 壳、超时、超大页面）就返回失败，
 * 上层退回推文原文——宁可少一段，也不假装抓到。
 */

/** 桌面 Chrome 的 UA：不少站点按 UA 决定给不给正文（移动版/爬虫版常被砍一半）。 */
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** 单次抓取超时。 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * 响应体上限 5MB。
 *
 * 这**不是内容截断**：超了就整体判失败、退回推文原文。正常文章 HTML 几百 KB，
 * 几 MB 以上基本是异常页面或整站嵌套，抽出来的"正文"也不可信。
 */
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * 抽出来短于这个字数判失败。
 *
 * 实测新闻正文普遍千字以上；400 字以下多是登录墙、JS 空壳、导航页，
 * 把它们当正文拼进成品比没有更糟。
 */
export const MIN_ARTICLE_CHARS = 400;

export type ArticleOutcome =
  | { ok: true; url: string; text: string }
  | { ok: false; reason: string };

/** 抓取实现。默认全局 `fetch`，测试可注入替身。 */
export type ArticleFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface ArticleDeps {
  fetch?: ArticleFetch;
}

/**
 * 抓一篇文章的正文。
 *
 * 不抛错：失败一律 `{ ok: false, reason }`，一条链接抓不到不该让整章作废。
 */
export async function fetchArticleText(url: string, deps: ArticleDeps = {}): Promise<ArticleOutcome> {
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, reason: `不是 http(s) 地址：${url}` };
  }

  const doFetch = deps.fetch ?? fetch;
  try {
    const response = await doFetch(url, {
      // t.co 靠重定向解开，必须跟随
      redirect: "follow",
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      return { ok: false, reason: `http ${response.status}` };
    }
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    if (!contentType.includes("text/html")) {
      return { ok: false, reason: `不是 HTML：${contentType === "" ? "未知类型" : contentType}` };
    }

    // 先看声明长度：超大页面不必下载完再判
    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_BYTES) {
      return { ok: false, reason: `响应体超过 5MB（${declared} 字节）` };
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_BYTES) {
      return { ok: false, reason: `响应体超过 5MB（${buffer.byteLength} 字节）` };
    }

    const text = htmlToText(new TextDecoder("utf-8").decode(buffer));
    if (text.length < MIN_ARTICLE_CHARS) {
      return { ok: false, reason: `正文太短（${text.length} < ${MIN_ARTICLE_CHARS}）` };
    }
    return { ok: true, url, text };
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
}

/** 整块丢掉：内容不是正文，留着只会污染译文。 */
const DROP_BLOCKS =
  /<(script|style|noscript|svg|iframe|head|nav|footer|form)\b[^>]*>[\s\S]*?<\/\1>/gi;

/** 块级边界换成换行，段落才不会被粘成一行。 */
const BLOCK_TAGS =
  /<\/?(?:p|div|br|li|ul|ol|h[1-6]|section|article|main|header|aside|figure|figcaption|blockquote|pre|table|thead|tbody|tr|td|th|hr)\b[^>]*>/gi;

const ANY_TAG = /<[^>]*>/g;

/** 常见实体。`&amp;` 最后解，避免 `&amp;hellip;` 被二次解码。 */
const ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&mdash;": "—",
  "&ndash;": "–",
  "&hellip;": "…",
  "&ldquo;": "“",
  "&rdquo;": "”",
  "&lsquo;": "‘",
  "&rsquo;": "’",
  "&middot;": "·",
  "&copy;": "©",
  "&reg;": "®",
  "&trade;": "™",
};

/** HTML → 纯文本。通用清洗，不针对单一站点。 */
export function htmlToText(html: string): string {
  let text = html.replace(DROP_BLOCKS, " ");
  text = text.replace(BLOCK_TAGS, "\n");
  text = text.replace(ANY_TAG, "");
  text = decodeEntities(text);

  return text
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .filter((line) => line !== "")
    .join("\n")
    .trim();
}

function decodeEntities(text: string): string {
  let out = text;
  for (const [entity, char] of Object.entries(ENTITIES)) {
    out = out.split(entity).join(char);
  }
  out = out.replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
  out = out.replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
  return out.split("&amp;").join("&");
}
