/**
 * 从抓取原始数据里补回「判断要不要点进去」需要的信息。
 *
 * 这些字段在 fetch.sh 产出的 Markdown 里，但模型的 JSON 输出里没有——
 * 模型只吐 title/url/en/zh。星数、语言、今日增量、points、评论数
 * 是读者判断「值不值得点」的直接依据，丢了就没了。所以在抓取层
 * 解析一遍，按标题/handle 关联回去。
 */

/** GitHub Trending 一行的元信息。 */
export interface GithubMeta {
  stars?: string;
  language?: string;
  todayStars?: string;
}

/** Hacker News 一行的元信息。 */
export interface HnMeta {
  points?: number;
  comments?: number;
}

/**
 * 解析 GitHub Trending 行。
 *
 * 形如：
 *   - **php/php-src** — The PHP Interpreter（⭐41,223 · C · ⬆️+287 today）  |  https://...
 *
 * 星数/语言/今日增量是「（）」里用 `·` 分隔的三段，各自可能缺失。
 */
export function parseGithubMeta(line: string): GithubMeta | null {
  const metaMatch = /（([^）]*)）/.exec(line);
  if (metaMatch === null) {
    return null;
  }

  const parts = (metaMatch[1] ?? "")
    .split("·")
    .map((part) => part.trim())
    .filter((part) => part !== "");

  const meta: GithubMeta = {};
  for (const part of parts) {
    const starMatch = /^⭐([\d,]+)$/.exec(part);
    if (starMatch !== null) {
      meta.stars = starMatch[1];
      continue;
    }
    const todayMatch = /^⬆️\+([\d,]+)\s+today$/.exec(part);
    if (todayMatch !== null) {
      meta.todayStars = todayMatch[1];
      continue;
    }
    // 剩下的裸词就是语言
    if (meta.language === undefined && !part.includes("⭐") && !part.includes("⬆️")) {
      meta.language = part;
    }
  }

  return Object.keys(meta).length === 0 ? null : meta;
}

/**
 * 解析 Hacker News 行。
 *
 * 形如：
 *   - **标题** — (1027★ · 370則評論)  |  原文: ...  |  討論: ...
 */
export function extractHnMeta(line: string): HnMeta | null {
  const match = /\((\d+)★\s*·\s*(\d+)則評論\)/.exec(line);
  if (match === null) {
    return null;
  }
  const points = Number(match[1]);
  const comments = Number(match[2]);
  if (!Number.isFinite(points) || !Number.isFinite(comments)) {
    return null;
  }
  return { points, comments };
}

/**
 * 从 twitter_raw.txt 还原 handle → 推文直链的映射。
 *
 * 文件结构：正文块里带 `[N]` 脚注标记（如 `·Oct 22 [2]`），文件尾部是
 * 脚注区 `[N] https://x.com/<handle>/status/<id>`。其中 `[1]` 通常是作者
 * 主页、`[2]` 才是那条推文。
 *
 * 做法：扫脚注区，只收 status 直链（跳过主页与 /analytics），按 handle
 * 归并；同一 handle 多条推文时取第一条（正文里先出现的通常是主推）。
 */
export function extractTwitterLinks(raw: string): Map<string, string> {
  const links = new Map<string, string>();
  if (raw === "") {
    return links;
  }

  // 脚注行：`[12] https://x.com/foo/status/123`
  const footnote = /^\[(\d+)\]\s+(\S+)\s*$/gm;
  for (const match of raw.matchAll(footnote)) {
    const url = match[2] ?? "";
    if (!/^https:\/\/x\.com\/[A-Za-z0-9_]+\/status\/\d+$/.test(url)) {
      continue;
    }
    const handle = /\/x\.com\/([A-Za-z0-9_]+)\/status\//.exec(url)?.[1];
    if (handle === undefined) {
      continue;
    }
    // 先出现的优先
    if (!links.has(handle)) {
      links.set(handle, url);
    }
  }

  return links;
}
