import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const semver = createRequire(import.meta.url)("semver") as {
  satisfies(version: string, range: string, options?: { includePrerelease: boolean }): boolean;
};
const root = join(import.meta.dirname, "../../..");
type Entry = { version?: string; dependencies?: Record<string, string> };
type Lock = { packages: Record<string, Entry> };
const json = (path: string): Lock => JSON.parse(readFileSync(join(root, path), "utf8")) as Lock;
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  overrides?: Record<string, Record<string, string>>;
};

function resolved(
  packages: Record<string, Entry>,
  location: string,
  dependency: string,
): Entry | undefined {
  let cursor = location;
  while (true) {
    const candidate = `${cursor ? `${cursor}/` : ""}node_modules/${dependency}`;
    if (packages[candidate]) return packages[candidate];
    const parent = cursor.lastIndexOf("/node_modules/");
    if (parent < 0) return packages[`node_modules/${dependency}`];
    cursor = cursor.slice(0, parent);
  }
}

function checkGraph(lock: Lock): string[] {
  const failures: string[] = [];
  for (const [location, entry] of Object.entries(lock.packages)) {
    for (const [name, declaredRange] of Object.entries(entry.dependencies ?? {})) {
      const owner = location.slice(location.lastIndexOf("node_modules/") + "node_modules/".length);
      const range = manifest.overrides?.[`${owner}@${entry.version}`]?.[name] ?? declaredRange;
      if (range.startsWith("file:") || (range === "*" && name.startsWith("@pi-orb/"))) continue;
      const versionRange = range.startsWith("npm:")
        ? range.slice(range.lastIndexOf("@") + 1)
        : range;
      const actual = resolved(lock.packages, location, name);
      if (
        !actual?.version ||
        !semver.satisfies(actual.version, versionRange, { includePrerelease: true })
      ) {
        failures.push(
          `${location || "root"}: ${name}@${range} resolves to ${actual?.version ?? "missing"}`,
        );
      }
    }
  }
  return failures;
}

describe("Pi package dependency contracts", () => {
  it("resolves the root lock dependency graph", () => {
    expect(checkGraph(json("package-lock.json"))).toEqual([]);
  });

  it("installs a proxy version satisfying installed Pi AI's actual manifest", () => {
    const piAiPath = join(root, "node_modules/@earendil-works/pi-ai");
    const fromPiAi = createRequire(join(piAiPath, "package.json"));
    const manifest = JSON.parse(readFileSync(join(piAiPath, "package.json"), "utf8")) as Entry;
    const proxy = JSON.parse(
      readFileSync(join(dirname(fromPiAi.resolve("http-proxy-agent")), "../package.json"), "utf8"),
    ) as Entry;
    const version = proxy.version;
    const range = manifest.dependencies?.["http-proxy-agent"];
    assert.ok(version && range);
    expect(semver.satisfies(version, range)).toBe(true);
  });

  it("locks the installed Pi AI published manifest", () => {
    const piAi = "node_modules/@earendil-works/pi-ai";
    const manifest = JSON.parse(readFileSync(join(root, piAi, "package.json"), "utf8")) as Entry;
    const locked = json("package-lock.json").packages[piAi];
    assert.ok(locked);
    expect(manifest.dependencies).toEqual(locked.dependencies);
    expect(checkGraph(json("package-lock.json"))).not.toContain(
      `${piAi}: http-proxy-agent@${manifest.dependencies?.["http-proxy-agent"]} resolves to 7.0.2`,
    );
  });

  it("rejects a stale installed Pi AI proxy pin even when the top-level Pi AI remains valid", () => {
    const lock = structuredClone(json("package-lock.json"));
    const location = "node_modules/@earendil-works/pi-ai";
    const pin = `${location}/node_modules/http-proxy-agent`;
    lock.packages[pin] = { version: "7.0.2" };
    expect(checkGraph(lock)).toContain(`${location}: http-proxy-agent@9.1.0 resolves to 7.0.2`);
  });
});
