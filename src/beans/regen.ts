// schema 注册（生成物）。它只 import 本文件的类型，运行时无环：
// 谁 import 这个 bean 文件，谁就顺带把 schema 注册好了，不需要额外的 barrel。
import "./regen.generated.ts";

/**
 * `POST /api/regenerate` 的 body。
 *
 * `date` 省略 = 今天（东八区）。日期形状（`YYYY-MM-DD`）不在这里校验：
 * schema 只负责「是不是字符串」，业务判定在 `api/regen.ts` 里。
 */
export class RegenBody {
  date?: string;
}
