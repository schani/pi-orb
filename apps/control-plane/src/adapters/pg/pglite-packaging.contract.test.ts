import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = join(import.meta.dirname, "../../../../..");
const wrapper = dirname(fileURLToPath(import.meta.resolve("@electric-sql/pglite-pg_textsearch")));
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

it("pins the PGlite engine to the wrapper's exact peer", () => {
  const dependencies = json(join(root, "apps/control-plane/package.json")).dependencies;
  const packages = json(join(root, "package-lock.json")).packages;
  expect(dependencies["@electric-sql/pglite"]).toBe("0.5.12");
  expect(dependencies["@electric-sql/pglite-pg_textsearch"]).toBe("0.0.14");
  expect(json(join(wrapper, "../package.json")).version).toBe("0.0.14");
  expect(json(join(root, "node_modules/@electric-sql/pglite/package.json")).version).toBe("0.5.12");
  expect(packages["apps/control-plane"].dependencies).toEqual(dependencies);
  expect(packages["node_modules/@electric-sql/pglite"].version).toBe("0.5.12");
  expect(packages["node_modules/@electric-sql/pglite-pg_textsearch"].version).toBe("0.0.14");
  expect(json(join(wrapper, "../package.json")).peerDependencies).toEqual({
    "@electric-sql/pglite": "0.5.12",
  });
});

it("preserves the 0.0.13 runtime wrapper JS and extracted 1.5.1 extension payload", () => {
  expect(sha256(readFileSync(join(wrapper, "index.js")))).toBe(
    "1462a8323f7180a6e5dbbdb49caf9f66440f95cfce825ea9d722a4393f432a13",
  );
  expect(sha256(readFileSync(join(wrapper, "index.cjs")))).toBe(
    "2ebc335ec715a6596437ae955c51f0d3141f9ed984096fdd384e0bfc61c1091a",
  );
  const archive = join(wrapper, "pg_textsearch.tar.gz");
  const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter((entry) => !entry.endsWith("/"))
    .sort();
  const payload = createHash("sha256");
  for (const entry of entries) {
    payload.update(entry);
    payload.update(execFileSync("tar", ["-xzOf", archive, entry]));
  }
  expect(entries).toHaveLength(25);
  expect(payload.digest("hex")).toBe(
    "aa255a217445c36f8b53e9953a2a615f18480b88e129f256d313d04197acf548",
  );
  expect(sha256(execFileSync("tar", ["-xzOf", archive, "lib/postgresql/pg_textsearch.so"]))).toBe(
    "9488d624f1e83ad0658ab1ce675fae942053a1cc4090c14f79b4e3e0b6ee12e7",
  );
});
