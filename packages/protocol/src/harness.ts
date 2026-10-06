import { type Static, Type } from "typebox";

export const HarnessKindSchema = Type.Union([Type.Literal("pi"), Type.Literal("claude")]);
export type HarnessKind = Static<typeof HarnessKindSchema>;
export const HARNESS_ENV = "PI_ORB_HARNESS";
