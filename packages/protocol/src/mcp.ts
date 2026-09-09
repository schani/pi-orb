import { type Static, Type } from "typebox";

const Name = Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$" });
const SecretName = Type.String({ pattern: "^[A-Z_a-z][A-Z_a-z0-9]{0,127}$" });
export const McpConfigSchema = Type.Object(
  {
    name: Name,
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
export const MCP_RUNTIME_PATH = "/runtime/v1/mcp";
