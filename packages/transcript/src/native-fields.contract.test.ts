import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { expect, it } from "vitest";

function productionSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return productionSources(path);
    return extname(path) === ".ts" && !path.endsWith(".test.ts") ? [path] : [];
  });
}

/** The model reads typed record fields; only the Pi adapter knows native shapes. */
it("does not read the native overflow blob", () => {
  const offenders = productionSources(import.meta.dirname).filter((path) =>
    /overflow\s*(\?\.)?\s*\[\s*["']native["']\s*\]|overflow\s*\??\.\s*native/.test(
      readFileSync(path, "utf8"),
    ),
  );
  expect(offenders).toEqual([]);
});
