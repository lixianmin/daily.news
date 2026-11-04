import { describe, expect, it } from "bun:test";
import { createDisplayControl, type CommandRunner } from "../src/display.ts";

/** 记录调用参数，不真的执行系统命令。 */
function recorder(result?: { ok: boolean; code: number; stderr: string }) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const run: CommandRunner = async (command, args) => {
    calls.push({ command, args });
    return result ?? { ok: true, code: 0, stderr: "" };
  };
  return { calls, run };
}

describe("显示器控制", () => {
  it("关闭屏幕走 pmset displaysleepnow", async () => {
    const { calls, run } = recorder();
    const display = createDisplayControl(run);

    const result = await display.sleepDisplay();

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("/usr/bin/pmset");
    expect(calls[0]?.args).toEqual(["displaysleepnow"]);
  });

  it("唤醒屏幕走 caffeinate -u -t 1", async () => {
    const { calls, run } = recorder();
    const display = createDisplayControl(run);

    const result = await display.wakeDisplay();

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("/usr/bin/caffeinate");
    expect(calls[0]?.args).toEqual(["-u", "-t", "1"]);
  });

  it("退出码非 0 时返回失败，不抛异常", async () => {
    const { run } = recorder({ ok: false, code: 1, stderr: "boom" });
    const display = createDisplayControl(run);

    const result = await display.sleepDisplay();

    expect(result.ok).toBe(false);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("boom");
  });

  it("执行器抛异常时也返回失败", async () => {
    const run: CommandRunner = async () => {
      throw new Error("spawn failed");
    };
    const display = createDisplayControl(run);

    const result = await display.wakeDisplay();

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("spawn failed");
  });
});
