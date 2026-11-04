# Remote Control：远程开关显示器

## 1. 背景与目标

服务跑在常驻的 Mac 上（本机 launchd 常驻，绑 `0.0.0.0`，Tailscale 可达）。
人在外面（手机浏览器）时经常需要把家里/工位那台 Mac 的屏幕点亮看一眼，或者
离开时把屏幕关掉省电。这两件事今天只能走到机器前面做。

目标：站点上多一个 **Remote Control** 页面，两个按钮：

- **唤醒屏幕**：点亮显示器
- **关闭屏幕**：让显示器进入休眠（**只关屏幕**，机器继续跑）

只管显示器，不管主机睡不睡——这是需求里明确划的边界。

## 2. 范围

做：

- 页面 `/remote`，两个按钮 + 一行状态提示
- 两个写接口：`POST /api/remote/wake`、`POST /api/remote/sleep`
- 调 macOS 自带的系统命令执行显示器开关

不做：

- 主机休眠/唤醒（`pmset sleepnow` / 唤醒主机）——超出「只关显示器」的边界
- 主机已经睡眠时的远程唤醒：显示器的电源断言救不醒睡着的 CPU，
  要做到那一步得走 `wakeonlan` / `pmset repeat wakeonlan` 之类，属于另一个需求
- 给这页加登录：全站匿名是本项目既定的形态（见 `docs/01.memory.md`
  2026-10-25「全站匿名」那条），写接口 `/api/regenerate` 也已经是局域网可触发

## 3. 系统接口

macOS 上控制「只关屏幕」的标准做法就是 `pmset`：

| 动作 | 命令 | 备注 |
|---|---|---|
| 关闭屏幕 | `pmset displaysleepnow` | 立即让显示器休眠，主机不睡。本机实测非 root 可用，退出码 0 |
| 唤醒屏幕 | `caffeinate -u -t 1` | `-u` 模拟一次「用户活动」电源断言，把显示器从 display sleep 里拉回来；`-t 1` 表示断言只维持 1 秒 |

`caffeinate -u` 是唤醒显示器的通行做法：不装驱动、不需要辅助功能权限
（`osascript`/`System Events` 那条路要开辅助功能授权，装机/换机会坏）。

两个命令都是**固定命令 + 固定参数**，不接受外部输入，不经过 shell 解析
（`Bun.spawn` 直接传 argv），所以不存在命令注入面。

## 4. 结构

```
src/display.ts        显示器控制：命令拼装 + 执行（可注入执行器，测试用）
src/api/remote.ts     页面路由 + 两个写接口
public/remote.js      按钮交互（原生 fetch，不引框架）
src/render.ts         renderRemotePage()：页面 HTML
src/design.ts         .remote-* 样式
```

`public/remote.js` 必须由 `src/api/pages.ts` **显式登记路由**（`/remote.js`）：
本仓没有静态文件中间件，漏登记就是脚本 404——页面看着正常，但按钮没有事件
处理器，点了毫无反应。`test/remote.test.ts` 有一条断言把每个页面引用的
`<script src>` 都真的取一遍，漏登记当场红。

分层照本项目既有习惯：

- 命令拼装与执行放 `src/display.ts`，不认识 HTTP
- HTTP 层放 `src/api/remote.ts`，一个领域一个文件
- 渲染放 `src/render.ts`，转义照旧走 `escapeHtml`

### 接口

`POST /api/remote/wake` → `{"ok":true,"action":"wake"}`

`POST /api/remote/sleep` → `{"ok":true,"action":"sleep"}`

命令执行失败（退出码非 0 / 命令不存在）→ `500`，用 needle 的 `Trace.internalError`
出口：`{"code":"internal_error","message":"…"}`。错误码不新造——needle 的约定是
「一个状态码只配一个 code」，细分靠 message。

写操作一律记日志（`traceOf(ctx)`），谁在什么时候关了屏幕要查得到。

### 依赖注入

`DisplayControl` 接口有两个方法（`sleepDisplay` / `wakeDisplay`）。
`buildApp` 收 `options.display`，不传就用真实实现。测试注入假实现，
不真的去关用户的屏幕。

## 5. 页面

`/remote`：

- 标题 **Remote Control**
- 两个大按钮：`唤醒屏幕` / `关闭屏幕`
- 一行状态提示：请求中 / 成功 / 失败原因

复用现有 `layout()`（侧边栏 + 浮动目录）。这一页不需要目录浮窗，
`layout()` 加一个 `showToc` 开关关掉它。

侧边栏里给所有页面加一条 `Remote Control` 入口（否则这页只能靠手敲 URL 进）。

## 6. 测试

- `test/display.test.ts`：命令拼装（参数逐个断言）、退出码非 0 时 `ok:false`、
  执行器抛异常时也返回 `ok:false` 而不是把异常抛到 HTTP 层
- `test/remote.test.ts`：页面 200 且含两个按钮；两个接口命中注入的假实现；
  命令失败时接口返回 500 + `code`
- `public/remote.js` 是纯 JS 不参与 `tsc --noEmit`，测试里用 `new Function(src)`
  编译一遍，防止语法错误把整个脚本打死（`docs/01.memory.md` 有这条教训）

## 7. 已知限制

- 主机睡眠时唤醒按钮无效（显示器断言救不醒 CPU）
- 远程关屏之后主机不会进睡眠，耗电照旧
- 这页没有鉴权：能访问到服务的人都能关/开屏幕。全站匿名是项目既定形态，
  风险等级等同已有的 `/api/regenerate`
