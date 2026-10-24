# daily.news 设计稿

日期：2026-10-23
状态：待批准

## 1. 意图

把现有的 `~/bin/osx/news` 每日摘要流水线，改造成一个**本机常驻的 Hono 服务**：固定网址打开就能看每天的热点摘要，历史可翻、可搜索，手机在同一个 WiFi 下也能访问。

## 2. 现状（已核实）

### 2.1 流水线从未成功跑通过一次

```
~/bin/osx/news/runs/   → 不存在
~/bin/osx/news/log/    → 空
~/Downloads/news-*.md  → 无
```

脚本齐备但从未完整执行过。已实测通过的只有单块生成环节：deepseek 主通道与 zai-coding-cn 兜底都能产出合规 Markdown；dokobot 抓 x.com/home 正常（453 行 / 56 个 @handle）。

### 2.2 现有结构

| 文件 | 作用 | 状态 |
|---|---|---|
| `fetch.sh` | 抓四源（GH/HN/知乎 curl，X 用 dokobot）→ `runs/<date>/` | 可用，未跑过 |
| `run.sh` | 分块 → 调 pi → 组装 → 机翻 → 输出 MD 到 `~/Downloads` | 可用，未跑过 |
| `format.md` | 分块生成的格式规范（英文写作，繁中由机翻生成） | 可用 |
| `skill.md` | Pi skill：交互会话用的文章格式规范 | 可用 |
| `install-launchd.sh` + plist | 07:00 定时 | 本次刚恢复 |
| `.pi-config/` | 隔离 pi 配置（`models.json` providers 为空，key 靠环境变量注入） | 空壳但仍有用 |

### 2.3 环境事实

- Bun 1.4.2、Node v26.8.2、Hono 4.13.13
- `~/Documents` 是纯本地目录（无 iCloud 同步），现有 `deepseek-harness`、`keysilk.ckf`
- `~/me/code/daily.news` 已存在（空目录）
- 空闲端口：8790 / 8791 / 8792；局域网 IP `192.168.31.182`
- 可抄的先例：`~/me/code/video.downloader`（Hono + Bun.serve + launchd 托管 + `svc` 管理 + `isAllowedOrigin()` 白名单）
- `~/bin/osx/news` 在 `~/bin` git 仓库中只有 1 个提交（`21c1f05 docs`）

## 3. 目标 / 非目标

### 目标

1. 固定网址 `http://127.0.0.1:8790/` 打开即用：首页列历史日期，点进某天看详情
2. 跨天全文搜索、按来源筛选
3. 局域网手机可访问（同 WiFi）
4. 服务自管调度：启动时检查今日是否已生成，每小时复查，页面可手动触发重生成
5. 生成进度在页面上实时可见
6. 数据不再落 `~/Downloads`，全部收进项目自己的数据目录

### 非目标

- **不做 Chrome 扩展**（已决定）
- 不做多用户 / 账号体系
- 不做云端部署、不上公网
- 不改 `~/bin` 仓库里其它项目的任何东西

### 反目标（做成即算失败）

- 生成质量比现在差（当前 `format.md` 的输出规范是调好的，JSON 化不能牺牲内容质量）
- 抓取可靠性下降（dokobot 依赖已登录 Chrome 的路径不能被破坏）
- 服务常驻后仍在写 `~/Downloads`

## 4. 关键决策

| 决策 | 选择 | 理由 |
|---|---|---|
| 呈现层 | Hono 本地服务（固定网址） | 固定入口 + 历史索引 + 搜索 + 实时进度，静态 HTML 做不到后三者 |
| 访问范围 | `0.0.0.0` 绑定，局域网手机可达 | 用户明确要手机能看；内容是公开新闻，无敏感数据 |
| 底层数据 | 结构化 JSON | 要跨天搜索/筛选/统计，Markdown 得回解析 |
| 调度归属 | 服务自管（启动检查 + 每小时复查 + 手动触发） | 只有一个 launchd 服务要管；漏生成自动补 |
| 运行时 | Bun + Hono + TypeScript | 与 `video.downloader` 同构，本机已有 Bun 服务运维经验 |
| 代码位置 | `~/me/code/daily.news/`（新独立仓库） | `~/me/code` 放真项目，`~/bin` 放 shell/配置 |
| 数据位置 | `~/Documents/daily-news/` | 用户指定；纯本地目录，适合存文档类产物 |
| Chrome 扩展 | 不做 | MV3 SW 不常驻；dokobot 本身已是扩展实现，插件抓 X 无本质增益 |

### 我的判断（不是用户拍板的）

- **端口 8790**：空闲，且与 `screenhub` 的 8787 不冲突
- **服务 label**：`com.xmli.daily-news`
- **前端**：原生 HTML + 一个 JS 文件，无构建步骤。理由：页面是"列表 + 详情 + 搜索"三块，不值得引入 Vite/React 构建链；也避免服务启动前需要先 build
- **渲染**：服务端把 JSON 渲染成 HTML（SSR），单页无框架。搜索走服务端 API
- **写操作安全**：`/api/regenerate` 会消耗 LLM 额度，只允许来自本机的请求触发（局域网手机只读）

## 5. 架构

```
┌─ 浏览器（Mac / 手机，同一 WiFi） ──────────────────────┐
│  http://192.168.31.182:8790/   首页：日期列表 + 搜索    │
│  http://192.168.31.182:8790/d/2026-10-23   某天详情    │
└───────────────────────┬───────────────────────────────┘
                        │ HTTP
┌───────────────────────▼───────────────────────────────┐
│ daily.news 服务 (Bun + Hono, launchd 托管, :8790)      │
│                                                      │
│  GET  /                 → 首页（SSR + 客户端搜索框）  │
│  GET  /d/:date          → 某天详情（SSR）             │
│  GET  /api/days         → 日期索引 JSON               │
│  GET  /api/day/:date    → 某天原始 JSON               │
│  GET  /api/search?q=    → 跨天全文搜索                │
│  POST /api/regenerate   → 触发生成（仅本机）          │
│  GET  /api/stream       → SSE 实时进度               │
│  GET  /health           → 健康检查                    │
│                                                      │
│  调度器：启动检查今日 → 每小时复查 → 手动触发          │
│  生成器：fetch → 分块 → LLM → JSON → 机翻 → 落盘      │
└───────────────────────┬───────────────────────────────┘
                        │ 读写
┌───────────────────────▼───────────────────────────────┐
│ 数据目录 ~/Documents/daily-news/                      │
│   days/2026-10-23.json     每日成品（含繁中）          │
│   index.json               日期索引（服务端维护）      │
│   runs/2026-10-23/*.md     当日抓取原始数据（保留7天） │
│   logs/run.log             生成日志                   │
└───────────────────────────────────────────────────────┘
```

### 目录布局

**代码** `~/me/code/daily.news/`
```
src/
  server.ts      Hono 应用 + 路由
  scheduler.ts   启动检查 / 每小时复查 / 手动触发
  generator.ts   编排：抓取 → 分块 → LLM → 机翻 → 落盘
  llm.ts         调 pi，解析 JSON，重试与兜底
  translate.ts   机翻（Google → MyMemory 降级）
  store.ts       读写 days/ 与 index.json
  render.ts      JSON → HTML
  types.ts       数据类型
prompts/
  format.md      新的 JSON 输出规范（替代旧 format.md）
scripts/
  fetch.sh       抓取脚本（从 ~/bin/osx/news 迁移，逻辑不变）
  install.sh     安装 launchd 服务
public/
  app.js         搜索 / 实时进度
  style.css
docs/
  superpowers/specs/2026-10-23-daily-news-design.md
```

**数据** `~/Documents/daily-news/`
```
days/2026-10-23.json
index.json
runs/2026-10-23/{gh.md,hn.md,zhihu.md,twitter_raw.txt}
logs/run.log
```

### 数据结构

`days/<date>.json`
```json
{
  "date": "2026-10-23",
  "weekday": "星期五",
  "generatedAt": "2026-10-23T07:12:33+08:00",
  "model": "deepseek/deepseek-flash",
  "sources": {
    "github":     { "ok": true,  "count": 20 },
    "hackernews":{ "ok": true,  "count": 20 },
    "zhihu":     { "ok": true,  "count": 20 },
    "twitter":   { "ok": true,  "count": 12 }
  },
  "sections": [
    {
      "key": "twitter",
      "title": "Twitter 時間線（近48小時 · 分門別類總結）",
      "kind": "categories",
      "categories": [
        {
          "title": "AI Models & Benchmarks",
          "items": [
            { "en": "…", "zh": "…", "handles": ["@simonw"], "links": ["https://x.com/simonw/status/123"] }
          ]
        }
      ]
    },
    {
      "key": "github",
      "title": "GitHub Trending（今日趨勢）",
      "kind": "items",
      "items": [
        { "title": "owner/repo", "url": "https://github.com/owner/repo",
          "en": "A fast CLI tool for X.", "zh": "一個用來執行 X 的工具。" }
      ]
    }
  ]
}
```

`index.json`
```json
{
  "updatedAt": "2026-10-23T07:12:40+08:00",
  "days": [
    { "date": "2026-10-23", "weekday": "星期五", "total": 72,
      "counts": { "twitter": 12, "github": 20, "hackernews": 20, "zhihu": 20 },
      "headlines": ["owner/repo", "other/lib"] }
  ]
}
```

### 生成流程（沿用现有已验证的分块策略）

```
fetch.sh                              → runs/<date>/*.md
  ↓ 按来源分块（twitter/zhihu×2/gh/hn）
每块调 pi（--no-tools --no-session）
  ↓ LLM 输出 JSON（新的 prompts/format.md 规范）
解析 + 校验（缺字段补默认、非法条目丢弃）
  ↓ 5 块合并成 sections[]
机翻 en → 繁中（Google 失败降级 MyMemory，都失败保留英文）
  ↓
写 days/<date>.json + 更新 index.json
```

分块策略、模型通道（deepseek 主 / zai-coding-cn 兜底）、重试退避、机翻降级，全部沿用当前已实测通过的实现，只把"Markdown 拼接"换成"JSON 合并"。

## 6. 约束

1. **LLM 必须吐合法 JSON**：新 `prompts/format.md` 规定严格 schema；解析层做容错（剥离 markdown 围栏、容错括号、字段缺失补默认、丢弃非法条目而非整块失败）
2. **不牺牲内容质量**：JSON 字段必须能承载现在 Markdown 里的全部信息（标题/链接/英文/繁中/@handle/分类）
3. **dokobot 依赖已登录 Chrome**：抓 X 的路径不变
4. **launchd 环境无 shell rc**：LLM key 从 `~/.zshrc.sh` 精确抽取（已实测该抽取逻辑在 `env -i` 干净环境下有效）
5. **局域网暴露**：`/api/regenerate` 限本机；只读接口不设防
6. **端口**：8790
7. **错误响应形状固定**：接口失败一律非 2xx + `{ "code": ..., "message": ... }`，由 `@needle/shell` 的 `ResponseX` 出口（具名方法锁死状态码与 `code`），不自己拼 `{error}` 那种壳。客户端只需一条规则：`if (!res.ok) { const { code, message } = await res.json(); }`。`/health` 是探活载荷，不走这个信封

## 7. 已定与待定

### 已定（用户拍板）
- 固定网址 / 本地 Bun 服务 / Hono
- 结构化 JSON 底层数据
- 服务自管调度
- 代码在 `~/me/code/daily.news`，删掉 `~/bin/osx/news`
- 数据在 `~/Documents/daily.news`，不落 Downloads
- 局域网手机可访问
- 不做 Chrome 扩展

### 待定（实现时按需决定，不阻塞开工）
- 页面视觉细节（暗色模式、卡片样式）
- 搜索交互（回车搜 / 输入即搜）
- 是否保留 `skill.md` 及其内容形态

## 8. 待办与风险

### 迁移动作
1. 新建 `~/me/code/daily.news` 仓库（git init，参照 `video.downloader` 的 remote 命名 `lixianmin/daily.news`）
2. 从 `~/bin/osx/news` 迁移 `fetch.sh`、`format.md`、`skill.md` 到新项目
3. 在 `~/bin` 仓库里 `git rm -r osx/news`，删掉 `~/bin/osx/news` 目录
4. 卸载旧的 `com.xmli.daily-digest` launchd 任务（调度职责移交新服务）
5. 删除 `~/Documents/news-*.md`（若存在）

### 风险

| 风险 | 缓解 |
|---|---|
| LLM 不稳定输出合法 JSON | 解析层多重容错 + 单块失败不拖垮整篇（该章节标 ⚠️）+ 可重试 |
| JSON 化导致内容质量下降 | 保留现有分块粒度与英文写作策略；先跑一次真实生成对比旧 Markdown 产出 |
| 服务进程里跑长任务被重启打断 | launchd `KeepAlive` 会重启；生成过程幂等（写临时文件再 rename），中断不产生半截 JSON |
| 局域网暴露写接口 | `/api/regenerate` 校验来源为本机 |
| `~/Documents` 被清理工具误删 | 数据目录独立命名 + README 说明 |
