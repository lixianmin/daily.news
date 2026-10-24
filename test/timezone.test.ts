import { describe, expect, it } from "bun:test";
import { formatShanghai, hourInShanghai, todayInShanghai } from "../src/config.ts";

/**
 * 时区。
 *
 * 存储一律用 UTC ISO，但显示必须是东八区——不然用户会看到
 * 「2026-10-24 星期六」配「2026-10-23 23:59」这种自相矛盾的东西
 * （23:59 是 UTC，实际是东八区 10-24 早上 7:59）。
 */
describe("时区转换", () => {
  it("formatShanghai 把 UTC 转成东八区", () => {
    // UTC 10-23 23:59 = 东八区 10-24 07:59
    expect(formatShanghai("2026-10-23T23:59:49.439Z")).toBe("2026-10-24 07:59");
  });

  it("formatShanghai 处理跨日", () => {
    expect(formatShanghai("2026-10-24T00:38:33.181Z")).toBe("2026-10-24 08:38");
    expect(formatShanghai("2026-10-24T16:00:00.000Z")).toBe("2026-10-25 00:00");
  });

  it("formatShanghai 只取日期时也用东八区", () => {
    expect(formatShanghai("2026-10-23T23:59:49.439Z", false)).toBe("2026-10-24");
  });

  it("formatShanghai 对无效输入返回空串", () => {
    expect(formatShanghai("not a date")).toBe("");
    expect(formatShanghai("")).toBe("");
  });

  it("hourInShanghai 返回东八区小时", () => {
    // UTC 23:00 → 东八区 07:00
    expect(hourInShanghai(new Date("2026-10-23T23:00:00Z"))).toBe(7);
    // UTC 00:00 → 东八区 08:00
    expect(hourInShanghai(new Date("2026-10-24T00:00:00Z"))).toBe(8);
    // UTC 15:00 → 东八区 23:00
    expect(hourInShanghai(new Date("2026-10-24T15:00:00Z"))).toBe(23);
  });

  it("todayInShanghai 用东八区日期", () => {
    // UTC 10-23 23:59 在东八区已经是 10-24
    expect(todayInShanghai(new Date("2026-10-23T23:59:49Z"))).toBe("2026-10-24");
    // UTC 10-24 16:00 在东八区已经是 10-25
    expect(todayInShanghai(new Date("2026-10-24T16:00:00Z"))).toBe("2026-10-25");
  });
});

describe("每日 7:00 定时", () => {
  it("每日定时由 bunqueue cron 负责时区换算，这里只保留小时判定", () => {
    // 东八区 07:00 对应 UTC 23:00
    expect(hourInShanghai(new Date("2026-10-23T23:00:00Z"))).toBe(7);
    // 东八区 06:59 还没到点
    expect(hourInShanghai(new Date("2026-10-23T22:59:00Z"))).toBe(6);
  });
});
