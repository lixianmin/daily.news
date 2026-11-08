/**
 * 知乎热榜的原始数据解析。
 *
 * `scripts/fetch.sh` 产出的 `zhihu.md` 每行一条：
 *
 * ```
 * - **问题标题**  — 答案摘要片段（359 万热度）  |  https://www.zhihu.com/question/<id>
 * ```
 *
 * 知乎不走大模型总结：正文直接翻译成英文与繁中，所以这里要把
 * 标题与摘要片段原样还原出来。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { toBilingual, type Translator } from "./translate.ts";
import type { DigestItem, DigestSection } from "./types.ts";
import { SOURCE_FILES, SOURCE_TITLES } from "./types.ts";

/** 知乎热榜的一条。 */
export interface ZhihuItem {
  /** 问题标题（原文，中文）。 */
  title: string;
  /** 答案摘要片段（原文）。没有就是空串。 */
  excerpt: string;
  /** 问题链接。 */
  url: string;
  /** 热度，如 "359 万热度"。 */
  heat?: string;
}

/** 条目行：`- **标题**  — 摘要（热度）  |  链接` */
const ITEM_PATTERN = /^-\s+\*\*(.+?)\*\*/;

/**
 * 解析 `zhihu.md`。
 *
 * 逐行匹配，认不出来就跳过——抓取失败时文件里是「⚠️ 抓取失敗：無數據」，
 * 那不是条目。
 */
export function parseZhihu(md: string): ZhihuItem[] {
  const items: ZhihuItem[] = [];

  for (const raw of md.split("\n")) {
    const line = raw.trim();
    const head = ITEM_PATTERN.exec(line);
    if (head === null) {
      continue;
    }

    const title = (head[1] ?? "").trim();
    if (title === "") {
      continue;
    }

    // 标题之后：`  — 摘要（热度）  |  链接`
    let rest = line.slice(head[0].length);

    let url = "";
    const pipe = rest.lastIndexOf("|");
    if (pipe !== -1) {
      url = rest.slice(pipe + 1).trim();
      rest = rest.slice(0, pipe);
    }

    let heat: string | undefined;
    const heatMatch = /（([^）]*)）\s*$/.exec(rest);
    if (heatMatch !== null) {
      heat = (heatMatch[1] ?? "").trim();
      rest = rest.slice(0, heatMatch.index);
    }

    const excerpt = rest.replace(/^\s*—\s*/, "").trim();

    const item: ZhihuItem = { title, excerpt, url };
    if (heat !== undefined && heat !== "") {
      item.heat = heat;
    }
    items.push(item);
  }

  return items;
}

/**
 * 从当天的抓取产物构建知乎章节。
 *
 * 读 `zhihu.md` → 解析问题与摘要片段 → 逐条直译。
 * 不经模型：知乎正文不需要总结。
 */
export async function buildZhihuSectionFromRuns(options: {
  runsDir: string;
  translator: Translator;
}): Promise<DigestSection> {
  const raw = await readFile(join(options.runsDir, SOURCE_FILES.zhihu), "utf8");
  const items = parseZhihu(raw);
  if (items.length === 0) {
    throw new Error("没有抓到条目");
  }
  return buildZhihuSection({ items, translator: options.translator });
}

/**
 * 构建知乎章节。
 *
 * 每条都是「问题 + 答案摘要片段」的直译：左列英文、右列繁中。
 * 卡片标题保持中文原题（点进去是问题页），正文才是翻译。
 */
export async function buildZhihuSection(options: {
  items: ZhihuItem[];
  translator: Translator;
}): Promise<DigestSection> {
  const { items, translator } = options;

  const texts = await toBilingual(items.map((item) => sourceText(item)), translator);

  const digestItems: DigestItem[] = items.map((item, index) => {
    const text = texts[index];
    const digest: DigestItem = {
      title: item.title,
      en: text?.en ?? item.title,
      zh: text?.zh ?? "",
    };
    if (item.url !== "") {
      digest.url = item.url;
    }
    return digest;
  });

  return {
    key: "zhihu",
    title: SOURCE_TITLES.zhihu,
    kind: "items",
    items: digestItems,
  };
}

/**
 * 一条知乎内容的原文：问题 + 摘要片段。
 *
 * 问题和摘要是一段话的两截，分开翻会丢上下文（读者只看到摘要，
 * 不知道在问什么），所以拼成一段一起翻。
 */
function sourceText(item: ZhihuItem): string {
  if (item.excerpt === "") {
    return item.title;
  }
  return `${item.title}\n\n${item.excerpt}`;
}
