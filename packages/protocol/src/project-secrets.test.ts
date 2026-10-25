import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  PROJECT_SECRET_NAME_PATTERN,
  ProjectSecretListSchema,
  ProjectSecretSnapshotSchema,
  PutProjectSecretRequestSchema,
  projectSecretPath,
} from "./project-secrets.ts";

describe("project secrets protocol", () => {
  it("keeps browser metadata write-only and runtime snapshots closed", () => {
    expect(
      Check(ProjectSecretListSchema, {
        revision: 2,
        items: [{ name: "NPM_TOKEN", updatedAt: "2026-08-28T00:00:00.000Z" }],
      }),
    ).toBe(true);
    expect(
      Check(ProjectSecretListSchema, {
        revision: 2,
        items: [{ name: "NPM_TOKEN", updatedAt: "2026-08-28T00:00:00.000Z", value: "leak" }],
      }),
    ).toBe(false);
    for (const value of ["", "private-prefix\0suffix"]) {
      expect(Check(PutProjectSecretRequestSchema, { value })).toBe(false);
    }
    expect(
      Check(ProjectSecretSnapshotSchema, {
        revision: 2,
        values: { constructor: "secret", toString: " snow\n雪 " },
      }),
    ).toBe(true);
    for (const values of [
      { "not-a-name": "secret" },
      JSON.parse('{"__proto__":"private-value"}'),
      { TOKEN: "private-prefix\0suffix" },
    ]) {
      expect(Check(ProjectSecretSnapshotSchema, { revision: 2, values })).toBe(false);
    }
  });

  it("validates names and encodes browser paths", () => {
    const pattern = new RegExp(PROJECT_SECRET_NAME_PATTERN);
    expect(pattern.test("NPM_TOKEN")).toBe(true);
    expect(pattern.test("9TOKEN")).toBe(false);
    expect(pattern.test("NOT-A-TOKEN")).toBe(false);
    expect(projectSecretPath("project id", "NPM_TOKEN")).toBe(
      "/api/v1/projects/project%20id/secrets/NPM_TOKEN",
    );
  });
});
