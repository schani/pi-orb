import { type Static, Type } from "typebox";

const Name = Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$" });
const SecretName = Type.String({ pattern: "^[A-Z_a-z][A-Z_a-z0-9]{0,127}$" });
export const McpConfigSchema = Type.Object(
  {
    name: Name,
    oauth: Type.Optional(
      Type.Object(
        {
          id: Type.String({
            pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
          }),
        },
        { additionalProperties: false },
      ),
    ),
    description: Type.String({ minLength: 1, maxLength: 240 }),
    url: Type.String({ maxLength: 2048, pattern: "^https://[^/@?#\\s]+(?:/[^\\s]*)?$" }),
    headers: Type.Record(
      Type.String({ pattern: "^[A-Za-z][A-Za-z0-9-]{0,63}$" }),
      Type.Union([
        Type.Object(
          { secret: SecretName, prefix: Type.Optional(Type.Literal("Bearer ")) },
          { additionalProperties: false },
        ),
        Type.Object(
          { literal: Type.String({ maxLength: 512, pattern: "^[^\\r\\n]*$" }) },
          { additionalProperties: false },
        ),
      ]),
      { maxProperties: 16 },
    ),
  },
  { additionalProperties: false },
);
export type McpConfig = Static<typeof McpConfigSchema>;
export const McpCatalogSchema = Type.Object(
  {
    revision: Type.Integer({ minimum: 0 }),
    servers: Type.Array(McpConfigSchema, { maxItems: 20 }),
  },
  { additionalProperties: false },
);
export type McpCatalog = Static<typeof McpCatalogSchema>;

/** Includes every secret-bound header, not literals or control-plane OAuth grants. */
export function mcpSecretUsers(servers: readonly McpConfig[], secret: string): string[] {
  return servers
    .filter((server) =>
      Object.values(server.headers).some(
        (binding) => "secret" in binding && binding.secret === secret,
      ),
    )
    .map((server) => server.name)
    .sort();
}
export function missingMcpSecrets(
  servers: readonly McpConfig[],
  entries: Readonly<Record<string, unknown>>,
): string[] {
  const names = new Set(
    servers.flatMap((server) =>
      Object.values(server.headers).flatMap((binding) =>
        "secret" in binding ? [binding.secret] : [],
      ),
    ),
  );
  return [...names].filter((name) => !Object.hasOwn(entries, name)).sort();
}
export const MCP_RUNTIME_PATH = "/runtime/v1/mcp";
export const McpOAuthStatusSchema = Type.Object(
  {
    status: Type.Union([
      Type.Literal("connected"),
      Type.Literal("pending"),
      Type.Literal("auth_required"),
    ]),
  },
  { additionalProperties: false },
);
export const McpOAuthErrorSchema = Type.Object(
  {
    error: Type.Object(
      {
        code: Type.Union([
          Type.Literal("not_found"),
          Type.Literal("conflict"),
          Type.Literal("unavailable"),
          Type.Literal("auth_required"),
          Type.Literal("invalid_request"),
        ]),
        message: Type.String({ maxLength: 2048 }),
        retryable: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export const McpOAuthStartSchema = Type.Object(
  { url: Type.String() },
  { additionalProperties: false },
);
export const McpOAuthGrantSchema = Type.Object(
  { accessToken: Type.String(), expiresAt: Type.Number(), generation: Type.Integer() },
  { additionalProperties: false },
);
