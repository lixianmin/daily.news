// 手写，勿改 schema 而不改 RegenBody：needle 示例里这一步由 scripts/gen-models.ts
// 生成，本仓没有那个脚本（只有一个 bean），所以两份一起改。漂移断言会在 tsc 报错。
import { Type, type Static } from "@sinclair/typebox";
import { registerModel } from "@needle/honox";
import type { RegenBody } from "./regen.ts";

export const RegenBodySchema = Type.Object(
  {
    date: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

// 漂移断言：class 改了没同步这里，tsc 会在这里报错。
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
export type _RegenBodyInSync = Assert<Equals<Static<typeof RegenBodySchema>, RegenBody>>;

// 按类名注册，路由那边 modelSchema(RegenBody) 查得到。
registerModel("RegenBody", RegenBodySchema);
