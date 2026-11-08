import { describe, expect, it } from "bun:test";
import { parseSection, parseTweetCategories } from "../src/llm.ts";

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
    expect(result.value.kind).toBe("items");
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
    if (!result.ok || result.value.kind !== "items") {
      return;
    }
    expect(result.value.items[0]?.title).toBe("a/b");
  });

  it("items 里的 url 缺省时不报错", () => {
    const result = parseSection(itemsJson([{ title: "a/b", en: "Does things." }]), "github");
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.kind !== "items") {
      return;
    }
    expect(result.value.items[0]?.url).toBeUndefined();
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
    if (!result.ok || result.value.kind !== "items") {
      return;
    }
    expect(result.value.items).toHaveLength(2);
    expect(result.value.items[0]?.url).toBeUndefined();
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
    if (!result.ok || result.value.kind !== "items") {
      return;
    }
    expect(result.value.items).toHaveLength(1);
    expect(result.value.items[0]?.title).toBe("good");
  });

  it("缺 title 的条目被丢弃", () => {
    const result = parseSection(itemsJson([{ en: "No title." }]), "github");
    expect(result.ok).toBe(false);
  });

  it("zh 初始化为空串（中文由机翻填充，模型不产）", () => {
    const result = parseSection(itemsJson([{ title: "a/b", en: "Does things." }]), "github");
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.kind !== "items") {
      return;
    }
    expect(result.value.items[0]?.zh).toBe("");
  });

  it("全部条目非法时判失败，不返回空章节", () => {
    expect(parseSection(itemsJson([]), "github").ok).toBe(false);
    expect(parseSection(itemsJson([{ nope: 1 }]), "github").ok).toBe(false);
  });
});

describe("parseSection：Twitter 不再走逐条解析", () => {
  it("Twitter 走分类解析，逐条解析直接判失败", () => {
    const raw = JSON.stringify({ categories: [{ title: "x", tweetIds: [1] }] });
    const result = parseSection(raw, "twitter");
    expect(result.ok).toBe(false);
  });
});

describe("parseTweetCategories：推文分类", () => {
  const raw = JSON.stringify({
    categories: [
      { title: "AI Models & Benchmarks", tweetIds: [1, 4, 7] },
      { title: "Open Source & Dev", tweetIds: [2] },
      { title: "Empty Category", tweetIds: [] },
      { title: "", tweetIds: [3] },
    ],
  });

  it("解析分类与推文编号", () => {
    const result = parseTweetCategories(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value).toHaveLength(2);
    expect(result.value[0]?.title).toBe("AI Models & Benchmarks");
    expect(result.value[0]?.tweetIds).toEqual([1, 4, 7]);
  });

  it("空分类与空标题的分类被丢掉", () => {
    const result = parseTweetCategories(raw);
    if (!result.ok) {
      return;
    }
    expect(result.value.map((c) => c.title)).not.toContain("Empty Category");
  });

  it("重复的编号只留一个", () => {
    const dup = JSON.stringify({ categories: [{ title: "x", tweetIds: [1, 1, 2] }] });
    const result = parseTweetCategories(dup);
    if (!result.ok) {
      return;
    }
    expect(result.value[0]?.tweetIds).toEqual([1, 2]);
  });

  it("非法编号被丢掉", () => {
    const bad = JSON.stringify({ categories: [{ title: "x", tweetIds: [1, 0, -2, "3", 2.5] }] });
    const result = parseTweetCategories(bad);
    if (!result.ok) {
      return;
    }
    expect(result.value[0]?.tweetIds).toEqual([1]);
  });

  it("剥掉 ```json 围栏", () => {
    const fenced = "```json\n" + raw + "\n```";
    expect(parseTweetCategories(fenced).ok).toBe(true);
  });

  it("空响应判失败", () => {
    expect(parseTweetCategories("").ok).toBe(false);
  });

  it("非 JSON 判失败且不抛", () => {
    expect(parseTweetCategories("对不起，我无法完成这个任务。").ok).toBe(false);
  });

  it("模型输出工具调用时明确报出原因", () => {
    const dsml = '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="read">\n</｜｜DSML｜｜ calls>';
    const result = parseTweetCategories(dsml);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("工具调用");
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
