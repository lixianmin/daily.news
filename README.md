# daily.news

每天自动抓取 **X/Twitter 時間線 · 知乎熱榜 · GitHub Trending · Hacker News**，用 LLM 分块总结成「英文在上、繁體中文在下」的对照摘要，结构化落盘，开网页随时翻阅。

## 怎么用

服务常驻在本机，固定网址打开就能看：

```
本机     http://127.0.0.1:8790
局域网   http://<你的局域网IP>:8790     （手机同一 WiFi 可看）
控制台   http://127.0.0.1:8790/console  （需密码，见 .env）
```

- 首页列出所有已生成的日期，点进去看某天详情；顶部搜索框可跨天全文搜索。
- 每天 07:00 前后自动生成当天内容；服务启动时若发现今天还没生成会立刻补跑。
- 首页「重新生成」按钮可手动跑一次（只允许本机点击）。

## 安装

```bash
cp .env.example .env      # 填 CONSOLE_USER / CONSOLE_PASSWORD / CONSOLE_SECRET
bun install
./scripts/install.sh      # 装 launchd 常驻服务
```

卸载：`./scripts/install.sh --remove`（数据保留）。重启：`--restart`。

## 数据在哪

```
~/Documents/daily-news/
├── days/2026-10-23.json      每日成品（结构化，含中英对照）
├── index.json                日期索引（派生数据，可重建）
├── runs/2026-10-23/          当日抓取原始数据（保留 7 天）
└── logs/                     info.log / warn.log / error.log（保留 30 天）
```

数据目录可用 `DAILY_NEWS_DATA_DIR` 覆盖。

## 模型通道

| 角色 | provider/model | 凭证来源 |
|---|---|---|
| 主通道 | `deepseek/deepseek-flash` | `~/.zshrc.sh` 的 `DEEPSEEK_API_KEY` |
| 兜底 | `zai-coding-cn/glm-5.3-flash` | `~/.pi/agent/auth.json` |

主通道每块重试 3 次（退避），仍失败切兜底重试 2 次。两条通道是不同服务商、不同 key，互不连累。

## 架构

```
fetch.sh（curl + dokobot）→ runs/<date>/*.md
   ↓ 按来源分块（twitter / zhihu×2 / gh / hn）
pi --no-tools（deepseek，失败切 zai-coding-cn）
   ↓ 模型输出 JSON（规范见 prompts/format.md）
parseSection（容错解析：剥围栏、括号配平、逐条校验）
   ↓ 合并 5 块 → sections[]
机翻 en → zh-TW（Google 失败降级 MyMemory，都失败保留英文）
   ↓
days/<date>.json + index.json → Hono 渲染
```

代码分布见 `docs/01.memory.md` 的文件索引区。

## 开发

```bash
bun test                  # 101 个测试
bunx tsc --noEmit         # 类型检查
bun run src/server.ts     # 前台起服务（改代码调试用）
```

验收命令即 `bun test && bunx tsc --noEmit`（`AGENTS.md` §13.3 的 `VERIFY`）。

## 已知限制

- Twitter 抓取依赖 dokobot + 已登录的 Chrome；Chrome 没开时该源标记失败，其余三个源不受影响。
- 机翻用免费的 Google 端点（非正式 API），限流时降级 MyMemory，两者都挂则保留纯英文。
- GitHub 趋势当天只有几条就写几条，不硬凑。
