# 任务（11-25T16-07-twitter-full-article）

## 1 抓取层带出外链

- 1.1 `src/chrome/twitter.ts`：`Tweet.links` + 提取表达式取 `div[data-testid="tweetText"] a[href]`
- 1.2 `renderTwitterRaw` 写外链脚注 + 首行可选引用组 `[3,4]`；`parseTwitterRaw` 解析成 `RawTweet.articleUrls`（老格式兼容）
- 1.3 测试：往返、无外链、老格式兼容

## 2 正文抓取模块

- 2.1 新增 `src/article.ts`：`fetchArticleText`（可注入 fetch、30s 超时、5MB 上限、HTML→文本、`MIN_ARTICLE_CHARS=400`）
- 2.2 测试：成功、非 html、非 2xx、网络错、太短、超大

## 3 章节构建

- 3.1 `TWEET_TEXT_LIMIT` → `CATEGORIZE_PREVIEW_CHARS`，只给 `buildTwitterChunk` 用；`translateTweets` 用全文
- 3.2 新增 `expandTweets`（最多试 3 条链接、拼「推文 + 空行 + 文章」、并发 3、失败退回、info 日志）
- 3.3 `buildTwitterSectionFromRuns` 顺序：分块（原文）→ 分主题 → 展开 → 翻译 → 组装
- 3.4 测试：不截断回归、拼接、退回、只取首条可用、集成出成品

## 4 翻译兜底按段

- 4.1 `src/translator.ts`：模型兜底走 `splitForTranslation`，逐段翻再拼；`createTranslator` 可注入兜底
- 4.2 测试：兜底收到的段 ≤450 字，拼接结果等于原文

## 交付前

- 4.3 `package.json` patch +1（0.1.19）
- 4.4 `bun test` 与 `bunx tsc --noEmit` 全绿
