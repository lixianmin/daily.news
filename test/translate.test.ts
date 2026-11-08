import { describe, expect, it } from "bun:test";
import { needsTranslation, translateSection } from "../src/translate.ts";
import type { DigestSection } from "../src/types.ts";

/** 假翻译器：把每一条包成 `【译】原文`，并记录调用（一次调用 = 一批）。 */
function fakeTranslator() {
  const calls: string[][] = [];
  return {
    calls,
    translator: async (texts: string[]): Promise<string[]> => {
      calls.push(texts);
      return texts.map((text) => `【译】${text}`);
    },
  };
}

const itemsSection: DigestSection = {
  key: "github",
  title: "GitHub Trending（今日趨勢）",
  kind: "items",
  items: [
    { title: "owner/repo", url: "https://github.com/owner/repo", en: "A fast CLI for X.", zh: "" },
    { title: "other/lib", en: "A Python library.", zh: "" },
  ],
};

describe("needsTranslation", () => {
  it("纯英文需要翻译", () => {
    expect(needsTranslation("A fast CLI for X.")).toBe(true);
  });

  it("含中文不需要翻译（模型偶尔自己写了中文）", () => {
    expect(needsTranslation("一個快速的 CLI。")).toBe(false);
    expect(needsTranslation("This 工具 does X.")).toBe(false);
  });

  it("空白不需要翻译", () => {
    expect(needsTranslation("   ")).toBe(false);
    expect(needsTranslation("")).toBe(false);
  });
});

describe("translateSection：items", () => {
  it("逐条填充 zh", async () => {
    const fake = fakeTranslator();
    const result = await translateSection(itemsSection, { translator: fake.translator });

    expect(result.kind).toBe("items");
    if (result.kind !== "items") {
      return;
    }
    expect(result.items[0]?.zh).toBe("【译】A fast CLI for X.");
    expect(result.items[1]?.zh).toBe("【译】A Python library.");
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toHaveLength(2);
  });

  it("不改动原始对象（纯函数）", async () => {
    const fake = fakeTranslator();
    await translateSection(itemsSection, { translator: fake.translator });
    expect(itemsSection.kind === "items" && itemsSection.items[0]?.zh).toBe("");
  });

  it("标题与链接不受影响", async () => {
    const fake = fakeTranslator();
    const result = await translateSection(itemsSection, { translator: fake.translator });
    if (result.kind !== "items") {
      return;
    }
    expect(result.items[0]?.title).toBe("owner/repo");
    expect(result.items[0]?.url).toBe("https://github.com/owner/repo");
  });

  it("已有中文的条目跳过，不重复消耗额度", async () => {
    const fake = fakeTranslator();
    const section: DigestSection = {
      key: "github",
      title: "t",
      kind: "items",
      items: [
        { title: "a/b", en: "A fast CLI.", zh: "一個快速的 CLI。" },
        { title: "c/d", en: "Another thing.", zh: "" },
      ],
    };
    const result = await translateSection(section, { translator: fake.translator });
    if (result.kind !== "items") {
      return;
    }
    expect(result.items[0]?.zh).toBe("一個快速的 CLI。");
    expect(result.items[1]?.zh).toBe("【译】Another thing.");
    expect(fake.calls).toHaveLength(1);
  });
});

describe("translateSection：categories", () => {
  const categoriesSection: DigestSection = {
    key: "twitter",
    title: "Twitter 時間線",
    kind: "categories",
    categories: [
      {
        title: "AI Models & Benchmarks",
        titleZh: "",
        items: [
          { en: "@simonw benchmarked Qwen.", zh: "", url: "https://x.com/simonw" },
          { en: "@karpathy compared runs.", zh: "" },
        ],
      },
    ],
  };

  it("分类标题与要点都翻译", async () => {
    const fake = fakeTranslator();
    const result = await translateSection(categoriesSection, { translator: fake.translator });

    expect(result.kind).toBe("categories");
    if (result.kind !== "categories") {
      return;
    }
    const category = result.categories[0]!;
    expect(category.titleZh).toBe("【译】AI Models & Benchmarks");
    expect(category.items[0]?.zh).toBe("【译】@simonw benchmarked Qwen.");
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toHaveLength(3); // 1 标题 + 2 要点
  });

  it("英文分类标题原文保留（分类靠 title 排序与展示）", async () => {
    const fake = fakeTranslator();
    const result = await translateSection(categoriesSection, { translator: fake.translator });
    if (result.kind !== "categories") {
      return;
    }
    expect(result.categories[0]?.title).toBe("AI Models & Benchmarks");
  });

  it("保留 handle 与 time（渲染行首链接要用，重建对象时漏掉就没了）", async () => {
    const section: DigestSection = {
      key: "twitter",
      title: "Twitter 時間線",
      kind: "categories",
      categories: [
        {
          title: "AI",
          titleZh: "AI",
          items: [
            {
              en: "The whole internet was dumbfounded.",
              zh: "全網都看傻了。",
              url: "https://x.com/foo/status/1",
              handle: "@foo",
              time: "18h",
            },
          ],
        },
      ],
    };

    const fake = fakeTranslator();
    const result = await translateSection(section, { translator: fake.translator });
    if (result.kind !== "categories") {
      return;
    }
    const item = result.categories[0]?.items[0];
    expect(item?.handle).toBe("@foo");
    expect(item?.time).toBe("18h");
    expect(item?.url).toBe("https://x.com/foo/status/1");
  });
});

describe("translateSection：失败容错", () => {
  it("单条翻译失败时 zh 留空，其余继续", async () => {
    const result = await translateSection(itemsSection, {
      translator: async (texts) =>
        texts.map((text) => (text.includes("Python") ? "" : `【译】${text}`)),
    });

    if (result.kind !== "items") {
      return;
    }
    expect(result.items[0]?.zh).toBe("【译】A fast CLI for X.");
    expect(result.items[1]?.zh).toBe("");
  });

  it("翻译器返回空白视为失败，zh 留空", async () => {
    const result = await translateSection(itemsSection, {
      translator: async (texts) => texts.map(() => "   "),
    });
    if (result.kind !== "items") {
      return;
    }
    expect(result.items[0]?.zh).toBe("");
  });

  it("全部失败也不抛", async () => {
    const result = await translateSection(itemsSection, {
      translator: async (texts) => texts.map(() => ""),
    });
    if (result.kind !== "items") {
      return;
    }
    expect(result.items.map((i) => i.zh)).toEqual(["", ""]);
  });
});

describe("translateSection：进度", () => {
  it("onProgress 报告已完成条数（整批一次）", async () => {
    const seen: Array<[number, number]> = [];
    await translateSection(itemsSection, {
      translator: async (texts) => texts.map((text) => `【译】${text}`),
      onProgress: (done, total) => {
        seen.push([done, total]);
      },
    });
    expect(seen).toEqual([[2, 2]]);
  });

  it("一批之内全部条目都被翻译", async () => {
    const fake = fakeTranslator();
    const result = await translateSection(itemsSection, { translator: fake.translator });
    if (result.kind !== "items") {
      return;
    }
    expect(result.items.every((item) => item.zh.startsWith("【译】"))).toBe(true);
  });
});
