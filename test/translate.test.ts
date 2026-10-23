import { describe, expect, it } from "bun:test";
import { needsTranslation, translateSection } from "../src/translate.ts";
import type { DigestSection } from "../src/types.ts";

/** 假翻译器：把英文包成 `【译】原文`，并记录调用次数。 */
function fakeTranslator() {
  const calls: string[] = [];
  return {
    calls,
    translator: async (text: string) => {
      calls.push(text);
      return `【译】${text}`;
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
    const result = await translateSection(itemsSection, { translator: fake.translator, concurrency: 1 });

    expect(result.kind).toBe("items");
    if (result.kind !== "items") return;
    expect(result.items[0]?.zh).toBe("【译】A fast CLI for X.");
    expect(result.items[1]?.zh).toBe("【译】A Python library.");
    expect(fake.calls).toHaveLength(2);
  });

  it("不改动原始对象（纯函数）", async () => {
    const fake = fakeTranslator();
    await translateSection(itemsSection, { translator: fake.translator, concurrency: 1 });
    expect(itemsSection.kind === "items" && itemsSection.items[0]?.zh).toBe("");
  });

  it("标题与链接不受影响", async () => {
    const fake = fakeTranslator();
    const result = await translateSection(itemsSection, { translator: fake.translator, concurrency: 1 });
    if (result.kind !== "items") return;
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
    const result = await translateSection(section, { translator: fake.translator, concurrency: 1 });
    if (result.kind !== "items") return;
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
    const result = await translateSection(categoriesSection, { translator: fake.translator, concurrency: 1 });

    expect(result.kind).toBe("categories");
    if (result.kind !== "categories") return;
    const category = result.categories[0]!;
    expect(category.titleZh).toBe("【译】AI Models & Benchmarks");
    expect(category.items[0]?.zh).toBe("【译】@simonw benchmarked Qwen.");
    expect(fake.calls).toHaveLength(3); // 1 标题 + 2 要点
  });

  it("英文分类标题原文保留（分类靠 title 排序与展示）", async () => {
    const fake = fakeTranslator();
    const result = await translateSection(categoriesSection, { translator: fake.translator, concurrency: 1 });
    if (result.kind !== "categories") return;
    expect(result.categories[0]?.title).toBe("AI Models & Benchmarks");
  });
});

describe("translateSection：失败容错", () => {
  it("单条翻译失败时 zh 留空，其余继续", async () => {
    const result = await translateSection(itemsSection, {
      translator: async (text) => {
        if (text.includes("Python")) throw new Error("quota exceeded");
        return `【译】${text}`;
      },
      concurrency: 1,
    });

    if (result.kind !== "items") return;
    expect(result.items[0]?.zh).toBe("【译】A fast CLI for X.");
    expect(result.items[1]?.zh).toBe("");
  });

  it("翻译器返回空白视为失败，zh 留空", async () => {
    const result = await translateSection(itemsSection, {
      translator: async () => "   ",
      concurrency: 1,
    });
    if (result.kind !== "items") return;
    expect(result.items[0]?.zh).toBe("");
  });

  it("全部失败也不抛", async () => {
    const result = await translateSection(itemsSection, {
      translator: async () => {
        throw new Error("network down");
      },
      concurrency: 1,
    });
    if (result.kind !== "items") return;
    expect(result.items.map((i) => i.zh)).toEqual(["", ""]);
  });
});

describe("translateSection：进度与并发", () => {
  it("onProgress 报告已完成条数", async () => {
    const seen: number[] = [];
    await translateSection(itemsSection, {
      translator: async (text) => `【译】${text}`,
      concurrency: 1,
      onProgress: (done, total) => {
        seen.push(done);
        expect(total).toBe(2);
      },
    });
    expect(seen).toEqual([1, 2]);
  });

  it("并发数 > 1 时全部条目仍被翻译", async () => {
    const fake = fakeTranslator();
    const result = await translateSection(itemsSection, { translator: fake.translator, concurrency: 4 });
    if (result.kind !== "items") return;
    expect(result.items.every((item) => item.zh.startsWith("【译】"))).toBe(true);
  });
});
