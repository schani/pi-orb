import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";

function productionComponents(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return productionComponents(path);
    return extname(path) === ".tsx" && !path.endsWith(".test.tsx") ? [path] : [];
  });
}

describe("production text fields", () => {
  it("does not use visible placeholders", () => {
    const sourceRoot = import.meta.dirname;
    const offenders = productionComponents(sourceRoot).filter((path) =>
      /\bplaceholder\s*=/.test(readFileSync(path, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
