/**
 * 显示器电源控制：只管屏幕，不管主机睡不睡。
 *
 * 「关闭屏幕」= 显示器休眠，主机照跑：`pmset displaysleepnow`。
 * 「唤醒屏幕」= 模拟一次用户活动，把显示器从 display sleep 拉回来：
 * `caffeinate -u -t 1`（`-u` 是一次用户活动断言，`-t 1` 让它只维持 1 秒）。
 *
 * 两条命令都是固定命令 + 固定参数，不接受外部输入，也不经 shell 解析，
 * 所以没有命令注入面。
 */

/** 一条命令的执行结果。 */
export interface CommandResult {
  ok: boolean;
  /** 退出码。执行器自己抛异常时是 -1。 */
  code: number;
  /** stderr 内容（已去首尾空白）。 */
  stderr: string;
}

/** 执行一条固定命令。参数是 argv 数组，不经 shell 解析。 */
export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;

/**
 * 显示器控制。
 *
 * 接口存在是为了测试能注入假实现——真实现会真的把用户的屏幕关掉。
 */
export interface DisplayControl {
  /** 让显示器休眠（主机不睡）。 */
  sleepDisplay(): Promise<CommandResult>;
  /** 把显示器从休眠里拉回来。 */
  wakeDisplay(): Promise<CommandResult>;
}

/** 关闭屏幕。绝对路径：launchd 起的服务 PATH 很短，不靠 PATH 找。 */
const SLEEP_COMMAND = "/usr/bin/pmset";
const SLEEP_ARGS = ["displaysleepnow"];

/** 唤醒屏幕。 */
const WAKE_COMMAND = "/usr/bin/caffeinate";
const WAKE_ARGS = ["-u", "-t", "1"];

/** 默认执行器：Bun.spawn，不走 shell。 */
export const runCommand: CommandRunner = async (command, args) => {
  const proc = Bun.spawn([command, ...args], { stdout: "ignore", stderr: "pipe" });
  // stderr 声明为 `ReadableStream | number | undefined`（number 是传 fd 的情形）。
  // 这里只传了 "pipe"，所以实际一定是流；用守卫而不是断言，免得 lie 给类型系统。
  const stderrStream = proc.stderr;
  const stderr =
    stderrStream instanceof ReadableStream ? await new Response(stderrStream).text() : "";
  const code = await proc.exited;
  return { ok: code === 0, code, stderr: stderr.trim() };
};

/**
 * 建显示器控制。
 *
 * 执行器抛异常（命令不存在、权限不够）也收敛成 `ok:false`：
 * 调用方（HTTP 层）只处理一种失败形状，不用再兜一层 try/catch。
 */
export function createDisplayControl(run: CommandRunner = runCommand): DisplayControl {
  const call = async (command: string, args: string[]): Promise<CommandResult> => {
    try {
      return await run(command, args);
    } catch (error) {
      return { ok: false, code: -1, stderr: String(error) };
    }
  };

  return {
    sleepDisplay: () => call(SLEEP_COMMAND, SLEEP_ARGS),
    wakeDisplay: () => call(WAKE_COMMAND, WAKE_ARGS),
  };
}
