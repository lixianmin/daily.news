import { describe, expect, it } from "bun:test";
import { splitForTranslation } from "../src/translator.ts";

/**
 * 长文本切段。
 *
 * 免费端点有硬上限：MyMemory 单次 500 字符，超了直接返回
 * `QUERY LENGTH LIMIT EXCEEDED`（实测把整段知乎摘要当译文写进页面）。
 * 所以超长文本必须先切段，逐段翻完再拼回去。
 */
describe("splitForTranslation", () => {
  it("短文本不切", () => {
    expect(splitForTranslation("The whole internet was dumbfounded.")).toEqual([
      "The whole internet was dumbfounded.",
    ]);
  });

  it("每段都不超过上限", () => {
    const text = "这是第一句。".repeat(200);
    const parts = splitForTranslation(text);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(450);
    }
  });

  it("拼回去等于原文（不丢字）", () => {
    const text = "北京时间 11 月 8 日，S16 半决赛第一场，GEN 3-0 横扫 iG 晋级决赛。".repeat(30);
    expect(splitForTranslation(text).join("")).toBe(text);
  });

  it("优先在句末断开", () => {
    const sentence = "这是一个完整句子，长度为二十六个字符左右。"; // 22 字
    const text = sentence.repeat(40);
    const parts = splitForTranslation(text);
    for (const part of parts.slice(0, -1)) {
      expect(part.endsWith("。")).toBe(true);
    }
  });

  it("没有句号时在逗号或空格处断开", () => {
    const text = "word ".repeat(300);
    const parts = splitForTranslation(text);
    for (const part of parts.slice(0, -1)) {
      expect(part.length).toBeLessThanOrEqual(450);
    }
    expect(parts.join("")).toBe(text);
  });

  it("超长无标点串也能切（不能死循环）", () => {
    const text = "字".repeat(1200);
    const parts = splitForTranslation(text);
    expect(parts.join("")).toBe(text);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(450);
    }
  });

  it("空串返回空数组", () => {
    expect(splitForTranslation("")).toEqual([]);
  });
});
