# worklog · 11-28T10-01-twitter-show-more-full-text · task 1

## 2026-11-28 第 1 轮

### 本轮做了什么

`src/chrome/twitter.ts` 新增 `EXPAND_SHOW_MORE_EXPRESSION`（+ `SHOW_MORE_WAIT_MS` 常量），
`fetchTwitterTimeline` 在滚动之后、提取之前调用一次，返回 > 0 时在 Node 侧 `sleep(1500)`，
调用抛错只 `logger.warn` 不中断；`TwitterFetchOptions` 增加可注入的 `sleep` 供测试跳过真实等待。

### 关键判断与理由

- **表达式保持同步**：点击后不等待，等待放 Node 侧。CDP `Runtime.evaluate` 有 5 秒硬超时，
  在页面里 `await` 重渲染会把整条命令拖进超时。
- **文案匹配用 `['Show more', '显示更多', '顯示更多'].map(toLowerCase)` 后比对**：X 在英文/简中/繁中
  界面给的是三套文案，大小写不敏感比对不依赖界面语言。
- **`sleep` 做成可选注入项**：测试要断言「展开返回 0 不等待」，真的等 1.5s 会让测试变慢；
  注入一个记录器既能断言等待毫秒数，也不引入假时钟库（项目没有）。
- **warn 用仓库统一 logger**（`src/logo.ts`），不新起 `console.warn`：模块顶层只摘掉 stdout sink，
  不初始化文件 sink，测试里调用是空操作。
- **测试里加了 `decodeUnicodeEscapes` 辅助**：bun 会把 `String.raw` 模板里的非 ASCII 字符序列化成
  `\uXXXX`（浏览器侧求值仍是同一个字符，功能不受影响），直接断言中文字面量会失败。
  还原后再断言，避免测试绑死 bun 的序列化细节。

### 没做成的事与原因

- 没能复现 spec 里那条 @yuhasbeentaken 的推文（2026-11-28 的条目早已滑出首页时间线），
  改用真 Chrome 首页时间线里的实际截断推文验证，见下。行为等价：走的是同一个表达式与同一段流程。

### 门禁与测试结果

- `bun run test test/chrome/twitter.test.ts` → 14 pass / 0 fail（含新增 4 条：表达式断言、
  调用顺序 + 等待断言、返回 0 不等待、展开抛错仍继续提取）
- `bunx tsc --noEmit` → exit 0
- `bun test`（本仓 gates）→ 见下方追加
- 真机验证（client 模式桥，`https://x.com/home`，滚动 3 次后）：
  - `EXPAND_SHOW_MORE_EXPRESSION` 返回 **2**（点到 2 个 Show more）
  - 展开前后逐条正文长度：`@bojie_li` **166 → 222** 字；`@AYi_AInotes` **95 → 2767** 字
  - 时间线总条数 8 → 8（展开不触发额外加载，与 spec 的风险判断一致）
  - 结论：展开确实让 `tweetText.textContent` 原地变长，抓取层能拿到全文

### 交付 HEAD 短 sha

本条提交自身；短 sha 与 `.delivered` 内容一致（`git rev-parse --short HEAD`）。
