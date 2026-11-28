# 任务（11-28T10-01-twitter-show-more-full-text）

## 1 抓取层展开长推文

- 1.1 新增 `EXPAND_SHOW_MORE_EXPRESSION`：找 `tweetText` 父节点里文案为 `Show more`（含中文文案）的 `button[role="button"]` 并点击，返回点击个数
- 1.2 `fetchTwitterTimeline` 在提取前调用一次；返回 > 0 时 `sleep(1500)` 再提取；调用失败只 warn 不中断
- 1.3 测试：表达式选择器/文案断言；流程顺序（tab.new → 等渲染 → 滚动 → 展开 → 提取 → tab.close）；展开返回 0 不等待；展开抛错仍继续提取

## 交付前

- 2.1 `bun test` 全绿；`bunx tsc --noEmit` 干净
- 2.2 用真 Chrome 跑一次抓取（或对 `runs/2026-11-28/twitter_raw.txt` 里的截断条目复现：展开后该条正文显著变长），把实测字符数写进 worklog
