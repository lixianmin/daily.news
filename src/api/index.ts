import type { HonoxApp } from "@needle/honox";
import type { Scheduler } from "../scheduler.ts";
import type { Store } from "../store.ts";
import { createDaysApi } from "./days.ts";
import { createHealthApi } from "./health.ts";
import { createPagesApi } from "./pages.ts";
import { createRegenApi } from "./regen.ts";
import { createStreamApi } from "./stream.ts";

/** 接口层要用的东西。显式传，不用模块级单例：测试要能塞临时目录与假生成。 */
export interface ApiDeps {
  store: Store;
  scheduler: Scheduler;
}

/**
 * 挂载所有 HTTP 接口：一个领域一个文件，这里只做登记。
 *
 * 中间件（rid → 兜底日志 → JWT → 门禁）由 `createHonox` 统一装好，这些路由挂在
 * 它后面，所以每条请求都带着 rid。请求日志不自动写：业务用 `traceOf(ctx)` 决定
 * 打什么；库只补 401 / 404 / 500 / 慢请求。
 */
export function registerApis(app: HonoxApp, deps: ApiDeps): void {
  app.route("/", createPagesApi(deps.store));
  app.route("/", createDaysApi(deps.store));
  app.route("/", createRegenApi(deps.scheduler));
  app.route("/", createStreamApi(deps.scheduler));
  app.route("/", createHealthApi(deps.store, deps.scheduler));

  // 全站匿名：内容是公开新闻，手机在同一 WiFi 下打开就能看，页面本身也没有
  // 登录入口。写操作由 `api/regen.ts` 自己用 socket 地址判本机，与门禁无关。
  //
  // 用 `/*` 而不是逐条列路由：漏一条的症状是「页面 401」，而这里表达的正是
  // 「整个站都公开」这件事。面板（/shell）由 createHonox 自己加进白名单。
  app.allowAnonymous(["/*"]);
}
