import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXPAND_SHOW_MORE_EXPRESSION,
  fetchTwitterRaw,
  fetchTwitterTimeline,
  renderTwitterRaw,
  type Tweet,
} from "../../src/chrome/twitter.ts";
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
    links: null,
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
    links: null,
    url: "https://x.com/fankaishuoai/status/2117453587286839791",
    replies: 17,
    reposts: 6,
    likes: 58,
    views: 10260,
  },
];

const NOW = new Date("2026-11-04T03:00:00.000Z");

/** 按内容认出是哪条表达式：滚动 / 展开 / 提取 / 等渲染。 */
function expressionKind(expression: unknown): "scroll" | "expand" | "extract" | "count" {
  const text = String(expression ?? "");
  if (text === EXPAND_SHOW_MORE_EXPRESSION) {
    return "expand";
  }
  if (text.includes("tweets:")) {
    return "extract";
  }
  if (text.includes("scrollBy")) {
    return "scroll";
  }
  return "count";
}

/** 把 sleep 换成记录器：测试里不要真的等 1.5s。 */
function recordSleep(): { waits: number[]; sleep: (ms: number) => Promise<void> } {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number) => {
      waits.push(ms);
    },
  };
}

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
  it("开标签页 → 等推文渲染 → 滚动 → 展开 → 提取 → 关标签页", async () => {
    const order: string[] = [];
    const { bridge, calls } = stubBridge((action, params) => {
      if (action === "tab.new") {
        order.push("tab.new");
        return { tab: { id: 42 } };
      }
      if (action === "page.evaluate") {
        const kind = expressionKind(params.expression);
        order.push(kind);
        if (kind === "extract") {
          return { tweets: SAMPLE };
        }
        if (kind === "expand") {
          return 1;
        }
        return 6;
      }
      if (action === "tab.close") {
        order.push("tab.close");
      }
      return { ok: true };
    });

    const { waits, sleep } = recordSleep();
    const tweets = await fetchTwitterTimeline({ bridge, scrolls: 2, minTweets: 2, waitMs: 1_000, sleep });
    expect(tweets).toEqual(SAMPLE);
    expect(order).toEqual(["tab.new", "count", "scroll", "scroll", "expand", "extract", "tab.close"]);
    expect(calls[0]?.action).toBe("tab.new");
    expect(calls.at(-1)?.action).toBe("tab.close");
    expect(calls.at(-1)?.params).toEqual({ targetId: 42 });
    // 展开过才等：1500ms 留给 X 重渲染
    expect(waits).toEqual([1500]);
  });

  it("没有 Show more 时不等待，直接提取", async () => {
    const { bridge } = stubBridge((action, params) => {
      if (action === "tab.new") {
        return { tab: { id: 42 } };
      }
      if (action === "page.evaluate") {
        const kind = expressionKind(params.expression);
        if (kind === "extract") {
          return { tweets: SAMPLE };
        }
        if (kind === "expand") {
          return 0;
        }
        return 6;
      }
      return { ok: true };
    });

    const { waits, sleep } = recordSleep();
    const tweets = await fetchTwitterTimeline({ bridge, scrolls: 1, minTweets: 2, waitMs: 1_000, sleep });
    expect(tweets).toEqual(SAMPLE);
    expect(waits).toEqual([]);
  });

  it("展开抛错只记 warn，仍继续提取并返回推文", async () => {
    let extracts = 0;
    const { bridge, calls } = stubBridge((action, params) => {
      if (action === "tab.new") {
        return { tab: { id: 42 } };
      }
      if (action === "page.evaluate") {
        const kind = expressionKind(params.expression);
        if (kind === "expand") {
          throw new Error("expand boom");
        }
        if (kind === "extract") {
          extracts += 1;
          return { tweets: SAMPLE };
        }
        return 6;
      }
      return { ok: true };
    });

    const { waits, sleep } = recordSleep();
    const tweets = await fetchTwitterTimeline({ bridge, scrolls: 0, minTweets: 2, waitMs: 1_000, sleep });
    expect(tweets).toEqual(SAMPLE);
    expect(extracts).toBe(1);
    expect(waits).toEqual([]);
    expect(calls.at(-1)?.action).toBe("tab.close");
  });

  it("推文还没渲染出来时先等（X 首屏要几秒）", async () => {
    let polls = 0;
    const { bridge } = stubBridge((action, params) => {
      if (action === "tab.new") {
        return { tab: { id: 42 } };
      }
      if (action === "page.evaluate") {
        const kind = expressionKind(params.expression);
        if (kind === "extract") {
          return { tweets: SAMPLE };
        }
        if (kind === "expand") {
          return 0;
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
      const kind = expressionKind(params.expression);
      if (kind === "extract") {
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
      const kind = expressionKind(params.expression);
      if (kind === "extract") {
        throw new Error("boom");
      }
      if (kind === "expand") {
        return 0;
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
        const kind = expressionKind(params.expression);
        if (kind === "extract") {
          return { tweets: SAMPLE };
        }
        if (kind === "expand") {
          return 0;
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

/**
 * 还原 `String.raw` 里的 `\uXXXX`。
 *
 * bun 会把 raw 模板里的非 ASCII 字符写成 `\uXXXX`（浏览器侧仍然是同一个字符）；
 * 断言表达式里的中文文案前先还原，免得测试绑在 bun 的序列化细节上。
 */
function decodeUnicodeEscapes(text: string): string {
  return text.replace(/\\u([0-9A-Fa-f]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

describe("EXPAND_SHOW_MORE_EXPRESSION", () => {
  it("在 tweetText 的父节点里按文案找 button[role=button] 并点击", () => {
    const expression = decodeUnicodeEscapes(EXPAND_SHOW_MORE_EXPRESSION);
    expect(expression).toContain('div[data-testid="tweetText"]');
    expect(expression).toContain("parentElement");
    expect(expression).toContain('button[role="button"]');
    expect(expression).toContain("Show more");
    expect(expression).toContain("显示更多");
    expect(expression).toContain("顯示更多");
    expect(expression).toContain(".click()");
  });
});

describe("EXTRACT_TWEETS_EXPRESSION", () => {
  it("只取正文里的链接（tweetText 内的 a[href]），不取头像与互动按钮", async () => {
    const { EXTRACT_TWEETS_EXPRESSION } = await import("../../src/chrome/twitter.ts");
    expect(EXTRACT_TWEETS_EXPRESSION).toContain('div[data-testid="tweetText"] a[href]');
    expect(EXTRACT_TWEETS_EXPRESSION).toContain("links");
  });
});
