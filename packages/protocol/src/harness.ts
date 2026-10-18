import { type Static, Type } from "typebox";

export const HarnessKindSchema = Type.Union([Type.Literal("pi"), Type.Literal("claude")]);
export type HarnessKind = Static<typeof HarnessKindSchema>;
