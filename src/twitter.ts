/**
 * Twitter 章节的构建。
 *
 * 与其它来源最大的不同：**正文不由模型写**。
 *
 * - 模型只做一件事——给推文分主题（`tweetIds` 归到哪个分类）。
 * - 正文是原文的直译：左列英文、右列繁中，都是翻译引擎翻出来的，
 *   不是模型总结的要点。
 *
 * 推文直链来自解析层（`parseTwitterRaw`），不靠 handle 反查——
 * 同一作者发过好几条时反查必然对不上，对不上就会退回作者主页。
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RawTweet } from "./chrome/twitter.ts";
import { parseTwitterRaw } from "./chrome/twitter.ts";
import { fetchArticleText, type ArticleOutcome } from "./article.ts";
import { logger } from "./logo.ts";
import type { TweetCategory } from "./llm.ts";
import { categorizeTweets } from "./model.ts";
import { toBilingual, type BilingualText, type Translator } from "./translate.ts";
import type { CategoryItem, DigestCategory, DigestSection } from "./types.ts";
import { SOURCE_FILES, SOURCE_TITLES } from "./types.ts";

/**
 * 给模型分主题时每条推文保留的预览长度。
 *
 * 这**不是成品正文的长度**：模型只看正文决定归到哪个主题，看 600 字足够；
 * 进翻译与进成品的一律是全文（用户要求不截短）。
 */
export const CATEGORIZE_PREVIEW_CHARS = 600;

/** 一条推文最多试几条外链：一条推文挂一串链接时不必全抓。 */
const MAX_ARTICLE_LINKS = 3;

/** 抓文章的并发数：目标站点不吃突发，也不让整章卡在抓取上。 */
const EXPAND_CONCURRENCY = 3;

/** 推文分块的字节上限。超过模型容易被带跑。 */
export const TWITTER_CHUNK_BYTES = 20_000;

/** 模型分不了主题时的兜底分类名（英文，繁中由机翻补）。 */
const FALLBACK_CATEGORY = "Timeline";

/**
 * 推文 → 给模型看的分块。
 *
 * 每条推文带一个 `id`：模型只回「哪条属于哪个分类」，编号就是这里的 id。
 * 正文包在 `<tweet>` 里标成数据，配合专用 system prompt，模型不会去执行它。
 */
export function buildTwitterChunk(tweets: RawTweet[]): string {
  const blocks = tweets.map((tweet) => {
    const text = tweet.text.slice(0, CATEGORIZE_PREVIEW_CHARS);
    const attrs = [`id="${tweet.id}"`];
    if (tweet.handle !== "") {
      attrs.push(`handle="${tweet.handle}"`);
    }
    if (tweet.time !== "") {
      attrs.push(`time="${tweet.time}"`);
    }
    return `<tweet ${attrs.join(" ")}>\n${text}\n</tweet>`;
  });

  const joined = blocks.join("\n");
  return joined.length > TWITTER_CHUNK_BYTES ? joined.slice(0, TWITTER_CHUNK_BYTES) : joined;
}

/** 分类归属：模型给的分类 + 没被分到任何分类的推文。 */
export interface TweetAssignment {
  title: string;
  tweets: RawTweet[];
}

/**
 * 把模型给的分类落到推文上。
 *
 * 模型漏掉的推文进兜底分类，一条都不丢——正文是原文，丢了就真没了。
 */
export function assignTweets(tweets: RawTweet[], categories: TweetCategory[] | undefined): TweetAssignment[] {
  const byId = new Map(tweets.map((tweet) => [tweet.id, tweet]));
  const used = new Set<number>();
  const assignments: TweetAssignment[] = [];

  for (const category of categories ?? []) {
    const picked = category.tweetIds
      .map((id) => byId.get(id))
      .filter((tweet): tweet is RawTweet => tweet !== undefined);
    for (const tweet of picked) {
      used.add(tweet.id);
    }
    if (picked.length === 0) {
      continue;
    }
    assignments.push({ title: category.title, tweets: picked });
  }

  const rest = tweets.filter((tweet) => !used.has(tweet.id));
  if (rest.length > 0) {
    assignments.push({ title: FALLBACK_CATEGORY, tweets: rest });
  }

  return assignments;
}

/** 抓文章正文的实现。默认走网络，测试可注入替身。 */
export interface ExpandDeps {
  fetchArticle?: (url: string) => Promise<ArticleOutcome>;
  /** 并发数，默认 3。 */
  concurrency?: number;
  /** 每条推文最多试几条链接，默认 3。 */
  maxLinks?: number;
}

/**
 * 把推文外链的文章正文抓下来，拼在推文正文后面。
 *
 * - 正文 = `推文正文 + "\n\n" + 文章全文`：推文自己的话也是原文，不能丢；
 * - 每条推文按顺序最多试 3 条链接，取第一条抓成功的；
 * - 全部失败或没有外链：保持推文正文（抓不到就退回，不让整章失败）；
 * - 并发 3，任一链接失败不影响其它推文，不抛错。
 */
export async function expandTweets(tweets: RawTweet[], deps: ExpandDeps = {}): Promise<RawTweet[]> {
  const fetchArticle = deps.fetchArticle ?? fetchArticleText;
  const maxLinks = deps.maxLinks ?? MAX_ARTICLE_LINKS;
  const concurrency = Math.max(1, Math.min(deps.concurrency ?? EXPAND_CONCURRENCY, tweets.length));

  const expanded: RawTweet[] = new Array<RawTweet>(tweets.length);
  let cursor = 0;

  // 游标共享的简单池：固定 concurrency 个 worker 领着做，不一次性把请求全发出去
  const worker = async (): Promise<void> => {
    while (cursor < tweets.length) {
      const index = cursor;
      cursor += 1;
      expanded[index] = await expandOne(tweets[index]!, fetchArticle, maxLinks);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return expanded;
}

/** 抓一条推文的外链文章。每条的结果打一条 info 日志。 */
async function expandOne(
  tweet: RawTweet,
  fetchArticle: (url: string) => Promise<ArticleOutcome>,
  maxLinks: number,
): Promise<RawTweet> {
  const urls = (tweet.articleUrls ?? []).slice(0, maxLinks);
  if (urls.length === 0) {
    return tweet;
  }

  for (const url of urls) {
    const outcome = await fetchArticle(url);
    if (outcome.ok) {
      logger.info("tweet article expanded", { id: tweet.id, url, chars: outcome.text.length });
      return { ...tweet, text: `${tweet.text}\n\n${outcome.text}` };
    }
  }

  logger.info("tweet article skipped", { id: tweet.id, tried: urls.length, chars: tweet.text.length });
  return tweet;
}

/**
 * 从当天的抓取产物构建 Twitter 章节。
 *
 * 读 `twitter_raw.txt` → 解析推文（带直链与外链）→ 模型分主题 → 展开外链文章 → 逐条直译。
 *
 * 模型分主题失败不致命：全部推文进兜底分类，正文照样是原文的翻译。
 */
export async function buildTwitterSectionFromRuns(options: {
  runsDir: string;
  translator: Translator;
}): Promise<DigestSection> {
  const raw = await readFile(join(options.runsDir, SOURCE_FILES.twitter), "utf8");
  const tweets = parseTwitterRaw(raw);
  if (tweets.length === 0) {
    throw new Error("没有抓到推文");
  }

  // 给模型分主题的分块
  const chunkPath = join(options.runsDir, "_twitter.txt");
  await writeFile(chunkPath, buildTwitterChunk(tweets), "utf8");

  const outcome = await categorizeTweets({ chunkPath });
  if (!outcome.ok) {
    logger.warn("categorize failed, fallback to single category", { error: outcome.error ?? "" });
  }

  return buildTwitterSection({
    tweets,
    translator: options.translator,
    categorize: async () => outcome.categories,
  });
}

/**
 * 构建 Twitter 章节。
 *
 * `categorize` 返回 undefined 表示模型分不了主题——这时全部推文进兜底分类，
 * 章节照样出得来（正文是原文，比没有强）。
 */
export async function buildTwitterSection(options: {
  tweets: RawTweet[];
  translator: Translator;
  /** 给推文分主题。失败时返回 undefined。 */
  categorize: () => Promise<TweetCategory[] | undefined>;
  /** 抓外链文章的实现。默认走 `fetchArticleText`，测试可注入替身。 */
  expand?: ExpandDeps;
}): Promise<DigestSection> {
  const { tweets, translator } = options;
  // 分主题看的是推文原文（不被外链文章淹没），之后才展开正文
  const categories = await options.categorize();
  const expanded = await expandTweets(tweets, options.expand ?? {});
  const assignments = assignTweets(expanded, categories);

  const translated = await translateTweets(expanded, translator);

  const digestCategories: DigestCategory[] = assignments.map((assignment) => ({
    title: assignment.title,
    titleZh: "",
    items: assignment.tweets.map((tweet) => toItem(tweet, translated.get(tweet.id))),
  }));

  return {
    key: "twitter",
    title: SOURCE_TITLES.twitter,
    kind: "categories",
    categories: digestCategories,
  };
}

/** 逐条推文翻成中英两版（一次批量请求，条数与顺序不变）。正文是全文，不截断。 */
async function translateTweets(
  tweets: RawTweet[],
  translator: Translator,
): Promise<Map<number, BilingualText>> {
  const texts = tweets.map((tweet) => tweet.text);
  const translated = await toBilingual(texts, translator);
  return new Map(tweets.map((tweet, index) => [tweet.id, translated[index] ?? { en: "", zh: "" }]));
}

/** 一条推文 → 一个要点。 */
function toItem(tweet: RawTweet, text: BilingualText | undefined): CategoryItem {
  const item: CategoryItem = { en: text?.en ?? tweet.text, zh: text?.zh ?? "" };
  if (tweet.url !== undefined) {
    item.url = tweet.url;
  }
  if (tweet.handle !== "") {
    item.handle = tweet.handle;
  }
  if (tweet.time !== "") {
    item.time = tweet.time;
  }
  return item;
}
