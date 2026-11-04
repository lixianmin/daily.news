# Twitter 来源改用 pi-chrome 抓取

日期：2026-11-04
状态：待实现

## 意图与背景

Twitter 来源一直靠 `scripts/fetch.sh` 里的 `dokobot` 抓「已登录浏览器」的渲染文本。本机现在
**根本没有 dokobot**（`command -v dokobot` 无输出），所以这个来源从某天起就一直是死的：
`days/2026-11-04.json` 只有 github / hackernews / zhihu 三块，没有 Twitter。

用户要求改用 **pi-chrome**（`pi install npm:pi-chrome` 已装，Chrome 里的伴侣扩展
"Pi Chrome Connector" 已加载并在轮询）。

已完成的 spike（2026-11-04，真实 Chrome 上跑通）：

- 桥在 `127.0.0.1:17318`，`GET /status` → `connected: true`；
- `tab.new` 开 `https://x.com/home` → `page.evaluate` 在页面里提取 17 条推文；
- 产出 `twitter_raw.txt`（与原 dokobot 产物同构）→ `buildTwitterChunk` → deepseek 一次成功，
  输出合法 categories JSON。

## 目标

1. 每天 07:00 的定时生成、以及页面上手动触发的重新生成，都能拿到 Twitter 时间线。
2. **不依赖 pi session 在线**。pi 交互会话经常开着，但也经常不在；定时任务不能因为「当时没人开 pi」而失败。
3. **不破坏 pi session 里的 Chrome 工具**。用户在 pi 里用 `chrome_*` 工具必须照常工作。
4. 下游零改动：`buildTwitterChunk` / `extractTwitterLinks` / enrich / 渲染全部不动。

## 非目标

- 不改 Twitter 章节的模型提示词与 schema。
- 不做定时以外的 Twitter 抓取（不接 SSE 实时流）。
- 不动其它三个来源（gh / hn / zhihu 仍走 `fetch.sh`）。
- 不把 pi-chrome 整套搬进本仓库（不 vendor 它的 npm 包）。

## 背景：pi-chrome 的桥是什么

pi-chrome 的结构（见 `~/.pi/agent/npm/node_modules/pi-chrome/docs/ARCHITECTURE.md`）：

```
Chrome 伴侣扩展  --HTTP-->  127.0.0.1:17318 的「桥」  <--HTTP--  想驱动浏览器的人
   （真正干活的：DOM、CDP、截图）
```

桥只是一条**本地邮箱**，四个端点：

| 端点 | 谁调 | 作用 |
|---|---|---|
| `GET /status` | 任何人 | `{connected, lastSeenAt, clientName, mode, ...}` |
| `GET /next?name=` | 扩展（长轮询，最多 25s） | 取一条命令 `{id, action, params}` |
| `POST /result` | 扩展 | 交回命令结果 `{id, ok, result \| error}` |
| `POST /command` | 本地进程 | 下发命令 `{action, params, timeoutMs}`，同步等结果 |

动作语义（`page.evaluate` / `tab.new` / `tab.list` …）**全部实现在扩展里**，桥只负责转发。
所以「当 owner」这件事很轻：把命令排队给扩展、把扩展回的结果还回去。

**两个硬约束**（决定了方案形状）：

1. 扩展把桥地址写死成 `http://127.0.0.1:17318`（`service_worker.js` 第 1 行），换不了端口。
2. 一个端口同一时刻只能有一个「owner」。pi-chrome 自己的多会话模型就是：
   **先起的当 owner，后起的当 client**（`POST /command` 转发给 owner）；
   owner 进程没了，client 会「promote」自己接管端口。

## 决策

### 1. 服务做成和 pi session 同款的「两栖桥」：能当 owner，也能当 client

| 场景 | 谁占 17318 | 服务怎么做 |
|---|---|---|
| pi session 在跑 | pi session（先起的） | 服务当 client，`POST /command` 转发给 pi 的 owner |
| 只有服务在跑（07:00 常态） | 服务自己 | 服务当 owner，直接把命令排给扩展 |
| 都没有 | 空闲 | 抓取失败（Chrome 扩展也没人轮询） |

**为什么不让服务永远当 owner**：那 pi session 每次启动都会降级成 client，Chrome 工具的可用性
就绑在服务上——服务挂了 pi 的 Chrome 工具就全废，方向反了。

**为什么不让服务永远当 client**：07:00 时没人开 pi，端口空着，client 无处可投。

所以：**默认 client，端口空着时自己当 owner；owner 只在抓取期间持有，抓完就释放。**
这与 pi-chrome 的多会话模型完全一致，两边可以同时在跑、互不打架。

自己实现 owner 而不是复用 pi-chrome 的实现：pi-chrome 的桥写在它的 pi 扩展文件里
（`extensions/chrome-profile-bridge/index.ts`，同时 `import { Text } from "@earendil-works/pi-tui"`
和 `import { Type } from "typebox"`），要独立跑它得 stub 一整套 `ExtensionAPI` 并解决这两个
依赖的解析；协议本身只有四个端点，自己写 ~150 行更可控、也有测试可写。

协议漂移的风险用版本号兜底：扩展在 `/next` 响应里回 `expectedExtensionVersion`，
在响应头回 `x-pi-chrome-version`。抓到扩展后校验这个版本，major/minor 不一致就明确报错，
而不是静默行为异常。

### 2. 抓取放在服务进程内（TypeScript），`fetch.sh` 去掉 twitter 分支

`src/generator.ts` 的 `runFetch` 负责调 `fetch.sh`。改成：

- `sources` 含 twitter → 先跑 `src/chrome/twitter.ts` 的抓取，写 `runs/<date>/twitter_raw.txt`；
- `fetch.sh` 只跑 gh / hn / zhihu（脚本里的 `fetch_twitter` 与 dokobot 依赖一并删掉）。

理由：抓取要发 HTTP、解析 JSON、拼装文本，bash 做这些很别扭；而且桥的 owner 生命周期要跟
抓取窗口对齐，放在服务进程里最容易控制。

### 3. `twitter_raw.txt` 格式与原 dokobot 产物保持同构

下游有两处硬依赖（`src/generator.ts` 的 `buildTwitterChunk`、`src/meta.ts` 的
`extractTwitterLinks`），所以文本长这样：

```
**作者名** @handle [1]·2h [2]
推文正文（可多行）
---
31 Replies 30 reposts 379 Likes 12289 views
---
...（每条推文一块）
[1] https://x.com/handle
[2] https://x.com/handle/status/123456
```

- 正文块以 `**作者** @handle` 开头（`buildTwitterChunk` 靠它切块）；
- 互动数行以数字开头（`buildTwitterChunk` 靠它保留指标）；
- 脚注区 `[N] https://x.com/<handle>/status/<id>`（`extractTwitterLinks` 靠它把
  `x.com/<handle>` 换成推文直链）。

**推文正文里以 `**` 开头或恰好是 `---` 的行要加一个前导空格**，否则会被下游误判成
「下一条推文」或分隔线。

### 4. Chrome 没开时自动拉起 Chrome

扩展在 Chrome 里，Chrome 关了就没人轮询 `/next`。07:00 机器可能醒着但 Chrome 没开。

做法：抓取前先看 `/status` 的 `connected`；不是 connected 就 `open -a "Google Chrome"`，
最多等 30s 让扩展连上；仍然连不上 → **Twitter 这一来源失败，其它三个来源照常出稿**，
页面上该来源标 ⚠️（`mergeSourceStatus` 的既有语义）。

不做的：不改成「Chrome 常驻」（那是另一件事，涉及用户日常使用习惯）。

### 5. 授权：服务绕过 pi 层的 `/chrome authorize`

pi 的授权闸门在 **pi 扩展层**（`authorizedBridgeSend`），桥本身只校验「请求来自本地进程」。
服务直接 `POST /command`，等于**常驻服务可以驱动用户真实 Chrome profile 里的已登录会话**。

这是本方案里最需要知情的一点，明确写在这里。约束：

- 服务只使用只读动作：`tab.new`（开 x.com）、`page.evaluate`（读 DOM）、`tab.close`（收尾）。
- 不做点击、不做输入、不碰其它标签页。

## 行为变更

| 变更 | 影响 |
|---|---|
| `scripts/fetch.sh` 不再抓 twitter | `--sources twitter` 不再有效；服务内部走 `src/chrome/twitter.ts` |
| `dokobot` 依赖移除 | 本机没有 dokobot，本来就是死的 |
| 抓取需要 Chrome 在运行且已加载伴侣扩展 | 新前置条件（已在本机满足） |
| 抓取会在 Chrome 里开一个标签页（分组 `daily.news`） | 抓完关闭 |

## 数据流

```
generateDay(date, sources)
  ├─ sources 含 twitter → src/chrome/twitter.ts
  │    ├─ 桥：client? 用现有 owner : 自己起 owner（抓完释放）
  │    ├─ tab.new https://x.com/home（分组 daily.news，不抢焦点）
  │    ├─ page.evaluate × N（滚动加载，每次 < 5s，CDP 硬超时）
  │    ├─ page.evaluate（提取推文数组）
  │    └─ 写 runs/<date>/twitter_raw.txt
  └─ fetch.sh（gh / hn / zhihu）
```

## 失败模式与降级

| 失败 | 后果 |
|---|---|
| 端口被 pi session 占着 | 降级 client，正常工作 |
| Chrome 没开 | 自动拉起；30s 内没连上 → Twitter 来源失败，其它源正常 |
| 扩展没加载 / 版本对不上 | Twitter 来源失败，日志写明原因 |
| 页面没渲染出推文（0 条） | Twitter 来源失败（对齐原 `fetch.sh` 的真实性校验：至少 5 条） |
| 单条 evaluate 超时（CDP 5s 硬限） | 重试一次，仍失败则该来源失败 |

## 测试计划

- `test/chrome/bridge.test.ts`
  - owner 模式：假扩展（长轮询 `/next` + `POST /result`）→ 命令往返、超时、CORS 头、`/status` 字段。
  - client 模式：假 owner（`/command` 返回固定结果）→ 请求体格式、错误透传。
  - 端口被占 → 自动降级 client。
- `test/chrome/twitter.test.ts`
  - 推文数组 → `twitter_raw.txt` 文本格式（脚注编号、指标行、正文里的 `**`/`---` 转义）。
  - 抓取流程（假 bridge）→ 写文件。
- 回归：`bun test && bunx tsc --noEmit` 全绿。

## 风险

- **协议漂移**：pi-chrome 改了四个端点的形状 → 用 `expectedExtensionVersion` 兜底，major/minor
  不一致直接报错。
- **端口争用**：服务与 pi session 同时启动 → 谁先起谁当 owner，另一方当 client；两边都实现了。
- **动到用户的 Chrome**：抓取会开/关一个标签页（分组 `daily.news`），不抢焦点。
