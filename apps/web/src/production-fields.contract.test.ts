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

function productionSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return productionSources(path);
    const isSource = extname(path) === ".ts" || extname(path) === ".tsx";
    return isSource && !/\.test\.tsx?$/.test(path) ? [path] : [];
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

  it("frames every visible native text field", () => {
    const offenders = productionComponents(import.meta.dirname).flatMap((path) => {
      const source = readFileSync(path, "utf8").replace(
        /<TextFieldFrame\b[\s\S]*?<\/TextFieldFrame>/g,
        "",
      );
      const controls = source.match(/<(?:input|textarea)\b[^>]*>/g) ?? [];
      return controls.filter((control) => !/\btype=["']file["']/.test(control)).map(() => path);
    });
    expect(offenders).toEqual([]);
  });

  it("insets crop marks only for the two full-bleed instruction editors", () => {
    const insetFrames = productionComponents(import.meta.dirname).flatMap((path) => {
      const source = readFileSync(path, "utf8");
      return [...source.matchAll(/<TextFieldFrame className="text-field-frame-inset">/g)].map(() =>
        path.slice(import.meta.dirname.length + 1),
      );
    });
    expect(insetFrames).toEqual([
      "components/PersonalInstructions.tsx",
      "components/ProjectInstructions.tsx",
    ]);
  });

  /** Clients read typed record fields; only the Pi adapter knows native shapes. */
  it("does not read the native overflow blob", () => {
    const offenders = productionSources(import.meta.dirname).filter((path) =>
      /overflow\s*(\?\.)?\s*\[\s*["']native["']\s*\]|overflow\s*\??\.\s*native/.test(
        readFileSync(path, "utf8"),
      ),
    );
    expect(offenders).toEqual([]);
  });
});
