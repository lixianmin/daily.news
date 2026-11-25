# 任务（11-25T20-18-zhihu-full-article）

## 1 全文抓取模块

- 1.1 新增 `src/chrome/zhihu.ts`：`fetchZhihuAnswer`（`ChromeBridge.connect()` 可注入、`tab.new` → 等 `.RichText` → 一次 `page.evaluate` 取第一个答案 → `finally` 关标签页）
- 1.2 失败一律 `{ok:false, reason}` 不抛错：桥连不上 / 超时 / 表达式为空 / 短于 `MIN_ANSWER_CHARS(200)`；失败打 warn 日志
- 1.3 测试：成功取全文并关标签页、表达式为空、太短、桥抛错、关标签页失败不影响返回值

## 2 章节构建

- 2.1 `ZhihuItem.fullText?`；新增 `expandZhihu`（串行、采纳条件 = ≥200 字且比摘要长、失败保留摘要、每条 info 日志、整批不抛）
- 2.2 `sourceText` 优先用 `fullText`（`标题 + 空行 + 全文`）；`buildZhihuSection` 顺序 = expand → 翻译 → 组装；`buildZhihuSectionFromRuns` 透传 deps
- 2.3 测试：成功/失败/比摘要短/没有 url 不抓；集成出成品时英文列含全文

## 交付前

- 3.1 `package.json` patch +1（0.1.20）
- 3.2 `bun test` 全绿（门禁）；`bunx tsc --noEmit` 干净（自检）
