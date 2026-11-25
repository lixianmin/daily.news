<!-- change-id: 11-25T20-18-zhihu-full-article created: 2026-11-25T20:18:48.067+08:00 -->

# 知乎正文取原文全文，抓不到退回摘要片段

日期：2026-11-25
台账：`t-hyk5ccnm`（工程 `p-8gb4g2d4`）
上一刀：`docs/superpowers/specs/11-25T16-07-twitter-full-article/spec.md`（推特正文改成原文全文）

## 问题

知乎章节的正文只有**答案摘要片段**：`scripts/fetch.sh` 从 newsnow 聚合接口取 `extra.hover`，
最多 1500 字（`EXCERPT_LIMIT`），进成品的也只有这一段。推特那边已经改成「正文 = 原文全文」，
知乎口径不一致：读者在这种条目里看到的是一句导语，而不是答案本身。

## 已实测的事实（决定方案，不再是猜测）

- `https://www.zhihu.com/question/<id>` 直接 curl（桌面 Chrome UA）：**403**，页面是「安全验证」。
- `https://www.zhihu.com/api/v4/questions/<id>/answers?include=content`：桌面与移动 UA 都是
  **403**（`code 40362`，提示登录/异常请求）。
- `https://r.jina.ai/<知乎 question 页>`：200 但被导到 `/account/unhuman?need_login=true`，仍是安全验证。

结论：**纯 HTTP 拿不到知乎全文**。唯一可行路径是复用仓库已有的 pi-chrome 桥
（用户真实已登录的 Chrome，`src/chrome/bridge.ts`，推特抓取已经用它）。所以本单的
「抓不到」是常态路径之一，必须做成能退回、不报错。

## 目标（可验证）

1. 知乎条目的正文取**答案全文**（页面第一个答案），与推特同一套口径：原文 + 英文 + 繁体中文。
2. 抓不到（桥不在、未登录、安全验证、抽出太短、不比摘要长）→ 退回摘要片段继续出稿，**不抛错**。
3. 不用模型总结顶替（`prompts/format.md` 的口径不变，知乎不走模型总结）。
4. 只在有全文时替换正文；`zhihu.md` 的格式与抓取脚本形态不变。

## 设计

### 1. 全文抓取（新文件 `src/chrome/zhihu.ts`）

```ts
export type ZhihuAnswerOutcome =
  | { ok: true; url: string; text: string }
  | { ok: false; reason: string };

export function fetchZhihuAnswer(
  url: string,
  options?: { bridge?: ChromeBridge; minChars?: number; waitMs?: number },
): Promise<ZhihuAnswerOutcome>;
```

- 与 `fetchTwitterTimeline` 同一套桥用法：`ChromeBridge.connect()`（可注入）→ `tab.new`
  （后台标签页，`groupTitle: "daily.news"`）→ 等答案渲染 → 一次 `page.evaluate` 取值 →
  `finally` 里 `tab.close`（关不掉只记日志）。
- 提取表达式要短（CDP `Runtime.evaluate` 有 5 秒硬超时）：
  `document.querySelector('.List-item .RichText') ?? document.querySelector('.RichText')`，
  取 `innerText.trim()`；**只取第一个答案**，不把所有答案拼起来（热榜条目只需要一个答案的正文，
  全部答案会到几万字，翻译成本与噪声都不值）。
- 等渲染：每 1s 探一次表达式返回是否非空，上限 `waitMs`（默认 15s；登录墙不会自愈，等久了无意义）。
- 不抛错：桥连不上 / 超时 / 页面没内容 / 文本短于 `minChars`（默认 200）都返回 `{ok:false, reason}`。
  失败要记 warn 日志（带 url 与 reason），因为它同时是「这台机器没开 Chrome」的唯一可见线索。

### 2. 章节构建（`src/zhihu.ts`）

- `ZhihuItem` 增加 `fullText?: string`。
- 新增 `expandZhihu(items, deps)`：

```ts
export interface ExpandZhihuDeps {
  fetchAnswer?: (url: string) => Promise<ZhihuAnswerOutcome>;
}
```

  - 逐条**串行**抓（Chrome 里并发开多个标签页会互相抢焦点/抢渲染，收益是负的）；
  - 采纳条件：`text.length >= MIN_ANSWER_CHARS(200)` **且** `text.length > excerpt.length`。
    第二个条件防的是抓到的「登录提示 / 折叠占位 / 只有标题的壳」——它可能比 200 字长，但比摘要还短；
  - 成功：`{ ...item, fullText: text }`，正文用它；失败或没有 `url`：原样返回，正文仍是摘要片段；
  - 每条一条 info 日志（抓没抓到、字符数、失败原因），整批不抛错。
- `sourceText(item)`：有 `fullText` 就是 `标题 + 空行 + 全文`（不再拼摘要片段），否则维持现状
  `标题 + 空行 + 摘要片段`。
- `buildZhihuSection` 顺序变成：`expandZhihu` → `toBilingual` → 组装；`buildZhihuSectionFromRuns`
  把 `deps` 透传下去（默认用真实实现）。

### 3. 版本号

`package.json` patch +1（0.1.19 → 0.1.20），随本单最后一次提交落下（AGENTS §14）。

## 验收

- 门禁 `bun test` 0 fail；`bunx tsc --noEmit` 干净。
- 新增/扩展测试：
  - `chrome/zhihu`：假 bridge（记录 `tab.new` / `page.evaluate` / `tab.close`）→ 取到全文并关掉标签页；
    表达式返回空 → `{ok:false}`；`minChars` 以下 → `{ok:false}`；bridge 抛错 → `{ok:false}` 且不抛；
    关标签页失败不影响返回值。
  - `zhihu.ts`：`expandZhihu` 成功时 `fullText` 落上、正文用全文；抓取失败保留摘要片段；
    抓到的比摘要短 → 保留摘要片段；没有 `url` 的条目不调用抓取；
    `buildZhihuSection`（假翻译器 + 假抓取）出成品时英文列含全文、繁中列是它的译文。

## 不做

- 多个答案拼接、答案排序切换、评论区。
- 绕过知乎登录墙 / 安全验证（抓不到就退回摘要片段）。
- 展示层改动（折叠/展开、卡片样式）。
- 把全文抓取搬进 `scripts/fetch.sh`（抓取脚本保持纯 curl，桥只在出稿阶段用）。
- GitHub / Hacker News 的总结式正文——另开单。

## 风险

- 依赖本机 Chrome 与 pi-chrome 扩展在跑：不在就没有全文，退回摘要片段（已有日志可查）。
- 知乎页面结构变化会让提取表达式失效：表达式只认 `.RichText`，失效时返回空 → 退回，不会崩。
- 全文进入翻译链后单条可能上万字：翻译侧已有按 450 字切段 + 模型兜底（上一刀的产出），无需再改。
