import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchTwitterRaw, fetchTwitterTimeline, renderTwitterRaw, type Tweet } from "../../src/chrome/twitter.ts";
import type { ChromeBridge } from "../../src/chrome/bridge.ts";

/** 假桥：按动作名返回预设结果，并记录调用顺序。 */
function stubBridge(handler: (action: string, params: Record<string, unknown>) => unknown): {
  bridge: ChromeBridge;
  calls: { action: string; params: Record<string, unknown> }[];
} {
  const calls: { action: string; params: Record<string, unknown> }[] = [];
  const bridge = {
    role: "server" as const,
    status: async () => ({ url: "http://127.0.0.1:0", mode: "server" as const, connected: true, queuedCommands: 0, pendingCommands: 0 }),
    send: async (action: string, params: Record<string, unknown> = {}) => {
      calls.push({ action, params });
      return handler(action, params);
    },
  } as unknown as ChromeBridge;
  return { bridge, calls };
}

const SAMPLE: Tweet[] = [
  {
    name: "Ivan Fioravanti",
    handle: "@ivanfioravanti",
    time: "2026-11-03T18:35:00.000Z",
    text: "DeepSeek Harness is just amazing",
    url: "https://x.com/ivanfioravanti/status/2117687000681607545",
    replies: 34,
    reposts: 12,
    likes: 331,
    views: 19361,
  },
  {
    name: "范凯说AI",
    handle: "@fankaishuoai",
    time: "2026-11-03T03:07:30.000Z",
    text: "我在反思，总是在追求最强 Agent",
    url: "https://x.com/fankaishuoai/status/2117453587286839791",
    replies: 17,
    reposts: 6,
    likes: 58,
    views: 10260,
  },
];

const NOW = new Date("2026-11-04T03:00:00.000Z");

describe("renderTwitterRaw", () => {
  it("输出与 dokobot 同构的文本：推文块 + 指标行 + 脚注区", () => {
    const raw = renderTwitterRaw(SAMPLE, NOW);
    expect(raw).toBe(
      [
        "**Ivan Fioravanti** @ivanfioravanti [1]·8h [2]",
        "DeepSeek Harness is just amazing",
        "34 Replies 12 reposts 331 Likes 19361 views",
        "---",
        "**范凯说AI** @fankaishuoai [3]·23h [4]",
        "我在反思，总是在追求最强 Agent",
        "17 Replies 6 reposts 58 Likes 10260 views",
        "",
        "[1] https://x.com/ivanfioravanti",
        "[2] https://x.com/ivanfioravanti/status/2117687000681607545",
        "[3] https://x.com/fankaishuoai",
        "[4] https://x.com/fankaishuoai/status/2117453587286839791",
        "",
      ].join("\n"),
    );
  });

  it("正文里以 ** 开头的行加前导空格（否则被下游当成下一条推文）", () => {
    const raw = renderTwitterRaw(
      [{ ...SAMPLE[0]!, text: "**加粗**开头\n普通行" }],
      NOW,
    );
    expect(raw).toContain("\n **加粗**开头\n普通行");
  });

  it("正文里恰好是 --- 的行加前导空格（否则被下游当成分隔线）", () => {
    const raw = renderTwitterRaw([{ ...SAMPLE[0]!, text: "第一行\n---\n第三行" }], NOW);
    expect(raw).toContain("\n ---\n");
  });

  it("缺互动数时不写那一项", () => {
    const raw = renderTwitterRaw([{ ...SAMPLE[0]!, replies: null, reposts: null, likes: null, views: null }], NOW);
    expect(raw).not.toContain("Replies");
    expect(raw).not.toContain("views");
    expect(raw).toContain("DeepSeek Harness is just amazing");
  });
});

describe("fetchTwitterTimeline", () => {
  it("开标签页 → 等推文渲染 → 滚动 → 提取 → 关标签页", async () => {
    const { bridge, calls } = stubBridge((action, params) => {
      if (action === "tab.new") {
        return { tab: { id: 42 } };
      }
      if (action === "page.evaluate") {
        const expression = String(params.expression ?? "");
        if (expression.includes("tweets:")) {
          return { tweets: SAMPLE };
        }
        return 6;
      }
      return { ok: true };
    });

    const tweets = await fetchTwitterTimeline({ bridge, scrolls: 2, minTweets: 2, waitMs: 1_000 });
    expect(tweets).toEqual(SAMPLE);
    expect(calls[0]?.action).toBe("tab.new");
    expect(calls.at(-1)?.action).toBe("tab.close");
    expect(calls.at(-1)?.params).toEqual({ targetId: 42 });
    // 滚动两次 + 提取一次
    const evaluates = calls.filter((call) => call.action === "page.evaluate");
    expect(evaluates.filter((call) => String(call.params.expression).includes("tweets:"))).toHaveLength(1);
    expect(evaluates.filter((call) => String(call.params.expression).includes("scrollBy"))).toHaveLength(2);
  });

  it("推文还没渲染出来时先等（X 首屏要几秒）", async () => {
    let polls = 0;
    const { bridge } = stubBridge((action, params) => {
      if (action === "tab.new") {
        return { tab: { id: 42 } };
      }
      if (action === "page.evaluate") {
        const expression = String(params.expression ?? "");
        if (expression.includes("tweets:")) {
          return { tweets: SAMPLE };
        }
        polls += 1;
        return polls < 3 ? 0 : 6;
      }
      return { ok: true };
    });

    await fetchTwitterTimeline({ bridge, scrolls: 0, minTweets: 2, waitMs: 5_000 });
    expect(polls).toBe(3);
  });

  it("抓到的条数不够时抛错（登录墙 / 没渲染出来）", async () => {
    const { bridge } = stubBridge((action, params) => {
      if (action === "tab.new") {
        return { tab: { id: 42 } };
      }
      const expression = String(params.expression ?? "");
      if (expression.includes("tweets:")) {
        return { tweets: [] };
      }
      return 0;
    });

    await expect(fetchTwitterTimeline({ bridge, minTweets: 5, waitMs: 200 })).rejects.toThrow(/只抓到 0 条/);
  });

  it("提取失败时也把标签页关掉", async () => {
    const { bridge, calls } = stubBridge((action, params) => {
      if (action === "tab.new") {
        return { tab: { id: 42 } };
      }
      const expression = String(params.expression ?? "");
      if (expression.includes("tweets:")) {
        throw new Error("boom");
      }
      return 6;
    });

    await expect(fetchTwitterTimeline({ bridge, waitMs: 500 })).rejects.toThrow("boom");
    expect(calls.at(-1)?.action).toBe("tab.close");
  });
});

describe("fetchTwitterRaw", () => {
  it("写 runs/<date>/twitter_raw.txt", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "daily-news-twitter-"));
    const { bridge } = stubBridge((action, params) => {
      if (action === "tab.new") {
        return { tab: { id: 42 } };
      }
      if (action === "page.evaluate") {
        const expression = String(params.expression ?? "");
        if (expression.includes("tweets:")) {
          return { tweets: SAMPLE };
        }
        return 6;
      }
      if (action === "tab.version") {
        return { extensionVersion: "0.15.57" };
      }
      return { ok: true };
    });

    const result = await fetchTwitterRaw({ dataDir, date: "2026-11-04", bridge, minTweets: 1 });
    expect(result.ok).toBe(true);
    expect(result.count).toBe(2);

    const written = await readFile(join(dataDir, "runs", "2026-11-04", "twitter_raw.txt"), "utf8");
    expect(written).toContain("**Ivan Fioravanti** @ivanfioravanti");
    expect(written).toContain("[2] https://x.com/ivanfioravanti/status/2117687000681607545");
  });

  it("抓取失败时不抛错，只回报错误（其它来源不受影响）", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "daily-news-twitter-"));
    const { bridge } = stubBridge((action) => {
      if (action === "tab.new") {
        throw new Error("Chrome 没有返回标签页 id");
      }
      return { ok: true };
    });

    const result = await fetchTwitterRaw({ dataDir, date: "2026-11-04", bridge });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Chrome 没有返回标签页 id");
  });
});
