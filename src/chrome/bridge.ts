import {
  BRIDGE_HOST,
  BRIDGE_PORT,
  BRIDGE_POLL_TIMEOUT_MS,
  type BridgeCommand,
  type BridgeResult,
  type BridgeStatus,
} from "./protocol.ts";

/**
 * pi-chrome 的桥客户端 / 桥服务端（两栖）。
 *
 * 桥只是一条本地邮箱：Chrome 伴侣扩展长轮询 `/next` 取命令，做完把结果 `POST /result` 回来。
 * 「谁占着 17318 端口」决定了这两种角色：
 *
 * - **client**：端口已经被别人（通常是 pi session）占着 —— 命令 `POST /command` 转发给它。
 * - **server**：端口空着 —— 自己当 owner，把命令排给扩展。抓完就释放端口。
 *
 * 与 pi-chrome 自己的多会话模型一致（先起的当 owner，后起的当 client），
 * 所以服务与 pi session 可以同时在跑，互不影响。
 */

interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** 命令已经被扩展取走的时刻。用来区分「没人轮询」与「扩展没回结果」。 */
  deliveredAt?: number;
}

export interface ChromeBridgeOptions {
  host?: string;
  port?: number;
  /** 扩展长轮询的最长等待。 */
  pollTimeoutMs?: number;
  /** 探测已有 owner 的超时。 */
  probeTimeoutMs?: number;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

export class ChromeBridge {
  private readonly host: string;
  private readonly port: number;
  private readonly pollTimeoutMs: number;
  private readonly probeTimeoutMs: number;

  private server: ReturnType<typeof Bun.serve> | undefined;
  private mode: "server" | "client" | undefined;

  private queue: BridgeCommand[] = [];
  private waiters: ((command: BridgeCommand | undefined) => void)[] = [];
  private readonly pending = new Map<string, PendingCommand>();

  private lastSeenAt: number | undefined;
  private clientName: string | undefined;

  private constructor(options: ChromeBridgeOptions) {
    this.host = options.host ?? BRIDGE_HOST;
    this.port = options.port ?? BRIDGE_PORT;
    this.pollTimeoutMs = options.pollTimeoutMs ?? BRIDGE_POLL_TIMEOUT_MS;
    this.probeTimeoutMs = options.probeTimeoutMs ?? 1_000;
  }

  /**
   * 连上桥：已有 owner 就当 client，端口空着就自己当 owner。
   *
   * 竞态：探测之后端口被抢走（pi session 正好启动）→ 绑定失败 → 退回 client。
   */
  static async connect(options: ChromeBridgeOptions = {}): Promise<ChromeBridge> {
    const bridge = new ChromeBridge(options);
    await bridge.open();
    return bridge;
  }

  /** 当前角色。`server` 是自己占着端口，`client` 是转发给别人。 */
  get role(): "server" | "client" | undefined {
    return this.mode;
  }

  /** 桥地址。owner 模式下用实际绑定的端口（port 传 0 时由系统分配）。 */
  get url(): string {
    return `http://${this.host}:${this.boundPort}`;
  }

  /** 实际使用的端口。 */
  get boundPort(): number {
    return this.server?.port ?? this.port;
  }

  private async open(): Promise<void> {
    if (await this.probeOwner()) {
      this.mode = "client";
      return;
    }
    try {
      this.server = Bun.serve({
        hostname: this.host,
        port: this.port,
        fetch: (request) => this.handle(request),
      });
      this.mode = "server";
    } catch (error) {
      if (!isAddrInUse(error)) {
        throw error;
      }
      // 探测之后端口被别人抢走了：当 client 转发过去。
      this.mode = "client";
    }
  }

  /** 端口上是不是已经有个桥（多半是 pi session）。 */
  private async probeOwner(): Promise<boolean> {
    try {
      const response = await fetch(`${this.url}/status`, {
        signal: AbortSignal.timeout(this.probeTimeoutMs),
      });
      if (!response.ok) {
        return false;
      }
      const body = (await response.json()) as Partial<BridgeStatus>;
      return typeof body.url === "string";
    } catch {
      return false;
    }
  }

  /** 桥状态。client 模式直接问 owner。 */
  async status(): Promise<BridgeStatus> {
    if (this.mode === "client") {
      try {
        const response = await fetch(`${this.url}/status`, { signal: AbortSignal.timeout(this.probeTimeoutMs) });
        if (response.ok) {
          return (await response.json()) as BridgeStatus;
        }
      } catch {
        // 下面的兜底状态已经够用了
      }
      return {
        url: this.url,
        mode: "client",
        connected: false,
        queuedCommands: 0,
        pendingCommands: 0,
      };
    }
    return {
      url: this.url,
      mode: "server",
      connected: this.lastSeenAt !== undefined,
      ...(this.lastSeenAt === undefined ? {} : { lastSeenAt: this.lastSeenAt }),
      ...(this.clientName === undefined ? {} : { clientName: this.clientName }),
      queuedCommands: this.queue.length,
      pendingCommands: this.pending.size,
    };
  }

  /**
   * 发一条命令，等扩展做完。
   *
   * 超时抛错，不返回 null——调用方要区分「超时」和「结果是空」。
   */
  async send(
    action: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = DEFAULT_COMMAND_TIMEOUT_MS,
  ): Promise<unknown> {
    if (this.mode === "client") {
      return this.sendViaOwner(action, params, timeoutMs);
    }
    return this.dispatch(action, params, timeoutMs);
  }

  /** client 模式：把命令转给占着端口的 owner。 */
  private async sendViaOwner(
    action: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    const response = await fetch(`${this.url}/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, params, timeoutMs }),
      signal: AbortSignal.timeout(timeoutMs + 5_000),
    });
    const payload = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: unknown;
      error?: string;
    };
    if (!response.ok || payload.ok !== true) {
      throw new Error(payload.error ?? `Chrome bridge HTTP ${response.status}`);
    }
    return payload.result;
  }

  /** owner 模式：命令排队，等扩展来取。 */
  private dispatch(action: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const command: BridgeCommand = { id, action, params };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.queue = this.queue.filter((queued) => queued.id !== id);
        reject(new Error(this.timeoutMessage(timeoutMs)));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.enqueue(command);
    });
  }

  private enqueue(command: BridgeCommand): void {
    const waiter = this.waiters.shift();
    if (waiter === undefined) {
      this.queue.push(command);
      return;
    }
    const entry = this.pending.get(command.id);
    if (entry !== undefined) {
      entry.deliveredAt = Date.now();
    }
    waiter(command);
  }

  /** 分清三种超时：扩展没轮询 / 取走了没回 / 正常但慢。 */
  private timeoutMessage(timeoutMs: number): string {
    const pollAgeMs = this.lastSeenAt === undefined ? undefined : Date.now() - this.lastSeenAt;
    const entries = [...this.pending.values()];
    const delivered = entries.some((entry) => entry.deliveredAt !== undefined);
    if (delivered) {
      return `Chrome 命令超时（${timeoutMs}ms）：扩展收到了命令但没回结果`;
    }
    if (pollAgeMs === undefined || pollAgeMs > 60_000) {
      return `Chrome 命令超时（${timeoutMs}ms）：Chrome 扩展没有在轮询（${
        pollAgeMs === undefined ? "从未见过" : `${Math.round(pollAgeMs / 1000)}s 前`
      }）。确认 Chrome 开着，且 chrome://extensions 里加载了 Pi Chrome Connector`;
    }
    return `Chrome 命令超时（${timeoutMs}ms）：扩展在轮询但没及时取走命令`;
  }

  /** 扩展来取命令。取不到就空转等到超时（长轮询）。 */
  private takeCommand(timeoutMs: number): Promise<BridgeCommand | undefined> {
    const queued = this.queue.shift();
    if (queued !== undefined) {
      const entry = this.pending.get(queued.id);
      if (entry !== undefined) {
        entry.deliveredAt = Date.now();
      }
      return Promise.resolve(queued);
    }
    return new Promise<BridgeCommand | undefined>((resolve) => {
      let settled = false;
      const waiter = (command: BridgeCommand | undefined): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.waiters = this.waiters.filter((entry) => entry !== waiter);
        resolve(command);
      };
      const timer = setTimeout(() => {
        waiter(undefined);
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  /** HTTP 入口：四个端点。语义与 pi-chrome 自带的桥一致。 */
  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("origin") ?? "";
    const secFetchSite = request.headers.get("sec-fetch-site") ?? "";
    // 有 Origin 就必须是扩展自己；没有 Origin 才看 sec-fetch-site（本地进程直连）。
    const fromExtension =
      origin !== ""
        ? origin.startsWith("chrome-extension://")
        : secFetchSite === "" || secFetchSite === "none" || secFetchSite === "same-origin";

    if (request.method === "OPTIONS") {
      if (!fromExtension) {
        return json(403, { ok: false, error: "browser origin not allowed" });
      }
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method === "GET" && url.pathname === "/status") {
      return json(200, await this.status());
    }

    if (request.method === "GET" && url.pathname === "/next") {
      if (!fromExtension) {
        return json(403, { ok: false, error: "browser origin not allowed" });
      }
      this.lastSeenAt = Date.now();
      this.clientName = url.searchParams.get("name") ?? this.clientName;
      const command = await this.takeCommand(this.pollTimeoutMs);
      return json(200, command === undefined ? { type: "none" } : { type: "command", command }, corsHeaders(origin));
    }

    if (request.method === "POST" && url.pathname === "/result") {
      const body = (await request.json().catch(() => ({}))) as BridgeResult;
      const entry = this.pending.get(body.id);
      if (entry === undefined) {
        return json(404, { ok: false, error: "unknown command id" }, corsHeaders(origin));
      }
      clearTimeout(entry.timer);
      this.pending.delete(body.id);
      if (body.ok) {
        entry.resolve(body.result);
      } else {
        entry.reject(new Error(body.error ?? "Chrome 命令失败"));
      }
      return json(200, { ok: true }, corsHeaders(origin));
    }

    if (request.method === "POST" && url.pathname === "/command") {
      // 只接受本地进程（没有浏览器 origin 头）
      if (origin !== "" || secFetchSite !== "") {
        return json(403, { ok: false, error: "Chrome commands are accepted only from local processes" });
      }
      const body = (await request.json().catch(() => ({}))) as {
        action?: string;
        params?: Record<string, unknown>;
        timeoutMs?: number;
      };
      if (body.action === undefined || body.action === "") {
        return json(400, { ok: false, error: "Missing command action" });
      }
      try {
        const result = await this.dispatch(body.action, body.params ?? {}, body.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
        return json(200, { ok: true, result });
      } catch (error) {
        return json(504, { ok: false, error: (error as Error).message });
      }
    }

    return json(404, { error: "not found" });
  }

  /** 释放端口。owner 模式下停掉 server，client 模式下什么都不做。 */
  async stop(): Promise<void> {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Chrome 桥已关闭"));
    }
    this.pending.clear();
    this.queue.length = 0;
    for (const waiter of this.waiters) {
      waiter(undefined);
    }
    this.waiters.length = 0;
    if (this.server !== undefined) {
      await this.server.stop(true);
      this.server = undefined;
    }
    this.mode = undefined;
  }
}

/** JSON 响应。 */
function json(status: number, body: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extraHeaders },
  });
}

/** 扩展是浏览器源（chrome-extension://），要回 CORS 头。 */
function corsHeaders(origin: string): Record<string, string> {
  if (!origin.startsWith("chrome-extension://")) {
    return {};
  }
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-expose-headers": "x-pi-chrome-version",
    vary: "origin",
  };
}

/** 端口被占用：Bun 抛 EADDRINUSE，Node 风格的错误信息也认。 */
function isAddrInUse(error: unknown): boolean {
  const code = (error as { code?: string }).code ?? "";
  const message = (error as Error).message ?? "";
  return code === "EADDRINUSE" || /EADDRINUSE|address already in use/i.test(message);
}
