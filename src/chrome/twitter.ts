import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ChromeBridge } from "./bridge.ts";
import { MIN_EXTENSION_VERSION } from "./protocol.ts";

/**
 * 用 pi-chrome 抓 Twitter（X）时间线。
 *
 * 抓取的是**用户真实 Chrome profile 里的已登录会话**（Chrome 伴侣扩展干的活），
 * 产出 `runs/<date>/twitter_raw.txt`，格式与原先 dokobot 的产物同构——
 * 下游 `parseTwitterRaw` 按同一套格式还原。
 */

/** 一条推文。字段与页面上的可见信息一一对应，缺失就是 null。 */
export interface Tweet {
  /** 显示名。 */
  name: string | null;
  /** @handle（含 @）。 */
  handle: string | null;
  /** 发布时间（UTC ISO）。 */
  time: string | null;
  /** 正文。 */
  text: string | null;
  /** 推文直链。 */
  url: string | null;
  replies: number | null;
  reposts: number | null;
  likes: number | null;
  views: number | null;
}

/**
 * 页面内提取脚本。
 *
 * 必须短：CDP `Runtime.evaluate` 在扩展侧有 5 秒硬超时，跑不完就整条命令失败。
 * 交互数从 `div[role="group"]` 的 aria-label 里取（"34 replies, 12 reposts, 331 likes, 52
 * bookmarks, 19361 views"），比逐个 data-testid 稳（计数元素不一定渲染）。
 */
export const EXTRACT_TWEETS_EXPRESSION = String.raw`(() => {
  const pick = (label, re) => {
    const m = label.match(re);
    return m ? Number(m[1].replace(/,/g, '')) : null;
  };
  const all = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
  const tweets = all
    .filter((a) => !a.parentElement.closest('article[data-testid="tweet"]'))
    .map((a) => {
      const user = a.querySelector('div[data-testid="User-Name"]');
      const handle = user
        ? Array.from(user.querySelectorAll('span'))
            .map((s) => (s.textContent || '').trim())
            .find((t) => t.startsWith('@')) || null
        : null;
      const nameEl = user ? user.querySelector('span') : null;
      const textEl = a.querySelector('div[data-testid="tweetText"]');
      const timeEl = a.querySelector('time[datetime]');
      const linkEl = a.querySelector('a[href*="/status/"]');
      const group = a.querySelector('div[role="group"]');
      const label = group ? (group.getAttribute('aria-label') || '') : '';
      return {
        name: nameEl ? (nameEl.textContent || '').trim() : null,
        handle: handle,
        time: timeEl ? timeEl.getAttribute('datetime') : null,
        text: textEl ? (textEl.textContent || '').trim() : null,
        url: linkEl ? linkEl.href : null,
        replies: pick(label, /([\d,]+) replies/i),
        reposts: pick(label, /([\d,]+) reposts/i),
        likes: pick(label, /([\d,]+) likes/i),
        views: pick(label, /([\d,]+) views/i)
      };
    })
    .filter((t) => t.text !== null && t.text !== '');
  return { url: location.href, title: document.title, tweets: tweets };
})()`;

/**
 * 当前页面上的推文数。
 *
 * X 的首屏要好几秒才渲染出内容（实测 0 → 6 条要 4s），所以要先等它。
 */
export const COUNT_TWEETS_EXPRESSION = String.raw`(() => document.querySelectorAll('article[data-testid="tweet"]').length)()`;

/**
 * 滚动一屏，等加载。
 *
 * 单独一条命令：CDP 5 秒硬超时，滚动与等待必须拆开做。
 */
export const SCROLL_EXPRESSION = String.raw`(async () => {
  window.scrollBy(0, window.innerHeight * 2);
  await new Promise((r) => setTimeout(r, 1200));
  return document.querySelectorAll('article[data-testid="tweet"]').length;
})()`;

/** 时间线地址。 */
export const TIMELINE_URL = "https://x.com/home";

/** 抓取时开的标签页放进这个分组，方便在 Chrome 里认出来、也方便收尾。 */
export const TAB_GROUP_TITLE = "daily.news";

/** 少于这个条数算抓取失败（登录墙 / 占位页也长这样）。 */
export const MIN_TWEETS = 5;

export interface TwitterFetchOptions {
  bridge: ChromeBridge;
  /** 时间线地址。 */
  url?: string;
  /** 滚动加载几次。每次一条命令，5 秒 CDP 超时兜底。 */
  scrolls?: number;
  /** 至少几条算成功。 */
  minTweets?: number;
  /** 等推文渲染出来的上限。 */
  waitMs?: number;
}

/**
 * 抓时间线。
 *
 * 开一个后台标签页（不抢焦点），滚几屏，提取，关掉。
 */
export async function fetchTwitterTimeline(options: TwitterFetchOptions): Promise<Tweet[]> {
  const { bridge } = options;
  const scrolls = options.scrolls ?? 4;
  const minTweets = options.minTweets ?? MIN_TWEETS;

  const opened = (await bridge.send("tab.new", {
    url: options.url ?? TIMELINE_URL,
    groupTitle: TAB_GROUP_TITLE,
  })) as { tab?: { id?: number } } | undefined;
  const tabId = opened?.tab?.id;
  if (typeof tabId !== "number") {
    throw new Error("Chrome 没有返回标签页 id");
  }

  try {
    // X 首屏要几秒才渲染出来，先等推文出现再滚
    await waitForTweets(bridge, tabId, minTweets, options.waitMs ?? 20_000);

    for (let i = 0; i < scrolls; i += 1) {
      try {
        await bridge.send("page.evaluate", { expression: SCROLL_EXPRESSION, targetId: tabId, awaitPromise: true }, 20_000);
      } catch {
        // 滚动失败不致命：首屏通常已经有十几条
        break;
      }
    }

    const extracted = (await bridge.send(
      "page.evaluate",
      { expression: EXTRACT_TWEETS_EXPRESSION, targetId: tabId, awaitPromise: true },
      20_000,
    )) as { tweets?: Tweet[] } | undefined;
    const tweets = extracted?.tweets ?? [];
    if (tweets.length < minTweets) {
      throw new Error(`只抓到 ${tweets.length} 条推文（低于 ${minTweets} 条）：多半是没登录或页面没渲染出来`);
    }
    return tweets;
  } finally {
    // 收尾：把自己开的标签页关掉，不留垃圾
    try {
      await bridge.send("tab.close", { targetId: tabId }, 10_000);
    } catch {
      // 关不掉就算了
    }
  }
}

/**
 * 等推文渲染出来。
 *
 * 实测：标签页打开后 0 条要 4 秒才有 6 条。不等就是抓到 0 条。
 */
export async function waitForTweets(
  bridge: ChromeBridge,
  tabId: number,
  minTweets: number,
  timeoutMs: number,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let count = 0;
  while (Date.now() < deadline) {
    try {
      const value = await bridge.send("page.evaluate", { expression: COUNT_TWEETS_EXPRESSION, targetId: tabId }, 10_000);
      count = typeof value === "number" ? value : 0;
    } catch {
      count = 0;
    }
    if (count >= minTweets) {
      return count;
    }
    await sleep(1_000);
  }
  return count;
}

/**
 * 从 `twitter_raw.txt` 还原出的一条推文。
 *
 * 与 `Tweet` 的区别：`time` 是抓取时算好的相对时间（`18h`），不是 ISO 时间；
 * `id` 是它在文件里的序号（1 起），用来跟模型的分类结果对账。
 */
export interface RawTweet {
  /** 序号，1 起。 */
  id: number;
  /** 显示名。 */
  name: string;
  /** @handle（含 @）。 */
  handle: string;
  /** 相对时间，如 "18h"。 */
  time: string;
  /** 正文全文。 */
  text: string;
  /** 推文直链。抓取没拿到时为空。 */
  url?: string;
}

/**
 * 从 `twitter_raw.txt` 还原推文列表。
 *
 * 文件是 `renderTwitterRaw` 的产物：正文块用 `---` 分隔，每块第一行是
 * `**作者** @handle [1]·18h [2]`，最后是脚注区 `[N] https://x.com/...`。
 *
 * 推文直链**从脚注区取**，不靠 handle 反查——同一个作者发过好几条时反查必然
 * 对不上，对不上就会退回作者主页（点开是别人的时间线，不是那条推文）。
 */
export function parseTwitterRaw(raw: string): RawTweet[] {
  if (raw.trim() === "") {
    return [];
  }

  const lines = raw.split("\n");

  // 脚注区：文件末尾连续的 `[N] url` 行（与正文块之间隔一个空行）
  const notes = new Map<string, string>();
  let end = lines.length;
  let blank = false;
  while (end > 0) {
    const line = (lines[end - 1] ?? "").trim();
    if (line === "") {
      // 脚注区前面有一个空行；再往前就是正文块了
      if (blank) {
        end -= 1;
        break;
      }
      blank = true;
      end -= 1;
      continue;
    }
    const match = /^\[(\d+)\]\s+(\S+)$/.exec(line);
    if (match === null) {
      break;
    }
    notes.set(match[1] ?? "", match[2] ?? "");
    end -= 1;
  }

  // 正文块：以 `---` 分隔
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const line of lines.slice(0, end)) {
    if (line.trim() === "---") {
      blocks.push(current);
      current = [];
      continue;
    }
    current.push(line);
  }
  blocks.push(current);

  const tweets: RawTweet[] = [];
  for (const block of blocks) {
    const tweet = parseTweetBlock(block, notes, tweets.length + 1);
    if (tweet !== undefined) {
      tweets.push(tweet);
    }
  }
  return tweets;
}

/** 首行：`**作者** @handle [1]·18h [2]`。 */
const HEAD_PATTERN = /^\*\*(.+?)\*\*\s*(?:(@[A-Za-z0-9_]+)\s*)?\[(\d+)\]·\s*([^\[]*)\[(\d+)\]/;

/** 互动数行：`37 Replies 39 reposts 188 Likes 100048 views`。 */
const METRICS_PATTERN = /^\d+\s+(Replies|reposts|Likes|views)\b/;

/** status 直链。 */
const STATUS_URL_PATTERN = /^https:\/\/x\.com\/[A-Za-z0-9_]+\/status\/\d+$/;

/** 解析一个正文块。解析不出来返回 undefined（这一条丢掉）。 */
function parseTweetBlock(
  block: string[],
  notes: Map<string, string>,
  id: number,
): RawTweet | undefined {
  const head = HEAD_PATTERN.exec(block[0] ?? "");
  if (head === null) {
    return undefined;
  }

  // 互动数行在正文之后（渲染时写在最后一行）
  const rest = block.slice(1);
  let textLines = rest;
  const last = rest[rest.length - 1] ?? "";
  if (METRICS_PATTERN.test(last)) {
    textLines = rest.slice(0, -1);
  }

  const text = textLines
    .map((line) => unescapeBodyLine(line))
    .join("\n")
    .trim();

  // 没正文的推文（纯图片/引用）不进正文页
  if (text === "") {
    return undefined;
  }

  const url = notes.get(head[5] ?? "");
  const tweet: RawTweet = {
    id,
    name: (head[1] ?? "").trim(),
    handle: head[2] ?? "",
    time: (head[4] ?? "").trim(),
    text,
  };
  if (url !== undefined && STATUS_URL_PATTERN.test(url)) {
    tweet.url = url;
  }
  return tweet;
}

/**
 * 还原抓取时给正文行加的前导空格。
 *
 * `renderTwitterRaw` 会给以 `**` 开头或恰好是 `---` 的行加一个前导空格，
 * 免得被下游误判成「下一条推文」。解析回来时要把这个空格去掉。
 */
function unescapeBodyLine(line: string): string {
  if (line.startsWith(" **") || line.trim() === "---") {
    return line.slice(1);
  }
  return line;
}

/**
 * 推文数组 → `twitter_raw.txt` 文本。
 *
 * 形状与原 dokobot 产物一致：
 *
 * ```
 * **作者名** @handle [1]·2h [2]
 * 正文
 * ---
 * 31 Replies 30 reposts 379 Likes 12289 views
 * ---
 * [1] https://x.com/handle
 * [2] https://x.com/handle/status/123
 * ```
 *
 * 下游靠三件事切分：`parseTwitterRaw` 认 `**作者** @handle` 开头与「数字 + Replies/Likes」行，
 * 并从脚注区认 status 直链。
 */
export function renderTwitterRaw(tweets: Tweet[], now: Date = new Date()): string {
  const blocks: string[] = [];
  const notes: string[] = [];
  let noteNo = 0;

  for (const tweet of tweets) {
    const handle = tweet.handle ?? "";
    const name = tweet.name ?? handle.replace(/^@/, "");
    const body = (tweet.text ?? "").split("\n").map((line) => sanitizeBodyLine(line)).filter((line) => line !== "");

    noteNo += 1;
    const idNote = noteNo;
    noteNo += 1;
    const urlNote = noteNo;

    const head = `**${name}** ${handle} [${idNote}]·${relativeTime(tweet.time, now)} [${urlNote}]`;
    const metrics = renderMetrics(tweet);
    blocks.push([head, ...body, ...(metrics === "" ? [] : [metrics])].join("\n"));

    if (handle !== "") {
      notes.push(`[${idNote}] https://x.com/${handle.replace(/^@/, "")}`);
    }
    if (tweet.url !== null && tweet.url !== "") {
      notes.push(`[${urlNote}] ${tweet.url}`);
    }
  }

  return `${blocks.join("\n---\n")}\n\n${notes.join("\n")}\n`;
}

/** 互动数一行。缺哪项就不写哪项。 */
function renderMetrics(tweet: Tweet): string {
  const parts: string[] = [];
  if (tweet.replies !== null) {
    parts.push(`${tweet.replies} Replies`);
  }
  if (tweet.reposts !== null) {
    parts.push(`${tweet.reposts} reposts`);
  }
  if (tweet.likes !== null) {
    parts.push(`${tweet.likes} Likes`);
  }
  if (tweet.views !== null) {
    parts.push(`${tweet.views} views`);
  }
  return parts.join(" ");
}

/**
 * 正文行消毒。
 *
 * 以 `**` 开头或恰好是 `---` 的行会被下游误判成「下一条推文」/「分隔线」，加个前导空格躲开。
 */
function sanitizeBodyLine(line: string): string {
  const trimmed = line.trimEnd();
  if (trimmed.startsWith("**") || trimmed.trim() === "---") {
    return ` ${trimmed}`;
  }
  return trimmed;
}

/** 相对时间：2h / 3d。解析不了就空着。 */
function relativeTime(iso: string | null, now: Date): string {
  if (iso === null || iso === "") {
    return "";
  }
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) {
    return "";
  }
  const hours = (now.getTime() - then.getTime()) / 3_600_000;
  if (hours < 1) {
    return `${Math.max(1, Math.floor(hours * 60))}m`;
  }
  if (hours < 48) {
    return `${Math.floor(hours)}h`;
  }
  return `${Math.floor(hours / 24)}d`;
}

export interface TwitterRawResult {
  ok: boolean;
  count: number;
  error?: string;
  /** 桥的角色。server 是自己占着端口，client 是转发给 pi session。 */
  role?: "server" | "client";
}

/**
 * 抓取并写 `runs/<date>/twitter_raw.txt`。
 *
 * 失败不抛：Twitter 只是四个来源之一，挂了不影响其它三个出稿。
 */
export async function fetchTwitterRaw(options: {
  dataDir: string;
  date: string;
  bridge?: ChromeBridge;
  minTweets?: number;
}): Promise<TwitterRawResult> {
  const bridge = options.bridge ?? (await ChromeBridge.connect());
  const ownsBridge = options.bridge === undefined;
  try {
    await ensureExtensionConnected(bridge);
    await checkExtensionVersion(bridge);

    const tweets = await fetchTwitterTimeline({
      bridge,
      ...(options.minTweets === undefined ? {} : { minTweets: options.minTweets }),
    });
    const raw = renderTwitterRaw(tweets);

    const dir = join(options.dataDir, "runs", options.date);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "twitter_raw.txt"), raw, "utf8");

    return { ok: true, count: tweets.length, role: bridge.role };
  } catch (error) {
    return { ok: false, count: 0, error: (error as Error).message };
  } finally {
    if (ownsBridge) {
      await bridge.stop();
    }
  }
}

/**
 * 确保 Chrome 扩展在轮询。
 *
 * Chrome 没开就拉起来（扩展在 Chrome 里，不开就没人轮询），最多等 45s。
 * Chrome 已经开着却连不上扩展 → 不重复拉起（`open -a` 会把 Chrome 拉到前台，
 * 07:00 抢用户屏幕），直接报错让人去 chrome://extensions 看。
 */
export async function ensureExtensionConnected(bridge: ChromeBridge, waitMs = 45_000): Promise<void> {
  const status = await bridge.status();
  if (status.connected) {
    return;
  }
  if (!isChromeRunning()) {
    launchChrome();
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(500);
    const current = await bridge.status();
    if (current.connected) {
      return;
    }
  }
  throw new Error(
    "Chrome 扩展没有连上：确认 Chrome 在运行，且 chrome://extensions 里加载了 Pi Chrome Connector",
  );
}

/** Chrome 在跑吗。用来决定要不要拉起它。 */
export function isChromeRunning(): boolean {
  const result = spawnSync("pgrep", ["-x", "Google Chrome"], { stdio: "ignore" });
  return result.status === 0;
}

/**
 * 扩展版本下限检查。
 *
 * 协议变了的话（老扩展不认识新动作），表现是「命令超时」或「Unknown action」，
 * 不如在这里直接说清楚。
 */
export async function checkExtensionVersion(bridge: ChromeBridge): Promise<string> {
  const info = (await bridge.send("tab.version", {}, 15_000)) as { extensionVersion?: string } | undefined;
  const version = info?.extensionVersion ?? "";
  if (version === "") {
    return "";
  }
  if (isOlderThan(version, MIN_EXTENSION_VERSION)) {
    throw new Error(`Chrome 扩展版本过旧（${version} < ${MIN_EXTENSION_VERSION}）：到 chrome://extensions 重新加载 Pi Chrome Connector`);
  }
  return version;
}

/** 拉起 Chrome（默认 profile，扩展就装在里面）。 */
function launchChrome(): void {
  spawnSync("open", ["-a", "Google Chrome"], { stdio: "ignore" });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 语义化版本比较：`a` 是否比 `b` 老。 */
function isOlderThan(a: string, b: string): boolean {
  const parse = (value: string): number[] =>
    value
      .split(".")
      .map((part) => Number.parseInt(part, 10))
      .map((part) => (Number.isFinite(part) ? part : 0));
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l !== r) {
      return l < r;
    }
  }
  return false;
}
