import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const lock = JSON.parse(
  readFileSync(new URL("../../../../package-lock.json", import.meta.url), "utf8"),
) as {
  packages: Record<string, { version?: string }>;
};

it.each([
  ["fastify", "5.12.8"],
  ["find-my-way", "9.10.0"],
  ["@fastify/static", "11.0.0"],
  ["@fastify/websocket", "11.3.7"],
  ["ws", "8.23.0"],
  ["openid-client", "6.9.1"],
  ["tldts", "7.6.1"],
  ["tldts-core", "7.6.1"],
])("locks every %s consumer to the qualified version", (name, version) => {
  const copies = Object.entries(lock.packages).filter(([path]) =>
    path.endsWith(`node_modules/${name}`),
  );
  expect(copies.length).toBeGreaterThan(0);
  for (const [path, pkg] of copies) expect(pkg.version, path).toBe(version);
});

it("updates Google auth 11 without replacing legacy provider auth 10", () => {
  expect(lock.packages["apps/control-plane/node_modules/google-auth-library"]?.version).toBe(
    "11.3.4",
  );
  expect(lock.packages["node_modules/google-auth-library"]?.version).toBe("10.5.0");
});

it("removes affected glob/minimatch copies and locks Pi and Chord to 1.5.2", () => {
  for (const [path, pkg] of Object.entries(lock.packages)) {
    if (/node_modules\/(?:glob|minimatch)$/.test(path)) {
      expect(path.endsWith("/glob") ? ["14.0.6"] : ["11.0.3", "11.0.9"]).toContain(pkg.version);
    }
    if (/^node_modules\/@earendil-works\/(?:pi-[^/]+|chord)$/.test(path)) {
      expect(pkg.version, path).toBe("1.5.2");
    }
  }
});
