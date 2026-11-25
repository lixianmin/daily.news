<!-- change-id: 11-25T16-07-twitter-full-article created: 2026-11-25T16:07:00+08:00 -->

# 推特正文改成原文全文（去截断 + 抓外链文章）

日期：2026-11-25
台账：`t-vhf957sa`（工程 `p-8gb4g2d4`）
上一刀：`docs/superpowers/specs/2026-11-08-direct-translation.md`（正文改成原文直译）

## 问题

1. **正文被截断。** `src/twitter.ts` 的 `TWEET_TEXT_LIMIT = 600` 在 `translateTweets` 里也切一刀，
   于是页面上的正文最多 600 字。它的本意只是「别让分主题的模型吃太多」，却顺手截了成品。
2. **带链接的推文只有一个标题 + 一句评论。** 抓取只拿推文正文（几百字），链接指向的文章一个字都没有，
   读者得自己点出去——而这类推文的价值全在那篇文章里。

## 目标（可验证）

1. 推文正文**不再截断**：进翻译与进成品的都是全文。
2. 推文正文里带外链时，把链接文章的正文完整抓下来，与推文正文一起作为这条的正文；抓不到就退回推文原文。
3. 两份翻译照旧：原文非中文 → 英文列就是原文、只补繁中；原文含中文 → 两列都翻。
4. 不用模型总结顶替原文（`prompts/format.md` 的口径不变：正文由系统直译）。

## 设计

### 数据流

```
x.com 页面 ─提取─▶ Tweet{ text, url, links }
   │
renderTwitterRaw ─▶ twitter_raw.txt（正文块 + 脚注区；外链也进脚注）
   │
parseTwitterRaw ─▶ RawTweet{ text, url, articleUrls }
   │
   ├─ buildTwitterChunk（每条取前 600 字预览）──▶ 模型：只分主题
   │
   ├─ expandTweets（抓 articleUrls 的文章全文，拼在推文正文后面）
   │
   └─ toBilingual（全文）──▶ 英文 + 繁中两列
```

### 1. 抓取层：把外链带出来（`src/chrome/twitter.ts`）

- `Tweet` / `RawTweet` 增加外链字段：`links: string[] | null` / 解析后 `articleUrls?: string[]`。
- 页面内提取表达式多取一条：`div[data-testid="tweetText"] a[href]` 的 `href`（X 上就是 `https://t.co/…`）。
  只取正文里的链，不取头像、媒体、互动按钮这些 `<a>`。
- `renderTwitterRaw`：每条推文的外链写进**同一个脚注区**（沿用 `[N] url`），首行末尾追加引用组 `[3,4]`
  （**可选**，没有外链就不写）。`parseTwitterRaw` 解析这一组，`http(s)` 之外的丢掉；
  老文件（首行没有该组）照样解析，`articleUrls` 为空。

### 2. 正文抓取（新文件 `src/article.ts`）

```ts
export type ArticleOutcome =
  | { ok: true; url: string; text: string }
  | { ok: false; reason: string };
export function fetchArticleText(url: string, deps?: { fetch?: typeof fetch }): Promise<ArticleOutcome>;
```

- `fetch` 可注入（测试用），默认全局 `fetch`。桌面 Chrome 的 UA；30s 超时；跟随重定向（t.co 用它解开）。
- 失败（非 2xx、非 `text/html`、网络错、超时）都返回 `{ok:false}`，不抛。
- 响应体上限 5MB：超了判失败。**这不是内容截断**——抓不到就不假装抓到，正文退回推文原文。
- HTML → 文本：先整体剔掉 `script/style/noscript/svg/iframe/head/nav/footer/form`，再把块级标签换成换行，
  解常见实体，压缩连续空白与空行，`trim`。
- `MIN_ARTICLE_CHARS = 400`：抽出来的文本短于这个数判失败（多是登录墙、JS 壳、导航页）。
  新闻正文实测普遍千字以上，400 以下基本不是文章。

### 3. 章节构建（`src/twitter.ts`）

- 把 `TWEET_TEXT_LIMIT` 改名为 `CATEGORIZE_PREVIEW_CHARS = 600`，**只用于 `buildTwitterChunk`**（模型分主题看预览）。
  注释写清：这是给模型分主题的窗口，不是成品正文的长度。
- `translateTweets` 传全文，不再 `slice`。
- 新增 `expandTweets(tweets, deps)`：
  - 对每条有 `articleUrls` 的推文，**按顺序最多试 3 条**（一条推文挂一串链时不必全抓），取第一条抓成功的；
  - 成功：正文 = `推文正文 + "\n\n" + 文章全文`（推文自己的话也是原文，不丢；两段之间留一个空行）；
  - 全部失败或没有外链：保持推文正文；
  - 并发 3，任一链接失败不影响其它推文，整体不抛错；每条的结果打一条 info 日志（抓没抓到、字符数）。
- `buildTwitterSectionFromRuns` 的顺序变成：解析 → 写分块文件（推文原文，未展开）→ 模型分主题 →
  `expandTweets` → 逐条 `toBilingual` → 组装。

### 4. 翻译兜底按段（`src/translator.ts`）

正文变成全文后，单条可能上万字。免费端点本来就是按 450 字切段翻的；失败后交给模型兜底时，
现在的实现把**整条**丢给模型，超上下文就整条丢译文。改成：模型兜底也走 `splitForTranslation`，
逐段翻再拼（拼回去等于原文），与免费端点同一份切段规则。
`createTranslator` 加一个可注入的兜底实现（测试用），默认仍是 `translateWithModel`。

### 5. 版本号

`package.json` patch +1（0.1.18 → 0.1.19），随本单的提交落下（AGENTS §14）。

## 验收

- `bun test` 0 fail、`bunx tsc --noEmit` 干净（VERIFY）。
- 新增/扩展测试：
  - `chrome/twitter`：带外链的推文经 `renderTwitterRaw` → `parseTwitterRaw` 往返后 `articleUrls` 一致；
    没有外链时该字段为空；**老格式**（首行没有 `[3,4]` 组）照样解析。
  - `article.ts`：假 fetch 返回 HTML → 抽出正文；`text/plain`、非 2xx、网络错、正文太短（<400）→ 失败；
    超过 5MB → 失败。
  - `twitter.ts`：`buildTwitterChunk` 仍按 600 预览；正文 1000+ 字的推文进翻译器时**长度不变**
    （不截断的回归线）；`expandTweets` 拼出「推文 + 空行 + 文章」，抓不到时等于推文原文，
    只取第一条成功的链接。
  - 集成：`buildTwitterSection` 出成品时，英文列含文章全文、繁中列是它的译文（用假翻译器）。
  - `translator`：模型兜底收到的是 ≤450 字的段，拼回去与原文一致（用注入的兜底替身）。

## 不做

- 知乎摘要片段（1500 字上限）改全文、GitHub / Hacker News 的总结式正文——另开单。
- 折叠/展开的 UI 逻辑（长正文已能展开，不改）。
- 抓需要登录或付费墙的正文（抓不到就退回推文原文，不用模型编）。
- 把推文外链做成卡片上额外的「原文」入口（现有入口不变：行首 @handle 链到推文）。

## 风险

- 翻译量与请求数随正文长度上升，免费端点 429 的概率变高；已有三级降级兜底，异常会在日志里。
- 抓取依赖目标站点的 HTML 结构（通用清洗，不针对单一站点）；抓不到就退回，不影响出稿。
- 正文**不设长度上限**（用户要求不截短）；异常超长页面靠 5MB 响应上限与 400 字下限兜住两头。
