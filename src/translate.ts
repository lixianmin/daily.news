import type { CategoryItem, DigestCategory, DigestItem, DigestSection } from "./types.ts";
/** 翻译的目标语言。 */
export type TargetLang = "en" | "zh-TW";

/**
 * 把一批文字翻到目标语言。
 *
 * 入参与返回**等长**，翻不出来的位置是空串；实现不抛错——
 * 一条翻不出来不该让整章作废。源语言由实现自己判（`sl=auto`）。
 *
 * 用批量而不是逐条：调用点数等于章节数而不是条目数，
 * 免费端点不容易被并发打限流，模型兜底也只花一次调用。
 */
export type Translator = (texts: string[], target: TargetLang) => Promise<string[]>;

export interface TranslateOptions {
  translator: Translator;
  onProgress?: (done: number, total: number) => void;
}

const CJK = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;

/**
 * 文本里有没有中日韩文字。
 *
 * 中文（含繁简）、日文假名、韩文都算——它们都要翻成英文。
 * 只含汉字的判定不够：纯假名的日文推文会被当成英文。
 */
export function hasCjk(text: string): boolean {
  return CJK.test(text);
}

/**
 * 这段文字是否需要翻译。
 *
 * 含中日韩文字就跳过：模型偶尔无视「只写英文」的指令自己写了中文，
 * 再翻一遍只会得到更糟的中文，还白烧额度。
 */
export function needsTranslation(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "") {
    return false;
  }
  return !CJK.test(trimmed);
}

/**
 * 一段文字的两种语言版本。
 *
 * 左列放英文、右列放繁中——两列都是**原文的翻译**，不是总结。
 */
export interface BilingualText {
  en: string;
  zh: string;
}

/**
 * 把一批原文翻成中英两版（与入参等长、顺序一致）。
 *
 * 原文是英文（或其它非中日韩语言）时，英文列就是原文本身，只翻出繁中；
 * 原文是中文/日文/韩文时，两列都要翻。
 *
 * 翻译拿不到时那一列退回原文（英文原文翻不出繁中时留空——
 * 与其让右列重复一遍英文，不如空着）。
 */
export async function toBilingual(texts: string[], translator: Translator): Promise<BilingualText[]> {
  const sources = texts.map((text) => text.trim());
  if (sources.every((text) => text === "")) {
    return sources.map(() => ({ en: "", zh: "" }));
  }

  // 两趟：繁中每一条都要，英文只要给中文/日文/韩文那几条
  const zh = await translateAll(sources, "zh-TW", translator);
  const cjkIndexes = sources.map((text, index) => (hasCjk(text) ? index : -1)).filter((i) => i >= 0);
  const enOfCjk = await translateAll(
    cjkIndexes.map((index) => sources[index] ?? ""),
    "en",
    translator,
  );

  const enByIndex = new Map<number, string>();
  cjkIndexes.forEach((index, at) => {
    enByIndex.set(index, enOfCjk[at] ?? "");
  });

  return sources.map((source, index) => {
    const zhText = zh[index] ?? "";
    if (!hasCjk(source)) {
      return { en: source, zh: zhText };
    }
    const enText = enByIndex.get(index) ?? "";
    return { en: enText === "" ? source : enText, zh: zhText === "" ? source : zhText };
  });
}

/** 翻一批，结果与入参等长；失败位置为空串。 */
async function translateAll(
  texts: string[],
  target: TargetLang,
  translator: Translator,
): Promise<string[]> {
  if (texts.length === 0) {
    return [];
  }
  const translated = await translator(texts, target);
  // 实现约定返回等长数组；万一不守约定也不让调用方读到 undefined
  return texts.map((_text, index) => (translated[index] ?? "").trim());
}

/**
 * 收集一个章节里所有需要翻译的文本，保持出现顺序。
 *
 * 判据是「`zh` 为空 且 `en` 不是中日韩文字」——只看 `en` 是否含中文是不够的，
 * 已有译文的条目会被重复送去翻译，白烧额度。
 */
function collectTexts(section: DigestSection): string[] {
  const texts: string[] = [];
  if (section.kind === "items") {
    for (const item of section.items) {
      if (item.zh === "" && needsTranslation(item.en)) {
        texts.push(item.en);
      }
    }
    return texts;
  }
  for (const category of section.categories) {
    if (category.titleZh === "" && needsTranslation(category.title)) {
      texts.push(category.title);
    }
    for (const item of category.items) {
      if (item.zh === "" && needsTranslation(item.en)) {
        texts.push(item.en);
      }
    }
  }
  return texts;
}

/**
 * 把一个章节翻成中英对照。
 *
 * 返回新对象，不改动入参。整批失败只让这些条目的 `zh` 留空，不中断整章——
 * 拿不到中文也不该让今天的摘要整块作废。
 */
export async function translateSection(
  section: DigestSection,
  options: TranslateOptions,
): Promise<DigestSection> {
  const texts = collectTexts(section);
  const translated = await translateAll(texts, "zh-TW", options.translator);
  options.onProgress?.(translated.length, texts.length);

  const translations = new Map<string, string>();
  texts.forEach((text, index) => {
    const value = translated[index] ?? "";
    if (value !== "") {
      translations.set(text, value);
    }
  });

  const translateZh = (text: string): string => translations.get(text) ?? "";

  if (section.kind === "items") {
    const items: DigestItem[] = section.items.map((item) => {
      const zh = item.zh === "" && needsTranslation(item.en) ? translateZh(item.en) : item.zh;
      const next: DigestItem = { title: item.title, en: item.en, zh };
      if (item.url !== undefined) {
        next.url = item.url;
      }
      if (item.meta !== undefined) {
        next.meta = item.meta;
      }
      if (item.extraLinks !== undefined) {
        next.extraLinks = item.extraLinks;
      }
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
      // 保留 url / handle / time：这几个是渲染行首链接用的，
      // 重建对象时漏掉它们，页面上就只剩正文，@handle 消失
      const next: CategoryItem = { ...item };
      next.zh = item.zh === "" && needsTranslation(item.en) ? translateZh(item.en) : item.zh;
      return next;
    });

    return { title: category.title, titleZh, items };
  });

  return { key: section.key, title: section.title, kind: "categories", categories };
}
