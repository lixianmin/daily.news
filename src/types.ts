/** 四个抓取来源。与 fetch.sh 的 --sources 取值一致。 */
export type SourceKey = "twitter" | "github" | "hackernews" | "zhihu";

export const SOURCE_KEYS: readonly SourceKey[] = ["twitter", "github", "hackernews", "zhihu"];

/** 来源 → 章节标题。顺序即文章顺序。 */
export const SOURCE_TITLES: Record<SourceKey, string> = {
  twitter: "Twitter 時間線（近48小時 · 分門別類總結）",
  zhihu: "知乎熱榜（24小時）",
  github: "GitHub Trending（今日趨勢）",
  hackernews: "Hacker News（過去24小時熱點）",
};

/** 来源 → 章节的短名（侧边栏用）。 */
export const SOURCE_SHORT: Record<SourceKey, string> = {
  twitter: "Twitter",
  zhihu: "知乎",
  github: "GitHub",
  hackernews: "Hacker News",
};

/** 来源 → 抓取产物的文件名（在 runs/<date>/ 下）。 */
export const SOURCE_FILES: Record<SourceKey, string> = {
  twitter: "twitter_raw.txt",
  zhihu: "zhihu.md",
  github: "gh.md",
  hackernews: "hn.md",
};

/** GitHub 条目的元信息。判断「要不要点进去」的直接依据。 */
export interface GithubMeta {
  /** 总 star 数，如 "41,223"。 */
  stars?: string;
  /** 主要语言，如 "C"。 */
  language?: string;
  /** 今日 star 增量，如 "287"。 */
  todayStars?: string;
}

/** Hacker News 条目的元信息。 */
export interface HnMeta {
  points?: number;
  comments?: number;
}

/** 条目的附加元信息。按来源填充不同字段。 */
export type ItemMeta =
  | { source: "github"; github: GithubMeta }
  | { source: "hackernews"; hn: HnMeta }
  | { source: "zhihu" }
  | { source: "twitter" };

/** 一条条目。 */
export interface DigestItem {
  /** 条目标题。GitHub/HN/知乎保持原标题原语言。 */
  title: string;
  /** 原始链接。点「原文」去这里。 */
  url?: string;
  /** 英文摘要，一行，15~30 词。 */
  en: string;
  /** 繁體中文摘要，由机翻生成。与 en 内容一致，只用于左右对照。 */
  zh: string;
  /** 元信息。 */
  meta?: ItemMeta;
  /** 附加链接（如 HN 的讨论页）。 */
  extraLinks?: Array<{ label: string; url: string }>;
}

/**
 * Twitter 分类下的一条要点。
 *
 * 不继承 `DigestItem`：要点没有独立标题，正文即 `en`，标题由分类提供。
 */
export interface CategoryItem {
  /** 英文要点，可多行段落。 */
  en: string;
  /** 繁體中文，机翻生成。与 en 内容一致。 */
  zh: string;
  /** 推文直链（从原始数据还原，不是作者主页）。 */
  url?: string;
}

/** Twitter 章節的主題分類。 */
export interface DigestCategory {
  /** 英文分类标题，如 "AI Models & Benchmarks"。 */
  title: string;
  /** 繁中分类标题，机翻生成。 */
  titleZh: string;
  items: CategoryItem[];
}

/**
 * 一个章节。
 *
 * Twitter 走 `categories`（分门别类总结），其余三个来源走 `items`（逐条列举）。
 * 用一个判别字段而不是两个可选数组：渲染和搜索都只需判一次 kind。
 */
export type DigestSection =
  | {
      key: SourceKey;
      title: string;
      kind: "categories";
      categories: DigestCategory[];
    }
  | {
      key: SourceKey;
      title: string;
      kind: "items";
      items: DigestItem[];
    };

/** 某个来源的抓取与生成结果。 */
export interface SourceStatus {
  /** 抓取成功且有数据。 */
  ok: boolean;
  /** 条目数（Twitter 为要点数）。 */
  count: number;
  /** 失败原因，`ok` 为 true 时省略。 */
  error?: string;
}

/** 一天的成品。落盘到 `<dataDir>/days/<date>.json`。 */
export interface DigestDay {
  /** `YYYY-MM-DD`，东八区。 */
  date: string;
  /** 星期几，如 "星期五"。 */
  weekday: string;
  /** 生成完成时刻，ISO 8601 带时区。 */
  generatedAt: string;
  /** 主通道模型标识，如 "deepseek/deepseek-flash"。 */
  model: string;
  /** 各来源状态。缺某个 key 表示该来源本轮未尝试。 */
  sources: Partial<Record<SourceKey, SourceStatus>>;
  sections: DigestSection[];
}

/** 索引里的一天。列表页只读这个，不读整天文件。 */
export interface IndexDay {
  date: string;
  weekday: string;
  generatedAt: string;
  /** 全部章节的条目总数。 */
  total: number;
  /** 各来源条目数。 */
  counts: Partial<Record<SourceKey, number>>;
  /** 抓取成功的来源数（满分 4）。 */
  sourcesOk: number;
  /** 摘要用：前几条标题，列表页展示。 */
  headlines: string[];
}

/** `<dataDir>/index.json`。 */
export interface DigestIndex {
  updatedAt: string;
  /** 按日期倒序。 */
  days: IndexDay[];
}

/** 生成进度事件。推给 SSE 与页面。 */
export interface ProgressEvent {
  /** 阶段标识。 */
  stage: "fetch" | "generate" | "merge" | "translate" | "write" | "done" | "error";
  /** 人类可读的一句话。 */
  message: string;
  /** 0~1；未知时为 undefined。 */
  ratio?: number;
  /** 出问题的来源或章节。 */
  source?: SourceKey;
  /** ISO 8601。 */
  at: string;
  /**
   * true = 刚刚发生的实时事件；false/undefined = 服务端重放的历史事件。
   *
   * 区分这个很重要：客户端靠它判断「要不要刷新页面」。历史事件里也有
   * `done`，如果当成实时的，就会每次加载都刷新一次——形成死循环。
   */
  live?: boolean;
}
