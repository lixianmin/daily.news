import { monotonicFactory } from "ulid";

/**
 * ULID 生成器。
 *
 * 用 `monotonicFactory` 而不是普通 `ulid()`：普通版在同一毫秒内是纯随机的，
 * 连着调两次可能后一个比前一个小。用户 id 要能当主键用、还要能按创建时间排序，
 * 所以要单调递增。
 */
const next = monotonicFactory();

/** 生成一个新的用户 id：26 位 Crockford base32，前 48 位是毫秒时间戳。 */
export function newUid(): string {
  return next();
}
