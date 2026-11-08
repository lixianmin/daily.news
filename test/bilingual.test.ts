import { describe, expect, it } from "bun:test";
import { hasCjk, toBilingual, type TargetLang, type Translator } from "../src/translate.ts";

/** 假翻译器：按目标语言加前缀，并记录调用（一调用 = 一批）。 */
function fakeTranslator() {
  const calls: Array<{ texts: string[]; target: TargetLang }> = [];
  return {
    calls,
    translator: async (texts: string[], target: TargetLang): Promise<string[]> => {
      calls.push({ texts, target });
      return texts.map((text) => `[${target}]${text}`);
    },
  };
}

/** 总是失败的翻译器（返回空串，符合 Translator 的约定）。 */
function failingTranslator(): Translator {
  return async (texts: string[]): Promise<string[]> => texts.map(() => "");
}

describe("hasCjk", () => {
  it("中文算", () => {
    expect(hasCjk("全网都看傻了")).toBe(true);
  });

  it("日文假名也算（纯假名没有汉字）", () => {
    expect(hasCjk("おはようございます")).toBe(true);
  });

  it("英文不算", () => {
    expect(hasCjk("The whole internet was dumbfounded.")).toBe(false);
  });
});

describe("toBilingual：英文原文", () => {
  it("左列就是原文，不翻", async () => {
    const fake = fakeTranslator();
    const [out] = await toBilingual(["The whole internet was dumbfounded."], fake.translator);
    expect(out?.en).toBe("The whole internet was dumbfounded.");
  });

  it("右列是繁中译文", async () => {
    const fake = fakeTranslator();
    const [out] = await toBilingual(["The whole internet was dumbfounded."], fake.translator);
    expect(out?.zh).toBe("[zh-TW]The whole internet was dumbfounded.");
  });

  it("只发一趟繁中请求（英文原文不需要翻英文）", async () => {
    const fake = fakeTranslator();
    await toBilingual(["The whole internet was dumbfounded."], fake.translator);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.target).toBe("zh-TW");
  });

  it("繁中翻不出来时右列留空（不重复一遍英文）", async () => {
    const [out] = await toBilingual(["The whole internet was dumbfounded."], failingTranslator());
    expect(out?.en).toBe("The whole internet was dumbfounded.");
    expect(out?.zh).toBe("");
  });
});

describe("toBilingual：中文原文", () => {
  it("左列是英文译文，右列是繁中译文", async () => {
    const fake = fakeTranslator();
    const [out] = await toBilingual(["全网都看傻了。"], fake.translator);
    expect(out?.en).toBe("[en]全网都看傻了。");
    expect(out?.zh).toBe("[zh-TW]全网都看傻了。");
  });

  it("两趟请求：一趟繁中、一趟英文", async () => {
    const fake = fakeTranslator();
    await toBilingual(["全网都看傻了。"], fake.translator);
    expect(fake.calls.map((c) => c.target).sort()).toEqual(["en", "zh-TW"]);
  });

  it("英文翻不出来时左列退回原文，不丢内容", async () => {
    const onlyZh: Translator = async (texts, target) =>
      texts.map((text) => (target === "en" ? "" : `[zh-TW]${text}`));
    const [out] = await toBilingual(["全网都看傻了。"], onlyZh);
    expect(out?.en).toBe("全网都看傻了。");
    expect(out?.zh).toBe("[zh-TW]全网都看傻了。");
  });

  it("繁中翻不出来时右列退回原文", async () => {
    const onlyEn: Translator = async (texts, target) =>
      texts.map((text) => (target === "zh-TW" ? "" : `[en]${text}`));
    const [out] = await toBilingual(["全网都看傻了。"], onlyEn);
    expect(out?.zh).toBe("全网都看傻了。");
  });
});

describe("toBilingual：一批多条", () => {
  it("结果与入参等长、顺序一致", async () => {
    const fake = fakeTranslator();
    const out = await toBilingual(["英文一。", "The second one.", "第三条"], fake.translator);
    expect(out).toHaveLength(3);
    expect(out[0]?.en).toBe("[en]英文一。");
    expect(out[1]?.en).toBe("The second one.");
    expect(out[1]?.zh).toBe("[zh-TW]The second one.");
    expect(out[2]?.en).toBe("[en]第三条");
  });

  it("英文那几条不进英文那一趟（省额度）", async () => {
    const fake = fakeTranslator();
    await toBilingual(["中文一", "English two", "中文三"], fake.translator);
    const enCall = fake.calls.find((c) => c.target === "en");
    expect(enCall?.texts).toEqual(["中文一", "中文三"]);
  });
});

describe("toBilingual：边界", () => {
  it("空文本返回两个空串", async () => {
    const fake = fakeTranslator();
    const [out] = await toBilingual(["   "], fake.translator);
    expect(out?.en).toBe("");
    expect(out?.zh).toBe("");
    expect(fake.calls).toHaveLength(0);
  });

  it("实现返回的数组偏短时不抛错（按空串处理）", async () => {
    const short: Translator = async (): Promise<string[]> => [];
    const out = await toBilingual(["全网都看傻了。"], short);
    expect(out[0]?.en).toBe("全网都看傻了。");
    expect(out[0]?.zh).toBe("全网都看傻了。");
  });
});
