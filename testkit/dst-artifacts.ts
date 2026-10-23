import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { vi } from "vitest";

/** Own expected failure traces; retain the fixture if any assertion fails. */
export async function withDstArtifacts(check: (directory: string) => Promise<void>): Promise<void> {
  const parent = join(process.cwd(), "test-failures");
  mkdirSync(parent, { recursive: true });
  const fixture = mkdtempSync(join(parent, "selftest-"));
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(fixture);
  try {
    await check(join(fixture, "test-failures"));
  } finally {
    cwd.mockRestore();
  }
  rmSync(fixture, { recursive: true });
}
