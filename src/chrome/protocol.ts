/**
 * pi-chrome 桥的线上协议。
 *
 * 协议本体在 Chrome 伴侣扩展里（`~/.pi/agent/npm/node_modules/pi-chrome/extensions/`），
 * 这里只声明本服务用到的形状与常量。四个端点：
 *
 * - `GET  /status`   —— 桥的状态（谁占着端口、扩展有没有在轮询）
 * - `GET  /next`     —— 扩展的长轮询：取一条命令 `{id, action, params}`
 * - `POST /result`   —— 扩展回结果 `{id, ok, result | error}`
 * - `POST /command`  —— 本地进程下发命令 `{action, params, timeoutMs}`，同步等结果
 *
 * 动作语义（`page.evaluate` / `tab.new` …）实现在扩展里，桥只负责转发。
 */

/** 桥监听地址。扩展把地址写死成这个端口，换不了。 */
export const BRIDGE_HOST = "127.0.0.1";
export const BRIDGE_PORT = 17318;

/** 桥的根地址。 */
export const BRIDGE_URL = `http://${BRIDGE_HOST}:${BRIDGE_PORT}`;

/** 扩展长轮询的最长等待。与扩展侧的 25s 对齐。 */
export const BRIDGE_POLL_TIMEOUT_MS = 25_000;

/**
 * 本服务对接的扩展版本下限。
 *
 * 扩展在 `/next` 响应头里带 `x-pi-chrome-version`，比它旧就自己 reload。
 * 我们不发那个头（免得触发扩展自我 reload），改成自己问扩展要版本再比对。
 */
export const MIN_EXTENSION_VERSION = "0.15.0";

/** 一条待执行命令。 */
export interface BridgeCommand {
  id: string;
  action: string;
  params: Record<string, unknown>;
}

/** 扩展回传的结果。 */
export interface BridgeResult {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** 桥的状态。字段与 pi-chrome 自带的 `/status` 保持一致。 */
export interface BridgeStatus {
  url: string;
  /** 谁占着端口：`server` 是自己，`client` 是别人（自己只是转发）。 */
  mode: "server" | "client";
  /** Chrome 扩展有没有在轮询。false 时发命令只会等到超时。 */
  connected: boolean;
  /** 扩展最后一次轮询的时间戳（毫秒）。 */
  lastSeenAt?: number;
  /** 扩展的客户端名（`Pi Chrome Connector <id>`）。 */
  clientName?: string;
  queuedCommands: number;
  pendingCommands: number;
}
