import { describe, expect, it } from "bun:test";
import { buildTwitterChunk } from "../src/generator.ts";

describe("buildTwitterChunk", () => {
  const raw = [
    "# Home / X",
    "> https://x.com/home",
    "",
    "What’s happening?",
    "---",
    "**Post**",
    "---",
    "**lidang 立党 （劝人卖房）** @lidangzzz [1]·2h [2]",
    "[3]",
    "",
    "这是正文，很长很长很长……",
    "37 Replies 8 reposts 287 Likes 58111 views [3]",
    "---",
    "**宝玉 [4]** @dotey [4]·10h [5]",
    "我猜测 Tibo 搞这个活动。",
    "12 Replies 3 reposts 45 Likes 1200 views [6]",
    "---",
  ].join("\n");

  it("保留推文首行（含 handle）", () => {
    const chunk = buildTwitterChunk(raw);
    expect(chunk).toContain("@lidangzzz");
    expect(chunk).toContain("@dotey");
  });

  it("保留互动数行", () => {
    const chunk = buildTwitterChunk(raw);
    expect(chunk).toContain("37 Replies 8 reposts 287 Likes 58111 views");
  });

  it("保留正文但用 <tweet_text> 标记成数据", () => {
    const chunk = buildTwitterChunk(raw);
    // 正文要留着——没正文模型只能输出空数组
    expect(chunk).toContain("这是正文");
    // 但要标记成数据，配合专用 system prompt 让模型不当指令
    expect(chunk).toContain("<tweet_text>");
    expect(chunk).toContain("</tweet_text>");
  });

  it("丢掉页面噪音行", () => {
    const chunk = buildTwitterChunk(raw);
    expect(chunk).not.toContain("# Home / X");
    expect(chunk).not.toContain("What’s happening?");
    expect(chunk).not.toContain("---");
  });

  it("不把网址与脚注标记当正文", () => {
    const chunk = buildTwitterChunk(raw);
    expect(chunk).not.toContain("> https://x.com/home");
    // [N] 脚注编号保留在首行里（handle 后面），但不应出现独立的脚注行
    expect(chunk).not.toMatch(/^\[\d+\]$/m);
  });

  it("结果远小于原文", () => {
    const chunk = buildTwitterChunk(raw);
    expect(chunk.length).toBeLessThan(raw.length);
  });

  it("空输入返回空串", () => {
    expect(buildTwitterChunk("")).toBe("");
  });

  it("没有推文行时返回空串", () => {
    expect(buildTwitterChunk("just some noise\nnothing here")).toBe("");
  });
});
