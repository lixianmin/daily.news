import { loadConfig } from "@needle/honox/node";

/**
 * 全进程唯一的配置实例（viper 风格取值器）。
 *
 * 加载顺序：`res/config/common.yml` → `res/config/app_<env>.yml` → `APP_*` 环境变量。
 * `ENV` 决定读哪份环境文件，只认 dev / fat / pro（默认 dev，写错直接报错）；
 * 这是整个项目唯一读 `process.env` 的地方。
 *
 * 业务代码不直接 import 这个实例，而是 import `src/config.ts` 里的常量与路径函数——
 * 那里把点分路径翻成了有类型、有名字的东西。只有需要原始值时（如 shell 的账号）
 * 才在这里取。
 */
export const viper = loadConfig({
  dir: "res/config",
  required: ["server.web_port", "data.dir"],
});
