import { describe, expect, it } from "bun:test";
import { renderDayPage } from "../src/render.ts";
import type { DigestDay } from "../src/types.ts";

/**
 * 左右两列各一个展开按钮。
 *
 * 用户反馈：电脑上是左右分屏，原来那个按钮在右下角，看着像只属于繁中那列。
 * 现在英文列下面也有一个，点任意一个都是同一个动作——两列一起展开/收起。
 */

const LONG = "A very long summary. ".repeat(20);

const day: DigestDay = {
  date: "2026-11-08",
  weekday: "星期日",
  generatedAt: "2026-11-08T07:00:00+08:00",
  model: "test",
  sources: { zhihu: { ok: true, count: 1 } },
  sections: [
    {
      key: "zhihu",
      title: "知乎熱榜（24小時）",
      kind: "items",
      items: [{ title: "问题？", en: LONG, zh: LONG, url: "https://www.zhihu.com/question/1" }],
    },
  ],
};

const twitterDay: DigestDay = {
  ...day,
  sections: [
    {
      key: "twitter",
      title: "Twitter 時間線（近48小時 · 分門別類總結）",
      kind: "categories",
      categories: [
        {
          title: "AI Models",
          titleZh: "AI 模型",
          items: [
            {
              en: LONG,
              zh: LONG,
              url: "https://x.com/foo/status/1",
              handle: "@foo",
              time: "2h",
            },
          ],
        },
      ],
    },
  ],
};

describe("展开按钮：左右两列各一个", () => {
  it("卡片里有两个展开按钮（英文列一个、繁中列一个）", () => {
    const html = renderDayPage(day);
    const buttons = html.match(/class="expand-btn"/g) ?? [];
    expect(buttons).toHaveLength(2);
  });

  it("Twitter 推文行里也有两个", () => {
    const html = renderDayPage(twitterDay);
    const buttons = html.match(/class="expand-btn"/g) ?? [];
    expect(buttons).toHaveLength(2);
  });

  it("按钮在各自列的文本下面（英文列的按钮在英文文本之后）", () => {
    const html = renderDayPage(day);
    const en = html.slice(html.indexOf('class="sum en"'), html.indexOf('class="sum zh"'));
    const zh = html.slice(html.indexOf('class="sum zh"'));
    expect(en).toContain("expand-btn");
    expect(zh).toContain("expand-btn");
  });

  it("文本单独包一层（夹行只夹文本，不会把按钮夹掉）", () => {
    const html = renderDayPage(day);
    expect(html).toContain('class="tx"');
  });

  it("短文本不给按钮", () => {
    const short: DigestDay = {
      ...day,
      sections: [
        {
          key: "zhihu",
          title: "知乎熱榜（24小時）",
          kind: "items",
          items: [{ title: "问题？", en: "短。", zh: "短。", url: "https://www.zhihu.com/question/1" }],
        },
      ],
    };
    const html = renderDayPage(short);
    // 注意要匹配 class 而不是裸字符串——页面内联的 CSS 里也有 expand-btn
    expect(html).not.toContain('class="expand-btn"');
  });

  it("译文为空时右列不渲染（连它的按钮一起），只剩左边一个按钮", () => {
    const noZh: DigestDay = {
      ...day,
      sections: [
        {
          key: "zhihu",
          title: "知乎熱榜（24小時）",
          kind: "items",
          items: [{ title: "问题？", en: LONG, zh: "", url: "https://www.zhihu.com/question/1" }],
        },
      ],
    };
    const html = renderDayPage(noZh);
    const buttons = html.match(/class="expand-btn"/g) ?? [];
    expect(buttons).toHaveLength(1);
  });
});

describe("展开按钮：点哪个都同步", () => {
  it("app.js 点一个按钮时把容器内所有按钮的文案一起改", async () => {
    const source = await Bun.file(new URL("../public/app.js", import.meta.url)).text();
    // 两个按钮的文案必须同步：不然一个写着 More 一个写着 Less
    expect(source).toContain('container.querySelectorAll(".expand-btn")');
    expect(source).toContain('other.textContent = label');
  });

  it("app.js 语法正确（纯 JS，tsc 抓不到语法错）", async () => {
    const source = await Bun.file(new URL("../public/app.js", import.meta.url)).text();
    expect(() => new Function(source)).not.toThrow();
  });
});
