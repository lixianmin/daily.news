# 用 @needle/honox 重做服务层

日期：2026-10-25
状态：待实现

## 意图与背景

`src/core/` 是 2026-10-24 手写的通用 Hono 骨架（`createHono` + 请求日志中间件 + JWT 中间件 + ULID），
当时的理由是「项目内只有一个消费者，不值得开包」。现在这个理由不成立了：needle 仓库已经把它做成了
`@needle/honox`（配置 / rid / 兜底日志 / JWT 门禁 / `createApi` 参数校验 / `traceOf` / Shell 面板），
并且有可对照的完整示例 `examples/honox-app`。手写的那套是它的子集，还多了两处维护成本：

- `src/server.ts` 453 行，页面 / API / SSE / 控制台 / 启动装配全挤在一个文件里；
- 配置散在 `process.env`（`DAILY_NEWS_*` / `CONSOLE_*` / `PRIMARY_*`），没有环境分层，
  也没有一处能回答「这个服务到底有哪些配置项」。

本次把服务层换成框架的，业务逻辑（抓取、生成、机翻、落盘、渲染）一行不改。

## 目标

1. 用 `createHonox()` 取代 `src/core/`：rid、兜底日志、JWT 解析、404/500 信封、Shell 面板全由库提供。
2. HTTP 接口按领域拆到 `src/api/`，一个领域一个文件，`src/api/index.ts` 只做挂载。
3. 配置改成 `res/config/*.yml` + `APP_*` 环境变量覆盖 + `viper` 取值器；业务代码里不再出现 `process.env`。
4. 日志挂在 `@needle/logo` 的全局 `logo` 上——Shell 的实时日志流订阅的就是这个实例，另建实例等于右栏空着。
5. 对外行为不变：URL、响应体、状态码、SSE 协议、调度语义、数据目录布局全部照旧（例外见「行为变更」）。

## 非目标

- 不改业务逻辑：`store.ts` / `generator.ts` / `llm.ts` / `model.ts` / `translate*.ts` / `meta.ts` /
  `enrich.ts` / `render.ts` / `design.ts` / `jobs.ts` / `scheduler.ts` 只改 import 与 logger 调用形态。
- 不引入登录：没有 `/login`，没有签发方，没有用户表。
- 不搬目录：代码仍在 `src/`，前端资源仍在 `public/`，prompt 仍在 `prompts/`。
- 不改数据目录、不改端口、不改 launchd label。

## 决策

### 目录

| 方案 | 权衡 |
|---|---|
| **保留 `src/`，内部拆 `api/` + `beans/` + `viper.ts` + `logo.ts` + `main.ts`**（选中） | 业务模块路径不动，测试与脚本改动最小；与示例的 `app/` 只差一层目录名 |
| 照示例全量搬成 `app/` + `res/` | 与示例逐字对齐，但 15 个测试文件的 import、`install.sh` 的 plist、README 全要跟着改，收益只是目录名一致 |
| 只换入口，路由仍留在 `server.ts` | diff 最小，但「一接口一文件」这条根本没落地，等于白换 |

```
src/
  main.ts          装配：initLog → createHonox → registerApis → 启动调度 → 默认导出
  viper.ts         loadConfig 实例（进程级单例）+ `declare module "hono"` 的 uid 声明
  config.ts        配置的派生视图：DATA_DIR / PORT / 模型通道 / 路径函数 / 东八区时间工具
  logo.ts          initLog()：级别、文件 sink、logFiles
  api/
    index.ts       registerApis(app, deps) + allowAnonymous
    pages.ts       GET /、GET /d/:date、GET /app.js
    days.ts        GET /api/days、GET /api/day/:date、GET /api/search、GET /api/search.html
    regen.ts       POST /api/regenerate（含本机判定）
    stream.ts      GET /api/stream（SSE）
    health.ts      GET /health
  beans/
    regen.ts       RegenBody
    regen.generated.ts  TypeBox schema + registerModel + 漂移断言
res/
  config/
    common.yml     所有环境共享
    app_dev.yml    dev 差异项（端口、数据目录、日志级别、模型通道）
    app_fat.yml    空壳，留着占位
    app_pro.yml    同 dev 的非密钥项
```

### 配置键

`ENV` 只认 dev / fat / pro（默认 dev），这是唯一读 `process.env.ENV` 的地方。密钥类一律不进 yml，
用 `APP_*` 注入（`.env` 由 Bun 自动加载，launchd 下由 plist 注入）。

| 键 | 含义 | 旧来源 | 缺省 |
|---|---|---|---|
| `server.web_port` | 监听端口 | `DAILY_NEWS_PORT` | 必填 |
| `server.host` | 监听地址 | `DAILY_NEWS_HOST` | `0.0.0.0` |
| `data.dir` | 数据根目录（支持 `~`） | `DAILY_NEWS_DATA_DIR` | 必填 |
| `logger.filter_level` | debug/info/warn/error | 无（用库默认） | `info` |
| `auth.secret` | JWT 验签密钥 | `DAILY_NEWS_JWT_SECRET` | `""`（只解不验） |
| `shell.user` / `shell.password` | 面板账号（单个） | `CONSOLE_USER` / `CONSOLE_PASSWORD` | `""` → 不挂面板 |
| `shell.secret` | 面板 token 密钥 | `CONSOLE_SECRET` | `""` → 库随机（重启掉登录） |
| `model.primary.provider` / `.model` | 主通道 | `PRIMARY_PROVIDER` / `PRIMARY_MODEL` | `deepseek` / `deepseek-flash` |
| `model.fallback.provider` / `.model` | 兜底通道 | `FALLBACK_PROVIDER` / `FALLBACK_MODEL` | `zai-coding-cn` / `glm-5.3-flash` |
| `model.pi_bin` | pi 可执行文件 | `PI_BIN` | `~/.pi/agent/bin/pi` |

面板账号是**单个** user/password，不是 `server.shell_users` 那样的映射：映射只能写在 yml 里，
而这个面板口令不该进 git。`main.ts` 用它拼出 `auth.users` 那个 map。

### 鉴权

全站匿名。`registerApis` 里 `app.allowAnonymous(["/*"])` 一行声明，理由写在那儿：
内容是公开新闻，手机同 WiFi 直接看；写操作（`/api/regenerate` 会烧 LLM 额度）由 `isLocalRequest`
用 `getConnInfo` 的 socket 地址判本机，与现在一致。

不用「逐条列路由」的白名单：漏一条的症状是「页面 401」，而 `/*` 与业务意图完全一致。

`auth.secret` 留空的后果：客户端主动带 token 时验签必失败，uid 为 null，只记一条 authError。
没有签发方，所以这个键目前只是占位。

### 日志

挂在全局 `logo` 上（示例的 `app/logo.ts` 同一做法）。Shell 的 `createSource` 默认订阅全局 `logo`，
`createHonox` 也不会替 Shell 注入 logger，所以「另建实例」等于面板右栏永远空着。

日志目录跟着数据目录：`<data.dir>/logs`。不做成配置项——launchd 的 `StandardErrorPath`、
`fetch.sh` 的清理逻辑、README 都按这个路径写，多一个配置项只多一处能配错。

请求日志由业务决定：`health` / 页面 / 只读 API / SSE 零日志；写接口（`/api/regenerate`）用
`traceOf(ctx)` 留一行，拒绝的出口记 warn；401/404/500/慢请求由库兜底。比现在的「每个请求
开始+结束两条」安静得多，也不丢排障信息——同一条链路上的行靠 `rid` 串起来。

全局 `logo` 默认挂了一个 stdout sink，`initLog()` 里显式摘掉：launchd 的 `StandardOutPath`
已经在收 stdout，留着等于同一行落两遍盘，`bun test` 也会被日志刷屏。

### 参数校验

`/api/regenerate` 的 body 用 bean + TypeBox schema（示例的 `beans/` 那套）：`date` 可选字符串，
非法 JSON → 400 `bad_request`；日期形状（`YYYY-MM-DD`）仍是业务判定，走 `ResponseX.badRequest`。
`/api/search` 的 query 不套 schema：现在的语义（`limit` 非数字就当没传、上限 200）是刻意的宽容，
TypeBox 会把它变成 400。

## 行为变更（需要接受）

| 变更 | 影响 | 理由 |
|---|---|---|
| `/console` → `/shell` | 老书签失效；README / install.sh 同步改 | 用户指定；与示例默认一致，少一个自定义 basePath |
| 未知路径 404 的 message 由「没有这个路径：/x」变成「接口不存在」 | 只有文案 | 走库的 `notFound`，顺带由库记一行 404 日志 |
| POST `/api/regenerate` 空 body / 非 JSON / `date` 不是字符串 → 400 | 客户端一直发 `{}`，无实际影响 | 参数走 schema 校验，不再 `catch(() => ({}))` |
| 请求日志从「每请求两条」变成「写接口一行 + 库兜底」 | 日志变少 | 框架约定；排障靠 rid 串起业务行与兜底行 |
| 日志不再写 stdout，只进 `<data.dir>/logs` 与面板 | `bun run start` 前台看不到日志（与改造前一致） | launchd 已把 stdout 落盘，两处写等于两份 |
| 响应多一个 `x-rid` 头 | 无 | 库的链路 id |
| `/d/<乱写>` 的 404 页面会转义路径 | 无（修掉一个反射型 XSS） | 原实现把 URL 段直接拼进 HTML |

## 实施步骤（TDD）

1. 改测试：`test/server.test.ts` 改指 `src/main.ts`、`/console` → `/shell`、404 文案；
   删 `test/core.test.ts`（`src/core/` 将被删除）。跑一遍确认红。
2. 配置层：`res/config/*.yml` + `src/viper.ts` + 重写 `src/config.ts`。
3. 日志层：`src/logo.ts`，删 `src/log.ts`，业务侧 `log()` → `logger`。
4. HTTP 层：`src/api/*` + `src/beans/*` + `src/main.ts`，删 `src/server.ts`、`src/core/`。
5. 文档与脚本：README、`.env.example`、`.env`（键改名，值不动）、`scripts/install.sh`、`docs/01.memory.md`。
6. 版本 `0.1.5` → `0.1.6`；`bun test && bunx tsc --noEmit` 全绿后提交。

## 验收

- `bun test`（190 条：原 200 条减去 core 的 12 条，加上 regenerate 的 2 条参数校验）全绿。
- `bunx tsc --noEmit` 全绿。
- `grep -rn "process.env" src/` 只剩三处，都是「进程环境」而非「配置」：`model.ts` 的
  `readShellVar`（凭据：先看环境再读 `~/.zshrc.sh`）、`generator.ts` / `model.ts` 给子进程
  继承的环境（`fetch.sh` 按 `DAILY_NEWS_DATA_DIR` 找数据目录）。
- `grep -r "src/core\|from \"./core" src/ test/` 为空。
- 手工：`APP_SERVER__WEB_PORT=5099 APP_DATA__DIR=/tmp/x bun run src/main.ts` 起得来，
  `/`、`/d/<date>`、`/api/days`、`/health`、`/shell` 都通；`/nope` 回 404 信封；响应带 `x-rid`。

## 留给实现者的

- `src/config.ts` 保留原文件名与原导出名（`DATA_DIR` / `PORT` / `todayInShanghai` …），
  这样 6 个业务模块与 1 个测试文件的 import 不用动；它现在只是 viper 的派生视图。
- `buildApp(options)` 继续接受 `store` / `queuePath` / `generate` / `skipStartupCheck` 四个测试注入口，
  另加 `shellUsers` / `shellSecret`：面板账号在 dev 配置里留空（不挂面板），测试要能验 `/shell` 的鉴权。
- `test/server.test.ts` 的 `/shell` 用例依赖这两个注入口，不要改成读 `.env`。
- `initLog()` 必须幂等（模块级 `initialized`）：测试里每个用例都 `buildApp()`，
  重复挂就是给全局 logo 挂 N 个文件 sink。
