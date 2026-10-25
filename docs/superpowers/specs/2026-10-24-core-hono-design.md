# core 目录：通用 Hono 骨架

日期：2026-10-24
状态：已被 `2026-10-25-honox-refactor.md` 取代（`src/core/` 已删除，改用 `@needle/honox`）

## 意图与背景

现在的 Hono 初始化逻辑直接埋在 `src/server.ts` 里：`new Hono()` 加上 `app.use("*", requestLogger(logger))`。
请求日志只有请求**结束**后的一条（method / path / status / elapsedMs / address），没有开始日志，没有请求头，没有 uid。

这个服务接下来要接用户态（JWT、用户 id）。这类东西每个服务都要有，且写一次就够——
所以把「Hono 怎么起」「每个请求怎么记日志」「token 怎么解成用户」抽成 `src/core/`，
core 里**只放通用件**，daily.news 的业务（路由、store、scheduler、needle 控制台）一律留在 core 外面。

现在项目还没有登录，本次只搭架子：骨架完整、可测、字段留好，但不去实现登录。

## 目标

- `src/core/` 提供 `createHono()`，一行拿到一个装好通用中间件的 Hono 实例。
- 每个请求开始与结束各一条 info 日志，字段尽量多（请求头、耗时、状态码、客户端地址、uid）。
- JWT 中间件把 `Authorization: Bearer <token>` 解成用户上下文（uid），供日志与后续路由取用。
- 用户 id 用 ULID（可按时间排序的字符串），不用 UUID。

## 非目标

- 登录、注册、发 token、刷新 token、登出。
- 用户表 / 数据库 / 权限模型。
- core 里出现任何 daily.news 特有的概念（日期、来源、日报、needle 控制台）。

## 约束

- 通用性优先：core 不 import 本仓任何业务模块。日志器用结构化接口描述，不绑死 `@needle/logo`。
- JWT 用 hono 自带的 `hono/jwt`，不引新依赖。
- ULID 用 npm 包 `ulid`（MIT，单文件），不手写 base32。
- 客户端地址的取法要跨运行时：core 不能只认 Bun 的 `getConnInfo`。

## 方案（Approaches）

### core 放哪一层

| 方案 | 权衡 |
|---|---|
| **项目内 `src/core/`**（选中） | 改动最小，今天就能落地；纯通用代码，将来要复用再整体搬出去 |
| 独立可复用包 `packages/core` | 能被别的仓库直接引用，但要动 package.json / tsconfig，多一层构建配置 |
| 独立仓库 `~/me/code/core` | 边界最干净，跨仓库改动成本最高 |

选中项目内 `src/core/`：眼下只有一个消费者，为将来才有的第二个消费者付配置成本不值。

### token 缺失 / 无效时怎么办

| 方案 | 权衡 |
|---|---|
| **匿名放行，uid 记空**（选中） | daily.news 必须局域网可读（手机看页面），骨架阶段不能因为没登录就 401 |
| 一律 401 | 自断手脚，页面全部打不开 |
| 只对 `/api/*` 挡 | core 里塞了路径白名单这种业务规则，违背通用性 |

选中匿名放行：中间件只负责「尽力解出 uid 并记进日志」，不负责鉴权。将来真要鉴权，在 core 外加一层守卫。

### ULID 怎么来

| 方案 | 权衡 |
|---|---|
| **引 `ulid` 包**（选中） | base32 编码与时间戳排序是现成的，不容易写错；代价是多一条依赖 |
| 手写 ULID | 零依赖，但要自己保证 Crockford base32 正确，单调递增还得另说 |

选中 `ulid` 包。

## 设计

### 目录结构

```
src/core/
  index.ts     出口
  types.ts     CoreLogger / CoreUser / CoreEnv
  hono.ts      createHono()
  logger.ts    请求日志中间件
  auth.ts      JWT 中间件
  uid.ts       ULID 生成
```

### `createHono(options?)`

```ts
interface CreateHonoOptions {
  logger?: CoreLogger;   // 传了就装日志中间件
  jwtSecret?: string;    // 传了就验签；不传只解不验
}
```

中间件注册顺序：**日志在外，鉴权在内**。这样开始日志是整个请求的第一条，
结束日志又能拿到鉴权中间件写进 context 的 uid。

```ts
app.use("*", requestLogger(options.logger));   // 外层
app.use("*", jwtAuth({ secret: options.jwtSecret }));  // 内层
```

### 日志中间件

日志器用最小结构化接口描述，core 不绑死 `@needle/logo`：

```ts
interface CoreLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}
```

**开始**（`logger.info("request start", …)`）：

| 字段 | 说明 |
|---|---|
| requestId | ULID，同一请求的开始/结束两条共用 |
| method / path / query | 方法、路径（不含 query）、query 串 |
| url | 完整 URL |
| protocol / host | 协议、Host。host 取 `url.host` 而不是 Host 头——`Request` 对象里可以没有 Host 头 |
| ip | 客户端地址：先试 `c.env.requestIP`（socket，真实），回落 `x-forwarded-for` / `x-real-ip`，都没有记 `unknown`。core 未定义 `Bindings` 时 `c.env` 的类型是 `undefined`，取 `requestIP` 要断言 + 判空 |
| userAgent / referer | 请求头 |
| contentType / contentLength | 请求体类型与大小 |
| hasAuthorization | **只有布尔值**，绝不记 token 本身 |

**结束**（`logger.info("request end", …)`）：`requestId`、`method`、`path`、`status`、`elapsedMs`、`ip`、
`uid`、`authenticated`、`verified`、`authError`、`responseContentType`、`responseContentLength`、
`error`（处理函数抛出的异常对象）。

**5xx**：结束日志记完 info 后，再记一条 `logger.error("request failed", 结束字段)`——
否则「返回 500」的请求在日志里只会留下一条 info，排查时看不出是错误级别。

**异常对象怎么拿到**：Hono 的 `compose` 会把处理函数抛的异常吞成 500 响应
（见 `hono/compose.js`：`catch (err) { res = await onError(err, context) }`），
**中间件里的 try/catch 根本抓不到**。所以 `createHono` 装一个 `app.onError`：
把异常存进 context（`c.set("requestError", err)`），返回 500 响应，
再由请求结束日志把它带出来。没有 logger 时不装 onError，走 Hono 默认行为（`console.error` + 500）。

### JWT 中间件

- 取 `Authorization: Bearer <token>`。没有 → 匿名放行（`c.set("user", undefined)`）。
- 配了 secret → `await verify(token, secret, { alg: "HS256" })`；验签失败 → 记 `authError`，匿名放行。
  **第三个参数必填**：`hono/jwt` 的 `verify` 签名是
  `(token, key, algOrOptions)`，只给两个参数编译不过。
- 没配 secret → `decode(token)` 解出 payload，`verified = false`。
  此时 uid **未经验签，不可信**，只用于日志观察。
- `decode` 对畸形 token 会抛 `JwtTokenInvalid`，**必须 try/catch**，不能让坏 token 把请求打挂。
- uid 取 `payload.uid`，没有则取 `payload.sub`（JWT 标准主体字段）；
  `JWTPayload` 的值类型是 `unknown`，非空字符串才算数，否则视为没解出用户。
- 解出用户时 `c.set("user", { uid, verified, payload })`。

```ts
interface CoreUser {
  uid: string;
  verified: boolean;   // 验签是否通过
  payload: CoreJwtPayload;
}
```

`CoreJwtPayload` 由 core 自己定义（不直接用 `hono/jwt` 的 `JWTPayload`——
那个类型不从 `hono/jwt` 入口导出，而且 core 的公开类型不该把 hono 的内部类型泄露给业务代码）。

### ULID

`core/uid.ts` 导出 `newUid(): string`，包一层 `ulid()`。
请求 id 也用 ULID（同一种 id 格式，日志里一眼能看出先后）。

### daily.news 的接入

- `src/server.ts`：`const app = createHono({ logger, jwtSecret: JWT_SECRET })`，
  删掉 `app.use("*", requestLogger(logger))`。
- `src/middleware.ts`：删除，内容迁到 `src/core/logger.ts`（原实现只记结束一条，
  且按状态码分级，与新规则不一致，不保留）。- `src/config.ts`：加 `JWT_SECRET`（环境变量 `DAILY_NEWS_JWT_SECRET`，缺省 `""` = 只解不验）。
- `.env.example`：补一行 `DAILY_NEWS_JWT_SECRET=`。
- `/console` 的 needle 登录**不受影响**：它用自己的一套 secret，与 core 的 JWT 无关。

## 实施步骤（TDD）

1. `test/core.test.ts` 写失败测试：`createHono` 能起路由并返回 200；日志中间件发开始/结束两条且字段齐；
   带合法 token → `c.get("user").uid` 正确；无 token / 坏 token → 请求仍 200、uid 为空；
   `newUid()` 是 26 位 Crockford base32 且随时间递增。
2. 实现 `src/core/`：`types.ts` → `uid.ts` → `logger.ts` → `auth.ts` → `hono.ts` → `index.ts`。
3. 测试跑绿。
4. 接入 daily.news：`config.ts` 加 `JWT_SECRET`、`.env.example` 补一行、`server.ts` 换 `createHono`、
   删 `src/middleware.ts`、更新 `docs/01.memory.md` 文件索引。
5. 版本号 0.1.2 → 0.1.3。
6. `bun test && bunx tsc --noEmit` 全绿后提交。

## 验收

- `bun test`（新增 `test/core.test.ts`）+ `bunx tsc --noEmit` 全绿。
- 新增测试覆盖：`createHono` 能起路由；日志中间件发开始/结束两条且字段齐；
  带合法 token → `c.get("user").uid` 正确；无 token / 坏 token → 请求仍 200、uid 为空；
  `newUid()` 是 26 位 Crockford base32 且随时间递增。
- 版本号 0.1.2 → 0.1.3。

## 留给实现者的

- `ip` 的取值顺序（socket → 代理头 → unknown）是本设计的判断，实现时照做即可。
- `CoreEnv` 的 `Variables` 只放 `user?: CoreUser`，将来 core 之外加变量时在该类型里加。
