import type { DigestItem, DigestSection, SourceKey } from "./types.ts";
import { SOURCE_TITLES } from "./types.ts";

/** 一次解析的结果。失败带原因，供日志与重试判定使用。 */
export type ParseOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/** 剥掉 markdown 代码围栏。模型常把 JSON 包在 ```json 里。 */
function stripFence(text: string): string {
  const match = /```[a-zA-Z0-9]*[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*```/.exec(text);
  return match?.[1] ?? text;
}

/**
 * 从文本里切出第一个配平的 JSON 对象或数组。
 *
 * 模型会在 JSON 前后加解释性文字（"好的，这是结果：" / "希望有用！"），
 * 所以不能直接 JSON.parse 整段。扫描时跳过字符串内部，避免 `{"a":"}"}`
 * 这类内容把括号计数带偏。
 */
function extractBalanced(text: string): string | null {
  const start = text.search(/[{[]/);
  if (start === -1) {
    return null;
  }
  const open = text[start];
  const close = open === "{" ? "}" : "]";

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) {
      depth += 1;
    } else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

/** 去掉对象/数组末尾的多余逗号。只在首次 parse 失败时使用。 */
function stripTrailingCommas(text: string): string {
  return text.replace(/,(\s*[}\]])/g, "$1");
}

/** 解析失败返回 undefined。JSON.parse 不会返回 undefined，用它当哨兵安全。 */
function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // 继续尝试清洗后的版本
  }
  try {
    return JSON.parse(stripTrailingCommas(text));
  } catch {
    return undefined;
  }
}

/**
 * 响应是不是「模型想调工具」而不是直接给答案。
 *
 * 观察到模型有时会输出 DSML 工具调用（`invoke name="read"` 之类），
 * 而不是 JSON。分块内容太长时最容易这样——模型被文本里的指令带跑，
 * 想去调工具而不是总结。
 *
 * 这种响应没法当 JSON 用，要明确报出来，否则只报「解析失败」看不出原因。
 */
function looksLikeToolCall(text: string): boolean {
  return /<\uFF5C\uFF5CDSML|invoke\s+name=|<\|\|\w+\|\|>/.test(text);
}

/** 只接受 http(s)。模型偶尔会写相对路径或 javascript: 之类的脏值。 */
function normalizeUrl(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : undefined;
}

/** 从对象里取指定名字的数组；顶层本身就是数组时直接用它。 */
function pickArray(value: unknown, field: string): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "object" && value !== null) {
    const inner = (value as Record<string, unknown>)[field];
    if (Array.isArray(inner)) {
      return inner;
    }
  }
  return [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function trimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 逐条校验：title 与 en 都非空才保留，否则丢掉这一条（不让整块失败）。 */
function asItems(value: unknown): DigestItem[] {
  const items: DigestItem[] = [];
  for (const raw of pickArray(value, "items")) {
    const record = asRecord(raw);
    if (record === undefined) {
      continue;
    }
    const title = trimmedString(record["title"]);
    const en = trimmedString(record["en"]);
    if (title === "" || en === "") {
      continue;
    }

    const item: DigestItem = { title, en, zh: "" };
    const url = normalizeUrl(record["url"]);
    if (url !== undefined) {
      item.url = url;
    }
    items.push(item);
  }
  return items;
}

/**
 * 把模型输出解析成一个章节。
 *
 * 章节标题一律由 `SOURCE_TITLES` 决定，不采信模型给的 title——它偶尔会把
 * 标题改写成中英混排或加装饰符号，那会让下游按标题匹配的逻辑失效。
 */
export function parseSection(raw: string, key: SourceKey): ParseOutcome<DigestSection> {
  const text = raw.trim();
  if (text === "") {
    return { ok: false, error: "空响应" };
  }

  if (looksLikeToolCall(text)) {
    return {
      ok: false,
      error: "模型输出的是工具调用而不是 JSON（分块内容可能过长，模型被带跑）",
    };
  }

  const balanced = extractBalanced(stripFence(text));
  if (balanced === null) {
    return { ok: false, error: "响应里找不到 JSON 对象或数组" };
  }

  const parsed = tryParse(balanced);
  if (parsed === undefined) {
    return { ok: false, error: "JSON 解析失败" };
  }

  const title = SOURCE_TITLES[key];

  if (key === "twitter") {
    // Twitter 不再走模型：正文由翻译引擎直接翻，模型只分主题（见 parseTweetCategories）
    return { ok: false, error: "Twitter 章节不走逐条解析" };
  }

  const items = asItems(parsed);
  if (items.length === 0) {
    return { ok: false, error: "没有有效条目" };
  }
  return { ok: true, value: { key, title, kind: "items", items } };
}

/** 模型给的分类归属：一条推文归到哪个主题。 */
export interface TweetCategory {
  /** 英文分类标题。 */
  title: string;
  /** 该分类下的推文编号（对应分块里的 `<tweet id="N">`）。 */
  tweetIds: number[];
}

/**
 * 解析模型给的推文分类。
 *
 * 模型只回答「哪条推文属于哪个主题」，正文一个字都不写——
 * 正文由翻译引擎直译，模型不碰。
 */
export function parseTweetCategories(raw: string): ParseOutcome<TweetCategory[]> {
  const text = raw.trim();
  if (text === "") {
    return { ok: false, error: "空响应" };
  }

  if (looksLikeToolCall(text)) {
    return {
      ok: false,
      error: "模型输出的是工具调用而不是 JSON（分块内容可能过长，模型被带跑）",
    };
  }

  const balanced = extractBalanced(stripFence(text));
  if (balanced === null) {
    return { ok: false, error: "响应里找不到 JSON 对象或数组" };
  }

  const parsed = tryParse(balanced);
  if (parsed === undefined) {
    return { ok: false, error: "JSON 解析失败" };
  }

  const categories = asTweetCategories(parsed);
  if (categories.length === 0) {
    return { ok: false, error: "没有有效分类" };
  }
  return { ok: true, value: categories };
}

/** 逐个校验分类：标题非空、推文编号是正整数。空的分类丢掉。 */
function asTweetCategories(value: unknown): TweetCategory[] {
  const categories: TweetCategory[] = [];
  for (const raw of pickArray(value, "categories")) {
    const record = asRecord(raw);
    if (record === undefined) {
      continue;
    }
    const title = trimmedString(record["title"]);
    if (title === "") {
      continue;
    }

    const ids = record["tweetIds"];
    if (!Array.isArray(ids)) {
      continue;
    }
    const tweetIds: number[] = [];
    for (const id of ids) {
      if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
        continue;
      }
      if (!tweetIds.includes(id)) {
        tweetIds.push(id);
      }
    }
    if (tweetIds.length === 0) {
      continue;
    }
    categories.push({ title, tweetIds });
  }
  return categories;
}

/** 解析翻译结果：条数必须对得上，否则整批作废（宁可留空也不串行）。 */
export function parseTranslations(raw: string, expected: number): ParseOutcome<string[]> {
  const text = raw.trim();
  if (text === "") {
    return { ok: false, error: "空响应" };
  }
  const balanced = extractBalanced(stripFence(text));
  if (balanced === null) {
    return { ok: false, error: "响应里找不到 JSON 对象或数组" };
  }
  const parsed = tryParse(balanced);
  if (parsed === undefined) {
    return { ok: false, error: "JSON 解析失败" };
  }

  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as Record<string, unknown>)["translations"])
      ? ((parsed as Record<string, unknown>)["translations"] as unknown[])
      : [];

  if (list.length !== expected) {
    return { ok: false, error: `条数不匹配：期望 ${expected}，实际 ${list.length}` };
  }
  return { ok: true, value: list.map((entry) => (typeof entry === "string" ? entry.trim() : "")) };
}
