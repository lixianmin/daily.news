import { afterEach, describe, expect, it } from "bun:test";
import { createTranslator } from "../src/translator.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** 把免费端点打死（离线），逼翻译走模型兜底。 */
function killFreeEndpoints(): void {
  globalThis.fetch = (async () => {
    throw new Error("offline");
  }) as unknown as typeof fetch;
}

describe("createTranslator：模型兜底按段", () => {
  it("兜底收到的是 ≤450 字的段，拼回去等于原文", async () => {
    killFreeEndpoints();
    const long = "北京时间 11 月 8 日，S16 半决赛第一场，GEN 3-0 横扫 iG 晋级决赛。".repeat(30);
    const batches: string[][] = [];
    const translator = createTranslator({
      modelTranslate: async (options) => {
        batches.push(options.texts);
        // 原样返回：便于核对拼接结果
        return options.texts;
      },
    });

    const [out] = await translator([long], "zh-TW");
    const pieces = batches.flat();

    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(piece.length).toBeLessThanOrEqual(450);
    }
    expect(pieces.join("")).toBe(long);
    expect(out).toBe(long);
  });

  it("短文本兜底只发一段，不额外切", async () => {
    killFreeEndpoints();
    const batches: string[][] = [];
    const translator = createTranslator({
      modelTranslate: async (options) => {
        batches.push(options.texts);
        return options.texts.map((text) => `【译】${text}`);
      },
    });

    const [out] = await translator(["Short tweet body."], "zh-TW");
    expect(batches).toEqual([["Short tweet body."]]);
    expect(out).toBe("【译】Short tweet body.");
  });

  it("兜底也拿不到时保留空串，不抛错", async () => {
    killFreeEndpoints();
    const translator = createTranslator({ modelTranslate: async () => undefined });
    const [out] = await translator(["Short tweet body."], "zh-TW");
    expect(out).toBe("");
  });
});
