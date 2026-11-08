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
import { logger } from "./logo.ts";
import type { TweetCategory } from "./llm.ts";
import { categorizeTweets } from "./model.ts";
import { toBilingual, type BilingualText, type Translator } from "./translate.ts";
import type { CategoryItem, DigestCategory, DigestSection } from "./types.ts";
import { SOURCE_FILES, SOURCE_TITLES } from "./types.ts";

/** 单条推文正文保留的长度。截断是为了控翻译成本，不是为了内容完整。 */
export const TWEET_TEXT_LIMIT = 600;

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
    const text = tweet.text.slice(0, TWEET_TEXT_LIMIT);
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

/**
 * 从当天的抓取产物构建 Twitter 章节。
 *
 * 读 `twitter_raw.txt` → 解析推文（带直链）→ 模型分主题 → 逐条直译。
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
}): Promise<DigestSection> {
  const { tweets, translator } = options;
  const categories = await options.categorize();
  const assignments = assignTweets(tweets, categories);

  const translated = await translateTweets(tweets, translator);

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

/** 逐条推文翻成中英两版（一次批量请求，条数与顺序不变）。 */
async function translateTweets(
  tweets: RawTweet[],
  translator: Translator,
): Promise<Map<number, BilingualText>> {
  const texts = tweets.map((tweet) => tweet.text.slice(0, TWEET_TEXT_LIMIT));
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
