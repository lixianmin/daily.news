import type { CategoryItem, DigestCategory, DigestItem, DigestSection } from "./types.ts";

/** 把英文翻成繁中。失败时抛错，由调用方决定是否降级。 */
export type Translator = (text: string) => Promise<string>;

export interface TranslateOptions {
  translator: Translator;
  /** 并发数。默认 3：免费端点并发太高会被限流。 */
  concurrency?: number;
  /** 每条翻译之间插入的延迟（毫秒）。默认 0。 */
  delayMs?: number;
  onProgress?: (done: number, total: number) => void;
}

const CJK = /[\u4e00-\u9fff]/;
const DEFAULT_CONCURRENCY = 3;

/**
 * 这段文字是否需要翻译。
 *
 * 含中日韩统一表意文字就跳过：模型偶尔无视"只写英文"的指令自己写了中文，
 * 再翻一遍只会得到更糟的中文，还白烧额度。
 */
export function needsTranslation(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "") return false;
  return !CJK.test(trimmed);
}

/**
 * 收集一个章节里所有需要翻译的文本，保持出现顺序。
 *
 * 判据是「`zh` 为空 且 `en` 是纯英文」——只看 `en` 是否含中文是不够的，
 * 已有译文的条目会被重复送去翻译，白烧额度。
 */
function collectTexts(section: DigestSection): string[] {
  const texts: string[] = [];
  if (section.kind === "items") {
    for (const item of section.items) {
      if (item.zh === "" && needsTranslation(item.en)) texts.push(item.en);
    }
    return texts;
  }
  for (const category of section.categories) {
    if (category.titleZh === "" && needsTranslation(category.title)) texts.push(category.title);
    for (const item of category.items) {
      if (item.zh === "" && needsTranslation(item.en)) texts.push(item.en);
    }
  }
  return texts;
}

/** 按并发上限跑完所有任务。`delayMs` 在每次取任务前等待。 */
async function runPool<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
  delayMs: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const task = tasks[index];
      if (task === undefined) return;
      if (delayMs > 0 && index > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      results[index] = await task();
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * 把一个章节翻成中英对照。
 *
 * 返回新对象，不改动入参。单条失败只让那条的 `zh` 留空，不中断整章——
 * 机翻是锦上添花，拿不到中文也不该让今天的摘要整块作废。
 */
export async function translateSection(
  section: DigestSection,
  options: TranslateOptions,
): Promise<DigestSection> {
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const delayMs = options.delayMs ?? 0;
  const texts = collectTexts(section);

  let done = 0;
  const translations = new Map<string, string>();

  const tasks = texts.map((text) => async () => {
    try {
      const translated = await options.translator(text);
      const trimmed = translated.trim();
      if (trimmed !== "") translations.set(text, trimmed);
    } catch {
      // 失败就留空，translations 里没有这条
    }
    done += 1;
    options.onProgress?.(done, texts.length);
  });

  await runPool(tasks, concurrency, delayMs);

  const translateZh = (text: string): string => translations.get(text) ?? "";

  if (section.kind === "items") {
    const items: DigestItem[] = section.items.map((item) => {
      const zh = item.zh === "" && needsTranslation(item.en) ? translateZh(item.en) : item.zh;
      const next: DigestItem = { title: item.title, en: item.en, zh };
      if (item.url !== undefined) next.url = item.url;
      if (item.meta !== undefined) next.meta = item.meta;
      if (item.extraLinks !== undefined) next.extraLinks = item.extraLinks;
      return next;
    });
    return { key: section.key, title: section.title, kind: "items", items };
  }

  const categories: DigestCategory[] = section.categories.map((category) => {
    const titleZh =
      category.titleZh === "" && needsTranslation(category.title)
        ? translateZh(category.title)
        : category.titleZh;

    const items: CategoryItem[] = category.items.map((item) => {
      const zh = item.zh === "" && needsTranslation(item.en) ? translateZh(item.en) : item.zh;
      const next: CategoryItem = { en: item.en, zh };
      if (item.url !== undefined) next.url = item.url;
      return next;
    });

    return { title: category.title, titleZh, items };
  });

  return { key: section.key, title: section.title, kind: "categories", categories };
}
