import { log } from "./log.ts";
import type { Translator } from "./translate.ts";

/** 单次翻译请求超时。 */
const REQUEST_TIMEOUT_MS = 20_000;

/** 翻译目标语言：繁體中文。 */
const TARGET_LANG = "zh-TW";

/**
 * Google 免费翻译端点。
 *
 * 不是正式 API，没有 key、没有配额契约，随时可能 429 或改结构。
 * 所以它只是**主选**，挂了立刻切 MyMemory，两个都挂就保留英文——
 * 拿不到中文不该让整篇摘要作废。
 */
async function googleTranslate(text: string): Promise<string> {
  const body = new URLSearchParams({
    client: "gtx",
    sl: "en",
    tl: TARGET_LANG,
    dt: "t",
    q: text,
  });

  const response = await fetch("https://translate.googleapis.com/translate_a/single", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
    body: body.toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`google http ${response.status}`);
  }

  const payload: unknown = await response.json();
  // 返回形如 [[["译文","原文",null,null,10], ...], null, "en", ...]
  if (!Array.isArray(payload)) {
    throw new Error("google 响应结构异常");
  }
  const segments = payload[0];
  if (!Array.isArray(segments)) {
    throw new Error("google 分段缺失");
  }

  const parts: string[] = [];
  for (const segment of segments) {
    if (!Array.isArray(segment)) {
      continue;
    }
    const piece = segment[0];
    if (typeof piece === "string" && piece !== "") {
      parts.push(piece);
    }
  }
  const joined = parts.join("");
  if (joined === "") {
    throw new Error("google 返回空译文");
  }
  return joined;
}

/** MyMemory 免费端点。作为 Google 的第二选择。 */
async function myMemoryTranslate(text: string): Promise<string> {
  const url = new URL("https://api.mymemory.translated.net/get");
  url.searchParams.set("q", text);
  url.searchParams.set("langpair", `en|${TARGET_LANG}`);

  const response = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`mymemory http ${response.status}`);
  }

  const payload = (await response.json()) as {
    responseData?: { translatedText?: unknown };
    quotaFinished?: unknown;
  };
  if (payload.quotaFinished === true) {
    throw new Error("mymemory 配额用尽");
  }

  const translated = payload.responseData?.translatedText;
  if (typeof translated !== "string" || translated.trim() === "") {
    throw new Error("mymemory 返回空译文");
  }
  return translated;
}

/**
 * 造一个翻译器。
 *
 * 内部记住 Google 的可用状态：一旦失败过就不再每条都尝试它，避免每条都
 * 等一次超时。MyMemory 失败则让这条译文留空（上层保留英文）。
 */
export function createTranslator(): Translator {
  let googleAlive = true;
  let googleFailures = 0;

  return async (text: string): Promise<string> => {
    if (googleAlive) {
      try {
        return await googleTranslate(text);
      } catch (error) {
        googleFailures += 1;
        // 连续两次失败才彻底放弃 Google：偶发单条失败不该永久降级
        if (googleFailures >= 2) {
          googleAlive = false;
          log().warn("google translate disabled, using mymemory", {
            failures: googleFailures,
            error: String(error),
          });
        }
      }
    }
    return await myMemoryTranslate(text);
  };
}
