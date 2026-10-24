import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { extractHnMeta, extractTwitterLinks, parseGithubMeta } from "./meta.ts";
import type { DigestSection, ItemMeta, SourceKey } from "./types.ts";
import { SOURCE_FILES } from "./types.ts";

/**
 * 把抓取原始数据里的元信息补回生成结果。
 *
 * 模型只吐 title/url/en——它不知道星数、不知道 points、不知道推文 ID。
 * 但这些恰恰是读者判断「值不值得点」的依据，所以在抓取层再解析一遍，
 * 按标题/handle 关联回去。
 */
export interface EnrichOptions {
  /** 当天抓取目录。 */
  runsDir: string;
  /** 当天日期。 */
  date: string;
}

/** 从 gh.md / hn.md 建立「标题 → 元信息」的索引。 */
async function buildMetaIndexes(runsDir: string): Promise<{
  github: Map<string, ReturnType<typeof parseGithubMeta>>;
  hn: Map<string, ReturnType<typeof extractHnMeta>>;
  hnExtra: Map<string, Array<{ label: string; url: string }>>;
}> {
  const github = new Map<string, ReturnType<typeof parseGithubMeta>>();
  const hn = new Map<string, ReturnType<typeof extractHnMeta>>();
  const hnExtra = new Map<string, Array<{ label: string; url: string }>>();

  try {
    const ghRaw = await readFile(join(runsDir, SOURCE_FILES.github), "utf8");
    for (const line of ghRaw.split("\n")) {
      const titleMatch = /^- \*\*(.+?)\*\*/.exec(line);
      if (titleMatch === null) {
        continue;
      }
      const meta = parseGithubMeta(line);
      if (meta !== null) {
        github.set(titleMatch[1] ?? "", meta);
      }
    }
  } catch {
    // 没有 gh.md 就跳过
  }

  try {
    const hnRaw = await readFile(join(runsDir, SOURCE_FILES.hackernews), "utf8");
    for (const line of hnRaw.split("\n")) {
      const titleMatch = /^- \*\*(.+?)\*\*/.exec(line);
      if (titleMatch === null) {
        continue;
      }
      const title = titleMatch[1] ?? "";

      const meta = extractHnMeta(line);
      if (meta !== null) {
        hn.set(title, meta);
      }

      // HN 有两个链接：原文 + 讨论页
      const extra: Array<{ label: string; url: string }> = [];
      const discussion = /討論:\s*(\S+)/.exec(line);
      if (discussion !== null) {
        extra.push({ label: "讨论", url: discussion[1] ?? "" });
      }
      if (extra.length > 0) {
        hnExtra.set(title, extra);
      }
    }
  } catch {
    // 没有 hn.md 就跳过
  }

  return { github, hn, hnExtra };
}

/**
 * 剥掉摘要里重复的元信息。
 *
 * HN 的摘要常写成「…, 744 points and 259 comments.」——而这些数字已经
 * 作为 chip 显示在标题下方了。留着就是同一屏里说两遍。
 */
function stripRedundantMeta(text: string, meta: ItemMeta | undefined): string {
  if (meta === undefined || meta.source !== "hackernews") {
    return text;
  }

  const { points, comments } = meta.hn;
  let out = text;

  if (points !== undefined) {
    out = out.replace(new RegExp(`\\b${points}\\s*points?\\b`, "gi"), "");
  }
  if (comments !== undefined) {
    out = out.replace(new RegExp(`\\b${comments}\\s*comments?\\b`, "gi"), "");
  }

  // 清理删除后残留的连接词与标点。删除后可能是这样：
  //   "France, 1027 points and 370 comments." → "France,  and ."
  // 先去掉孤立的 and（连同它前面的逗号），再去尾巴的标点。
  return out
    .replace(/,?\s*\band\b\s*(?=[.,;]?\s*$)/i, "")
    .replace(/\s*,\s*$/, "")
    .replace(/\s*\.\s*$/, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,;:])/g, "$1")
    .trim();
}

/**
 * 每个逐条来源最多保留几条。
 *
 * 10 条足够看完热点，又不至于把摘要稀释成流水账。
 * 抓取层已经限了数量，这里是最后一道保险——模型不听话硬凑时能拦住。
 */
export const MAX_ITEMS_PER_SOURCE = 10;

/**
 * 截断逐条章节的条目数。
 *
 * 在翻译之前做：条目少了，翻译的调用和字数都跟着少。
 * Twitter 不受这个限制——它是分主题归纳的要点，不是逐条列表。
 */
export function limitSectionItems(section: DigestSection): DigestSection {
  if (section.kind !== "items") {
    return section;
  }
  if (section.items.length <= MAX_ITEMS_PER_SOURCE) {
    return section;
  }
  return {
    ...section,
    items: section.items.slice(0, MAX_ITEMS_PER_SOURCE),
  };
}

/**
 * 给一个章节补元信息。就地修改并返回同一对象。
 */
export async function enrichSection(
  section: DigestSection,
  options: EnrichOptions,
  indexes?: Awaited<ReturnType<typeof buildMetaIndexes>>,
): Promise<DigestSection> {
  if (section.kind !== "items") {
    await enrichTwitter(section, options);
    return section;
  }

  const { github, hn, hnExtra } = indexes ?? (await buildMetaIndexes(options.runsDir));

  for (const item of section.items) {
    if (section.key === "github") {
      const meta = github.get(item.title);
      if (meta !== undefined && meta !== null) {
        item.meta = { source: "github", github: meta };
      }
      continue;
    }
    if (section.key === "hackernews") {
      const meta = hn.get(item.title);
      if (meta !== undefined && meta !== null) {
        item.meta = { source: "hackernews", hn: meta };
        // 数字已经在 chip 里了，摘要里不用再说一遍。
        // 繁中也要跟着改，否则两列内容对不上。
        item.en = stripRedundantMeta(item.en, item.meta);
        item.zh = stripRedundantMeta(item.zh, item.meta);
      }
      const extra = hnExtra.get(item.title);
      if (extra !== undefined) {
        item.extraLinks = extra;
      }
    }
  }

  return section;
}

/**
 * 把 Twitter 要点的作者主页链接换成推文直链。
 *
 * 模型只能从 `handles` 推出 `x.com/<handle>`（作者主页）。原始数据里
 * 有 `x.com/<handle>/status/<id>`（那条推文本身），用 handle 反查替换。
 */
async function enrichTwitter(section: DigestSection, options: EnrichOptions): Promise<void> {
  if (section.kind !== "categories") {
    return;
  }

  let links: Map<string, string> | undefined;
  for (const category of section.categories) {
    for (const item of category.items) {
      if (item.url === undefined) {
        continue;
      }
      const handle = /\/x\.com\/([A-Za-z0-9_]+)$/.exec(item.url)?.[1];
      if (handle === undefined) {
        continue;
      }

      links ??= await loadTwitterLinks(options);
      const direct = links.get(handle);
      if (direct !== undefined) {
        item.url = direct;
      }
    }
  }
}

/** 读 twitter_raw.txt 并抽出 handle → 推文直链。 */
async function loadTwitterLinks(options: EnrichOptions): Promise<Map<string, string>> {
  try {
    const raw = await readFile(join(options.runsDir, SOURCE_FILES.twitter), "utf8");
    return extractTwitterLinks(raw);
  } catch {
    return new Map();
  }
}

export { buildMetaIndexes };
export type { SourceKey };
