import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { ProjectMcpStatusSchema } from "./mcp.ts";

it("allows only project-scoped sanitized health with closed diagnostics", () => {
  const row = { name: "fixture", status: "available" };
  const response = { revision: 4, servers: [row] };
  expect(Check(ProjectMcpStatusSchema, response)).toBe(true);
  for (const status of ["unavailable", "needs-auth", "unknown"])
    expect(
      Check(ProjectMcpStatusSchema, {
        ...response,
        servers: [{ ...row, status, diagnostic: "connection_failed" }],
      }),
    ).toBe(true);
  for (const extra of [
    { url: "https://private.example" },
    { headers: { Authorization: "PRIVATE" } },
    { message: "PRIVATE_REMOTE_ERROR" },
    { diagnostic: "PRIVATE_REMOTE_ERROR" },
    { observations: [] },
    { status: "pending" },
  ])
    expect(
      Check(ProjectMcpStatusSchema, {
        ...response,
        servers: [{ ...row, ...extra }],
      }),
    ).toBe(false);
  expect(Check(ProjectMcpStatusSchema, { ...response, bootRevision: 4 })).toBe(false);
});
