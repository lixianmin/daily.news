<!-- change-id: 11-28T10-01-twitter-show-more-full-text created: 2026-11-28T10:01:29.790+08:00 -->

# 推文正文被 X 自己的「Show more」截断（点击 More 只展开到截断处）

日期：2026-11-28
台账：`t-`（工程 `p-8gb4g2d4`）
上一刀：`docs/superpowers/specs/11-25T16-07-twitter-full-article/spec.md`（去掉我们自己的 600 字截断 + 抓外链文章）

## 问题

时间线上长推文只进到成品的**前 280 字左右**，后面被 X 的时间线截断，点卡片的「More」也只能展开到这截断处。

用户实测（2026-11-28）：
- `https://x.com/yuhasbeentaken/status/2126060640729006300` 原文 1168 字。
- 成品里只见 273 字，末尾停在 `…1. High handles multi-file work just fine.\n\nFollowing`——词被切断，不是句子。

## 已实测的事实（决定方案，不再是猜测）

- `runs/2026-11-28/twitter_raw.txt` 里这条推文正文就是 273 字：**截断发生在抓取层**，下游
  （`parseTwitterRaw` → `translateTweets` → 渲染）都忠实照搬了截断后的文本，不是我们自己的长度限制。
- X 时间线/个人页的长推文：`div[data-testid="tweetText"]` 里是截断文本，**它的发布按钮是 `tweetText`
  的兄弟节点**（`tweetText.parentElement` 里的 `<button role="button">Show more</button>`）。
- 点这个按钮后同一节点原地展开（实测 273 → 1168 字，与推文详情页一致）。
- 推文详情页（`/status/<id>`）本身是全文、没有 Show more；但每条都开一次详情页代价太大，不做。

## 目标（可验证）

1. 时间线抓取时长推文拿到**全文**：`twitter_raw.txt` 的正文块就是全文，不再停在 280 字。
2. 没被截断的推文行为不变（不点、不等待、字符数不变）。
3. 展开失败（按钮点不动 / 点完仍截断）不致命：仍按抓到的文本继续，日志留痕。
4. 抓取脚本形态不变：仍是 `fetchTwitterTimeline` → `twitter_raw.txt`，不新增外部依赖。

## 设计

### 抓取层（`src/chrome/twitter.ts`）

在「等推文渲染 → 滚动」之后、「提取」之前加一步**展开长推文**：

- 新导出常量 `EXPAND_SHOW_MORE_EXPRESSION`：同步表达式，找出所有 `div[data-testid="tweetText"]`
  的父节点里文本为 `Show more`（含 `显示更多` / `顯示更多`）的 `button[role="button"]`，逐个 `click()`，
  返回点击个数。**不等待**——CDP `Runtime.evaluate` 有 5 秒硬超时，等待放在 Node 侧。
- `fetchTwitterTimeline` 里：调用一次该表达式 → 有展开过（返回值 > 0）就 `sleep(1500)` 让 X 重渲染 →
  再走现有的提取。展开调用失败只记 warn，不中断抓取。
- 常量与阈值都写明理由：1.5s 取自实测（点击后 `textContent` 在同一 tick 之后的重渲染里就变长，
  1.2s 足够；留 1.5s 余量）。

### 测试（`test/chrome/twitter.test.ts`）

按现有「假 bridge 记录调用序列」的写法补：

1. 表达式层：断言 `EXPAND_SHOW_MORE_EXPRESSION` 按 `tweetText` 父节点找 `button[role="button"]`、
   匹配 `Show more` 文案（与现有 `EXTRACT_TWEETS_EXPRESSION` 的断言方式一致）。
2. 流程层：假 bridge 记录调用顺序，断言 `fetchTwitterTimeline` 的序列是
   `tab.new → 等渲染 → 滚动 → 展开 → 提取 → tab.close`，且展开返回 0 时不 sleep（用注入的 sleep 或计时断言，
   避免测试真的等 1.5s）。
3. 失败用例：展开表达式抛错时仍继续提取、仍返回推文。

## 不做

- 逐条打开推文详情页抓全文（代价与限流都不值）。
- 改 `twitter_raw.txt` 格式、改下游解析/翻译/渲染。
- 处理 X 的「Show replies」、投票、长文（Article）形态。

## 风险

- X 改文案或 DOM：表达式返回 0，行为退回现在的截断（不会更差），日志可查。
- 展开后时间线高度变化：滚动已在展开之前完成，展开只影响已加载的推文，不触发额外加载（不需要再滚）。
