import { describe, expect, it } from "bun:test";
import { buildZhihuSection, parseZhihu } from "../src/zhihu.ts";
import type { TargetLang, Translator } from "../src/translate.ts";

const md = [
  "## 知乎熱榜（24小時）",
  "",
  "- **如何看待深圳一机顶盒厂商在 130 万台出厂设备中预埋系统级后门，并将控制权出售给黑产的行为？**  — IT 之家 11 月 4 日消息，谷歌近日捣毁了一项大规模僵尸网络行动。（359 万热度）  |  https://www.zhihu.com/question/2101846693520085716",
  "- **怎么看字节跳动的扣子宣布下线解散，AI 工作流是不是已经没有市场了？**  |  https://www.zhihu.com/question/2101391707430565604",
  "- **理论上讲，通缉犯躲进原始森林，能否躲到寿终正寝不被抓？**  — 前提是这个人完全可以适应一个人在原始森林的生活。（125 万热度）  |  https://www.zhihu.com/question/2100529507614581364",
].join("\n");

describe("parseZhihu", () => {
  it("取出标题、摘要片段与链接", () => {
    const items = parseZhihu(md);
    expect(items).toHaveLength(3);
    expect(items[0]?.title).toBe(
      "如何看待深圳一机顶盒厂商在 130 万台出厂设备中预埋系统级后门，并将控制权出售给黑产的行为？",
    );
    expect(items[0]?.excerpt).toBe("IT 之家 11 月 4 日消息，谷歌近日捣毁了一项大规模僵尸网络行动。");
    expect(items[0]?.url).toBe("https://www.zhihu.com/question/2101846693520085716");
  });

  it("取出热度", () => {
    const items = parseZhihu(md);
    expect(items[0]?.heat).toBe("359 万热度");
    expect(items[2]?.heat).toBe("125 万热度");
  });

  it("没有摘要片段时留空", () => {
    const items = parseZhihu(md);
    expect(items[1]?.excerpt).toBe("");
    expect(items[1]?.title).toBe("怎么看字节跳动的扣子宣布下线解散，AI 工作流是不是已经没有市场了？");
  });

  it("非条目行被忽略", () => {
    const items = parseZhihu("## 知乎熱榜（24小時）\n\n⚠️ 抓取失敗：無數據\n");
    expect(items).toEqual([]);
  });

  it("空输入返回空数组", () => {
    expect(parseZhihu("")).toEqual([]);
  });
});

describe("buildZhihuSection", () => {
  /** 假翻译器：按目标语言加前缀（一次一批）。 */
  const fakeTranslator: Translator = async (texts: string[], target: TargetLang) =>
    texts.map((text) => `[${target}]${text}`);

  it("标题保持中文原题，正文是翻译结果", async () => {
    const section = await buildZhihuSection({
      items: parseZhihu(md),
      translator: fakeTranslator,
    });

    expect(section.kind).toBe("items");
    if (section.kind !== "items") {
      return;
    }
    const item = section.items[0];
    expect(item?.title).toBe(
      "如何看待深圳一机顶盒厂商在 130 万台出厂设备中预埋系统级后门，并将控制权出售给黑产的行为？",
    );
    expect(item?.en).toContain("[en]");
    expect(item?.zh).toContain("[zh-TW]");
    expect(item?.url).toBe("https://www.zhihu.com/question/2101846693520085716");
  });

  it("译文里包含问题与摘要片段", async () => {
    const section = await buildZhihuSection({
      items: parseZhihu(md),
      translator: fakeTranslator,
    });

    if (section.kind !== "items") {
      return;
    }
    const en = section.items[0]?.en ?? "";
    expect(en).toContain("如何看待深圳一机顶盒厂商");
    expect(en).toContain("谷歌近日捣毁了一项大规模僵尸网络行动");
  });
});
