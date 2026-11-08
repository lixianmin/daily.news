import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "./logo.ts";
import { translateWithModel } from "./model.ts";
import type { TargetLang, Translator } from "./translate.ts";

/** 单次翻译请求超时。 */
const REQUEST_TIMEOUT_MS = 20_000;

/** 翻译目标语言：英文与繁體中文。 */
const TARGET_LANG = "zh-TW";

/**
 * 源语言判断（只给 MyMemory 用）。
 *
 * Google 端点支持 `sl=auto` 自己判源语言；MyMemory 必须给明确的对，
 * 只能自己分：含中日韩文字就算中文，其余算英文。
 */
function sourceLang(text: string): string {
  return /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(text) ? "zh-CN" : "en";
}

/**
 * Google 免费翻译端点。
 *
 * 不是正式 API，没有 key、没有配额契约，随时可能 429 或改结构。
 * 所以它只是**主选**，挂了立刻切 MyMemory，两个都挂就保留英文——
 * 拿不到中文不该让整篇摘要作废。
 */
async function googleTranslate(text: string, target: TargetLang): Promise<string> {
  const body = new URLSearchParams({
    client: "gtx",
    // 源语言自动判：推文与问题原文可能是中文、英文、日文
    sl: "auto",
    tl: target,
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
async function myMemoryTranslate(text: string, target: TargetLang): Promise<string> {
  const url = new URL("https://api.mymemory.translated.net/get");
  url.searchParams.set("q", text);
  url.searchParams.set("langpair", `${sourceLang(text)}|${target}`);

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
 * 三级降级，逐级收窄：
 *
 * 1. Google 免费端点——快、句子级直译，但有 429。
 * 2. MyMemory——不同的服务商，配额也有限（每天 5000 词）。
 * 3. 模型兜底——两个免费端点都拿不到时，让 deepseek 逐字翻译。
 *
 * 前两级逐条串行并留间隔：免费端点对突发并发敏感（实测一轮几十个并发请求就把
 * IP 打进 429）。整批失败才升到下一级，不逐条来回试。
 */
export function createTranslator(options: { dir?: string } = {}): Translator {
  // 模型兜底的输入文件落盘位置。落临时目录：它只是给 pi 读的中间产物，
  // 跟数据目录（runs/<date>）无关，不该混进成品里。
  const workDir = options.dir ?? join(tmpdir(), "daily-news-translate");
  let googleAlive = true;
  let googleFailures = 0;

  return async (texts: string[], target: TargetLang = TARGET_LANG): Promise<string[]> => {
    const results: string[] = new Array(texts.length).fill("");
    const failed: number[] = [];

    for (const [index, text] of texts.entries()) {
      if (text.trim() === "") {
        continue;
      }
      const value = await translateOne(text, target, isGoogleAlive);
      if (value === "") {
        failed.push(index);
      } else {
        results[index] = value;
      }
      // 请求之间留间隔：突发并发是触发限流的主因
      await sleep(REQUEST_GAP_MS);
    }

    if (failed.length === 0) {
      return results;
    }

    // 逐条都没拿到 → 交给模型整批兜底
    await mkdir(workDir, { recursive: true });
    const pending = failed.map((index) => texts[index] ?? "");
    const fallback = await translateWithModel({ texts: pending, target, dir: workDir });
    if (fallback === undefined) {
      return results;
    }
    failed.forEach((index, at) => {
      results[index] = fallback[at] ?? "";
    });
    return results;
  };

  /** 逐条翻译：Google 优先，失败落 MyMemory。 */
  async function translateOne(text: string, target: TargetLang, googleEnabled: () => boolean): Promise<string> {
    if (googleEnabled()) {
      try {
        return await googleTranslate(text, target);
      } catch (error) {
        googleFailures += 1;
        // 连续两次失败才彻底放弃 Google：偶发单条失败不该永久降级
        if (googleFailures >= 2) {
          googleAlive = false;
          logger.warn("google translate disabled, using mymemory", {
            failures: googleFailures,
            error: String(error),
          });
        }
      }
    }
    try {
      return await myMemoryTranslate(text, target);
    } catch (error) {
      logger.warn("mymemory translate failed", { error: String(error) });
      return "";
    }
  }

  function isGoogleAlive(): boolean {
    return googleAlive;
  }
}

/** 逐条请求之间的间隔。太小会被免费端点判成突发流量。 */
const REQUEST_GAP_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
