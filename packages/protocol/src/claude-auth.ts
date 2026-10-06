import { type Static, Type } from "typebox";

export const ClaudeAuthViewSchema = Type.Object(
  {
    status: Type.Union([
      Type.Literal("disconnected"),
      Type.Literal("connecting"),
      Type.Literal("connected"),
      Type.Literal("failed"),
    ]),
    challenge: Type.Optional(
      Type.Object(
        { url: Type.Optional(Type.String()), needsCode: Type.Optional(Type.Boolean()) },
        { additionalProperties: false },
      ),
    ),
    generation: Type.Optional(Type.Integer({ minimum: 1 })),
    error: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const CLAUDE_AUTH_PATH = "/api/v1/claude/auth";
export const runtimeClaudeSubscriptionPath = "/runtime/v1/claude-subscription";
export type ClaudeAuthView = Static<typeof ClaudeAuthViewSchema>;
export interface ClaudeSubscriptionGrant {
  readonly token: string;
  readonly generation: number;
}
