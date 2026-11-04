import { describe, expect, it } from "bun:test";
import { attemptedSources, fillMissingStatuses, mergeSourceStatus } from "../src/generator.ts";
import { SOURCE_KEYS } from "../src/types.ts";

/**
 * 多块来源的状态统计。
 *
 * 曾经的 bug：知乎拆成两块（1-10 / 11-20），第二块生成失败时
 * `statuses[key] = { ok: false, count: 0 }` 直接覆盖了第一块的
 * `{ ok: true, count: 5 }` —— 明明有 5 条数据，页面却显示「知乎失败」，
 * 还会触发一次没必要的补生成。
 */
describe("attemptedSources", () => {
  it("全量生成：四个来源都算本轮的", () => {
    expect(attemptedSources([...SOURCE_KEYS])).toEqual([...SOURCE_KEYS]);
  });

  it("补生成：只算要补的那几个", () => {
    expect(attemptedSources([...SOURCE_KEYS], ["twitter"])).toEqual(["twitter"]);
  });
});

describe("fillMissingStatuses", () => {
  it("本轮负责但没产出的来源补一条失败状态", () => {
    const statuses = fillMissingStatuses({ twitter: { ok: true, count: 8 } }, ["twitter", "github"]);
    expect(statuses.twitter).toEqual({ ok: true, count: 8 });
    expect(statuses.github).toEqual({ ok: false, count: 0, error: "无数据或生成失败" });
  });

  it("补生成时不给没轮到的来源加失败状态（核心回归）", () => {
    // 曾经的 bug：补生成只补了 twitter，却按“四个来源”补失败状态，
    // 页面上凭空多出三个 ⚠️，重试链也一直带着它们。
    const statuses = fillMissingStatuses({ twitter: { ok: true, count: 8 } }, ["twitter"]);
    expect(Object.keys(statuses)).toEqual(["twitter"]);
  });
});

describe("mergeSourceStatus", () => {
  it("第一块成功：ok 为 true，条数正确", () => {
    const status = mergeSourceStatus(undefined, { ok: true, count: 5 });
    expect(status.ok).toBe(true);
    expect(status.count).toBe(5);
  });

  it("第二块成功：条数累加", () => {
    const first = mergeSourceStatus(undefined, { ok: true, count: 5 });
    const second = mergeSourceStatus(first, { ok: true, count: 5 });
    expect(second.ok).toBe(true);
    expect(second.count).toBe(10);
  });

  it("第一块失败：整来源失败", () => {
    const status = mergeSourceStatus(undefined, { ok: false, count: 0, error: "解析失败" });
    expect(status.ok).toBe(false);
    expect(status.error).toContain("解析失败");
  });

  it("第二块失败：不覆盖第一块的成功状态（核心回归）", () => {
    const first = mergeSourceStatus(undefined, { ok: true, count: 5 });
    const second = mergeSourceStatus(first, { ok: false, count: 0, error: "解析失败" });

    // 关键：已有成功块时，失败不能把整来源标成失败
    expect(second.ok).toBe(true);
    expect(second.count).toBe(5);
    // 但失败原因要留下来
    expect(second.error).toContain("解析失败");
  });

  it("第二块失败时错误信息标为「部分块失败」", () => {
    const first = mergeSourceStatus(undefined, { ok: true, count: 5 });
    const second = mergeSourceStatus(first, { ok: false, count: 0, error: "超时" });
    expect(second.error).toContain("部分块失败");
    expect(second.error).toContain("超时");
  });

  it("连续两块都失败：仍是失败", () => {
    const first = mergeSourceStatus(undefined, { ok: false, count: 0, error: "A" });
    const second = mergeSourceStatus(first, { ok: false, count: 0, error: "B" });
    expect(second.ok).toBe(false);
    expect(second.error).toContain("B");
  });

  it("先失败后成功：转为成功", () => {
    const first = mergeSourceStatus(undefined, { ok: false, count: 0, error: "A" });
    const second = mergeSourceStatus(first, { ok: true, count: 5 });
    expect(second.ok).toBe(true);
    expect(second.count).toBe(5);
  });

  it("成功后再成功：条数继续累加，不丢数据", () => {
    let s = mergeSourceStatus(undefined, { ok: true, count: 5 });
    s = mergeSourceStatus(s, { ok: true, count: 5 });
    s = mergeSourceStatus(s, { ok: true, count: 3 });
    expect(s.count).toBe(13);
    expect(s.ok).toBe(true);
  });
});
