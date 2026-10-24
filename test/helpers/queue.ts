import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 测试用队列文件路径。
 *
 * bunqueue 的内嵌模式是「每进程一个 manager」，第一次用哪个 dataPath 就一直是哪个，
 * 所以整个测试进程只能有一个路径。所有碰队列的测试文件都用它。
 */
export const TEST_QUEUE_PATH = join(tmpdir(), "daily-news-test-jobs.db");

/** 队列名。与 src/scheduler.ts 保持一致。 */
export const TEST_QUEUE_NAME = "daily-news";

/** 等某个条件成立，最多等 timeoutMs 毫秒。 */
export async function waitFor(
  condition: () => boolean,
  timeoutMs = 3000,
  stepMs = 20,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return condition();
}
