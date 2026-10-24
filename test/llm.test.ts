import { describe, expect, it } from "bun:test";
import { parseSection } from "../src/llm.ts";

/** 包一层合法的 items 章节 JSON，供各用例复用。 */
function itemsJson(items: unknown): string {
  return JSON.stringify({ items });
}

describe("parseSection：围栏与噪音", () => {
  it("裸 JSON 直接解析", () => {
    const result = parseSection(
      itemsJson([{ title: "owner/repo", url: "https://github.com/owner/repo", en: "A CLI for X." }]),
      "github",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.section.kind).toBe("items");
  });

  it("剥掉 ```json 围栏", () => {
    const raw = "```json\n" + itemsJson([{ title: "a/b", en: "Does things." }]) + "\n```";
    const result = parseSection(raw, "github");
    expect(result.ok).toBe(true);
  });

  it("剥掉不带语言标记的 ``` 围栏", () => {
    const raw = "```\n" + itemsJson([{ title: "a/b", en: "Does things." }]) + "\n```";
    expect(parseSection(raw, "github").ok).toBe(true);
  });

  it("忽略 JSON 前后的解释性文字", () => {
    const raw = "好的，这是结果：\n" + itemsJson([{ title: "a/b", en: "Does things." }]) + "\n希望有用！";
    expect(parseSection(raw, "github").ok).toBe(true);
  });

  it("容忍尾随逗号", () => {
    const raw = '{"items":[{"title":"a/b","en":"Does things.",},],}';
    expect(parseSection(raw, "github").ok).toBe(true);
  });
});

describe("parseSection：结构兼容", () => {
  it("顶层直接是数组时当作 items", () => {
    const raw = JSON.stringify([{ title: "a/b", en: "Does things." }]);
    const result = parseSection(raw, "github");
    expect(result.ok).toBe(true);
    if (!result.ok || result.section.kind !== "items") {
      return;
    }
    expect(result.section.items[0]?.title).toBe("a/b");
  });

  it("items 里的 url 缺省时不报错", () => {
    const result = parseSection(itemsJson([{ title: "a/b", en: "Does things." }]), "github");
    expect(result.ok).toBe(true);
    if (!result.ok || result.section.kind !== "items") {
      return;
    }
    expect(result.section.items[0]?.url).toBeUndefined();
  });

  it("非 http(s) 的 url 被丢弃而不是让整块失败", () => {
    const result = parseSection(
      itemsJson([
        { title: "a/b", url: "javascript:alert(1)", en: "Does things." },
        { title: "c/d", url: "https://github.com/c/d", en: "Also works." },
      ]),
      "github",
    );
    expect(result.ok).toBe(true);
    if (!result.ok || result.section.kind !== "items") {
      return;
    }
    expect(result.section.items).toHaveLength(2);
    expect(result.section.items[0]?.url).toBeUndefined();
  });
});

describe("parseSection：条目校验", () => {
  it("缺 en 的条目被丢弃，其余保留", () => {
    const result = parseSection(
      itemsJson([
        { title: "good", en: "Fine." },
        { title: "no-en" },
        { title: "empty-en", en: "   " },
      ]),
      "github",
    );
    expect(result.ok).toBe(true);
    if (!result.ok || result.section.kind !== "items") {
      return;
    }
    expect(result.section.items).toHaveLength(1);
    expect(result.section.items[0]?.title).toBe("good");
  });

  it("缺 title 的条目被丢弃", () => {
    const result = parseSection(itemsJson([{ en: "No title." }]), "github");
    expect(result.ok).toBe(false);
  });

  it("zh 初始化为空串（中文由机翻填充，模型不产）", () => {
    const result = parseSection(itemsJson([{ title: "a/b", en: "Does things." }]), "github");
    expect(result.ok).toBe(true);
    if (!result.ok || result.section.kind !== "items") {
      return;
    }
    expect(result.section.items[0]?.zh).toBe("");
  });

  it("全部条目非法时判失败，不返回空章节", () => {
    expect(parseSection(itemsJson([]), "github").ok).toBe(false);
    expect(parseSection(itemsJson([{ nope: 1 }]), "github").ok).toBe(false);
  });
});

describe("parseSection：Twitter 分类结构", () => {
  const categoriesRaw = JSON.stringify({
    categories: [
      {
        title: "AI Models & Benchmarks",
        items: [
          { en: "1. @simonw noted the model hit 90% on X.", handles: ["@simonw"] },
          { en: "2. @karpathy compared two runs." },
        ],
      },
      { title: "Empty Category", items: [] },
    ],
  });

  it("解析 categories 并用标题作为条目 title", () => {
    const result = parseSection(categoriesRaw, "twitter");
    expect(result.ok).toBe(true);
    if (!result.ok || result.section.kind !== "categories") {
      return;
    }
    expect(result.section.categories).toHaveLength(1);
    expect(result.section.categories[0]?.title).toBe("AI Models & Benchmarks");
    expect(result.section.categories[0]?.items).toHaveLength(2);
  });

  it("从 handles 推出 x.com 链接", () => {
    const result = parseSection(categoriesRaw, "twitter");
    if (!result.ok || result.section.kind !== "categories") {
      return;
    }
    expect(result.section.categories[0]?.items[0]?.url).toBe("https://x.com/simonw");
  });

  it("空分类被丢弃；全部为空时判失败", () => {
    const result = parseSection(categoriesRaw, "twitter");
    if (!result.ok || result.section.kind !== "categories") {
      return;
    }
    expect(result.section.categories.map((c) => c.title)).not.toContain("Empty Category");

    const empty = JSON.stringify({ categories: [{ title: "Only Empty", items: [] }] });
    expect(parseSection(empty, "twitter").ok).toBe(false);
  });

  it("章节标题由代码填充，不信任模型给的 title", () => {
    const raw = JSON.stringify({ title: "模型乱写的标题", items: [{ title: "a/b", en: "Fine." }] });
    const result = parseSection(raw, "github");
    if (!result.ok) {
      return;
    }
    expect(result.section.title).toBe("GitHub Trending（今日趨勢）");
  });
});

describe("parseSection：彻底非法", () => {
  it("空文本判失败", () => {
    expect(parseSection("", "github").ok).toBe(false);
    expect(parseSection("   \n ", "github").ok).toBe(false);
  });

  it("非 JSON 文本判失败且不抛", () => {
    expect(parseSection("对不起，我无法完成这个任务。", "github").ok).toBe(false);
  });

  it("括号不配平时判失败且不抛", () => {
    expect(parseSection('{"items":[{"title":"a"', "github").ok).toBe(false);
  });

  it("模型输出工具调用时明确报出原因", () => {
    const dsml = '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="read">\n</｜｜DSML｜｜ calls>';
    const result = parseSection(dsml, "twitter");
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("工具调用");
  });

  it("失败时带可读的 error 字符串", () => {
    const result = parseSection("不是 JSON", "github");
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.length).toBeGreaterThan(0);
  });
});
