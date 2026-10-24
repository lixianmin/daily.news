# 调度层重构：引入 bunqueue

日期：2026-10-24
状态：待实现
关联：`docs/superpowers/specs/2026-10-23-daily-news-design.md`（§调度归属）、`docs/01.memory.md`（2026-10-24 调度归服务自管）

## 1. 背景与问题

现有 `src/scheduler.ts` 用 `setTimeout` / `setInterval` 手写调度，调度状态全在内存里。两个已确认的缺陷：

**缺陷 A —— 补生成待办随进程消失。**
失败来源的补生成由 `scheduleRetry()` 用内存里的 `setTimeout` 安排（`pendingRetry` / `retryAttempts` / `retryTimer`）。进程在这 10 分钟等待窗口内重启（launchd KeepAlive 会拉起服务；生成本身要跑几分钟，中途崩溃或重启并不罕见），待办随之消失，当天缺的章节永远补不上。

**缺陷 B —— 当天部分失败后永不补跑。**
- `src/generator.ts:382` 算出 `failedSources`，但 `src/generator.ts:410` 仍然把当天成品落盘（失败来源记成 `sources[key].ok = false`）；
- `src/server.ts:84` 的 `hasDay` = `readDay(date) !== null`，写盘之后为 true；
- `src/scheduler.ts:330` 的每小时复查被 `src/scheduler.ts:178` 无条件赋值的 `lastRunDate` 挡住（成功失败都赋）。

三重叠加的结果：当天缺来源的成品永久停在 ⚠️，只能靠人点「重新生成」。

根因是同一个：调度待办只有内存态，没有持久态；而「当天是否完整」这个判定被简化成了「当天有没有文件」。

## 2. 目标

1. 调度待办持久化，进程重启后自动恢复未执行的延时任务。
2. 「当天是否完整」成为一等判定：所有来源都成功才算完整。
3. 每日 07:00（东八区）与失败补生成统一到同一套队列语义，失败重试有明确上限。
4. 同一队列支持多种任务类型（按 job 名分发），为将来新增后台任务留位置——但不预先实现任何新任务。
5. 进度事件（SSE）与手动触发的对外行为保持不变。

## 3. 选型

**bunqueue 2.9.18**（MIT，Bun-first，运行时仅依赖 msgpackr，SQLite 单文件持久化，内嵌模式让队列与 worker 同进程）。

候选对比（2026-10-24 实测 npm registry + GitHub API）：

| 候选 | 外部依赖 | 月下载 | stars | 结论 |
|---|---|---|---|---|
| bunqueue 2.9.18 | 无（内嵌 SQLite）／可选 PG | 21.7k | 588 | **选中**：MIT、活跃、无守护进程、Bun-first |
| bullmq 6.4.1 | Redis | 35.8M | — | 为一个本地服务引入 Redis 守护进程，不划算 |
| pg-boss 12.38.0 | PostgreSQL | 9.7M | — | 同上 |
| graphile-worker 0.18.0 | PostgreSQL | 2.7M | — | 同上 |
| @dbos-inc/dbos-sdk 5.3.0 | PostgreSQL | 1.8M | — | 同上 |
| @temporalio/client 1.24.0 | Temporal Server | 16.5M | — | 工作流引擎，本项目用不上 |
| workmatic 1.2.0 | better-sqlite3（原生模块） | 307 | 8 | Bun 上依赖原生模块，生态极小 |
| @thorium-sim/plainjob 0.0.26 | better-sqlite3 | 107 | 0 | 0.0.x，无人用 |
| @lomatina/queue-lite 0.1.0 | bun:sqlite | 18 | 5 | 刚发布，基本无人用 |
| @qkitt/queue 0.15.1 | 无 | 94 | 0 | 0 stars |

**风险记录**：bunqueue 仓库 2026-01-28 才建，v2.x 说明 API 仍在动。选它是因为没有更成熟的「无外部守护进程」替代品；若将来它停更，替换成本是本 spec §5 描述的薄封装层（jobs.ts 不认识 bunqueue），不是全盘重写。

### 实测结论（Bun 1.4.2 本地探针）

| 行为 | 结果 |
|---|---|
| 内嵌模式 + `dataPath` 单文件持久化 | 进程被 kill 后延时任务仍在，重启后按原定时刻执行 ✓ |
| cron 支持 IANA 时区 | `pattern '0 7 * * *'` + `timezone 'Asia/Shanghai'` → 下一次为东八区次日 07:00 ✓ |
| `skipMissedOnRestart: false` | 错过 07:00 后重启，错过的时段立即补跑 ✓（实测：错过 02:18 的每分钟 cron，重启后 02:18:48 触发） |
| `job.updateProgress(对象)` | worker 的 `progress` 事件原样拿到对象 ✓ |
| `job.updateData()` | 能在重试之间收窄 payload ✓ |
| `attempts` + `backoff: {type:'fixed'}` | 同一 job 内重试 N 次，耗尽后 `getJobState` = `failed` ✓ |
| `getJobState(不存在的 id)` | 返回 `unknown` ✓ |
| 同一 jobId 重复 `add` | 任务处于 waiting/active/delayed 时幂等；**已 completed/failed 时会重新执行**——所以「重试链已耗尽」必须靠查 state 拦住，不能靠 jobId ✓ |

## 4. 架构

```
src/config.ts      + queueDbPath()
src/jobs.ts        job 数据类型 + 处理逻辑（不认识 bunqueue）
src/scheduler.ts   队列装配（bunqueue）+ 对外 API
```

依赖方向：`scheduler → jobs → types/config`。`jobs.ts` 不 import bunqueue，因此处理逻辑可以脱离队列单测。

## 5. 队列与任务

- 队列名：`daily-news`（单队列）
- 持久化：`DATA_DIR/jobs.db`（SQLite）
- worker `concurrency = 1`：生成任务绝不并发

job 名只有一个：`generate-day`。payload 按 kind 区分：

| kind | 触发者 | date | 补哪些来源 |
|---|---|---|---|
| `today` | 每日 cron | **执行时**的东八区当天 | 有成品则只补缺的，否则全量 |
| `catchup` | 启动补跑 | 入队时的当天 | 同上 |
| `manual` | 页面手动触发 | 指定日期 | 全部（全量覆盖） |
| `retry` | 失败补生成 | 指定日期 | 指定来源 |

## 6. 调度规则

### 6.1 每日 cron
- schedulerId `daily-generate`，`pattern '0 7 * * *'`，`timezone 'Asia/Shanghai'`，`skipMissedOnRestart: false`
- 服务在 07:00 不在线 → 重启后立即补跑一次
- 处理函数先判「当天已有完整成品」→ 跳过

### 6.2 启动补跑 `checkOnStart()`
1. 今天已有完整成品 → 不动
2. 现在还没到东八区 07:00 → 不动（凌晨生成「今天」没意义，热榜才刚开始）
3. 否则入队 `kind: 'catchup'`，jobId `catchup:<date>`

### 6.3 失败补生成（重试链）
- 生成抛异常 → 视作全部来源失败；生成返回 `failedSources` → 只算这些来源
- 入队 jobId `retry:<date>`，`delay` 10 分钟，`attempts` 3，`backoff` fixed 10 分钟
- 重试期间仍有来源失败 → `updateData` 收窄来源后抛错，由队列重试**同一个** job
- 3 次用尽 → job state = `failed`，当天不再补
- 入队前先查 state：只有 `unknown` 才入队；`waiting`/`active`/`delayed`/`failed`/`completed` 都不入队
  → 保证「每天每来源最多 3 次补跑」这个上限不被绕过

### 6.4 手动重新生成
- jobId `manual:<date>`；已有生成在跑时直接返回 `started: false`（不排队，重复点击不叠加调用）
- 强制全量重生成（覆盖当天成品）

### 6.5 完整性判定
```
missingSources(day) = SOURCE_KEYS 中 day.sources[k]?.ok !== true 的那些
```

## 7. 进度事件

- 处理函数调 `job.updateProgress(event)`，同时本地 `record(event)`——不依赖 worker 的 `progress` 事件管线，避免丢事件
- 环形缓冲仍保留最近 50 条，供 SSE 新连接补齐历史
- 事件语义不变：`stage` 取值与文案沿用现有 `ProgressEvent`

## 8. 文件布局

```
DATA_DIR/
  days/YYYY-MM-DD.json
  index.json
  jobs.db          ← 新增：队列持久化
  runs/  logs/
```

## 9. 降级

- 队列起不来（DB 损坏、权限问题）→ **服务照常起**，页面可读；调度能力标记为不可用并记 error 日志，不静默假装没有定时任务
- 单次生成失败不影响服务存活（与现状一致）

## 10. 测试

单元（`test/jobs.test.ts`）：
- 完整性判定：缺哪些来源
- 四种 kind 各自选出的来源集合
- 生成失败 → 入队重试；重试链已耗尽（state=failed）→ 不再入队

集成（`test/scheduler.test.ts`，真实 bunqueue + 临时 db 文件）：
- 手动触发 → 生成被调用、事件被记录、可订阅/退订
- 延时重试：生成失败 → 延时后补跑，且只补失败的来源（测试里把 delay 调小）
- 重启恢复：关闭调度器再打开，延时任务仍在队列里
- cron 注册：下一次触发时间 = 东八区次日 07:00
- 并发保护：已有生成在跑时手动触发被拒

## 11. 不在本次范围

- 多 worker / 分布式 / 独立队列服务（只用内嵌模式）
- 队列 dashboard、任务历史页面
- 新的后台任务类型（只为将来留位置）
- 保留旧的小时复查定时器——由 cron 的错点补跑 + 重试链取代
