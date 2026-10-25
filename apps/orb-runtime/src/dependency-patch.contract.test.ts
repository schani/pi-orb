import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "../../..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");
const json = (
  path: string,
): {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
} =>
  JSON.parse(read(path)) as {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

const piVersion = "1.4.0";
const helperPath = "scripts/apply-dependency-patches.mjs";

describe("Pi dependency patch installation", () => {
  it("uses Iron's bundled declarations", () => {
    expect(
      json("apps/control-plane/package.json").devDependencies?.["@types/hapi__iron"],
    ).toBeUndefined();
    const lock = JSON.parse(read("package-lock.json")) as { packages: Record<string, unknown> };
    expect(lock.packages["node_modules/@types/hapi__iron"]).toBeUndefined();
  });

  it("pins the central model runtime SDK", () => {
    expect(
      json("apps/control-plane/package.json").dependencies?.["@earendil-works/pi-coding-agent"],
    ).toBe(piVersion);
    expect(
      json("apps/orb-runtime/package.json").dependencies?.["@earendil-works/pi-coding-agent"],
    ).toBeUndefined();
  });

  it("removes the vulnerable patch tooling from the root lock graph", () => {
    for (const path of ["package-lock.json"]) {
      const lock = JSON.parse(read(path)) as { packages: Record<string, unknown> };
      for (const name of ["patch-package", "find-yarn-workspace-root", "micromatch", "braces"]) {
        expect(
          Object.keys(lock.packages).filter(
            (key) => key.endsWith(`/node_modules/${name}`) || key === `node_modules/${name}`,
          ),
        ).toEqual([]);
      }
    }
  });

  it("installs the SDK's pinned patched brace expansion", () => {
    const fromPi = createRequire(
      join(root, "node_modules/@earendil-works/pi-coding-agent/package.json"),
    );
    const installed = JSON.parse(
      readFileSync(fromPi.resolve("brace-expansion/package.json"), "utf8"),
    ) as { version: string };
    expect(installed.version).toBe("5.0.12");
  });

  it("keeps coding-agent and OAuth cancellation on pristine upstream contracts", () => {
    expect(
      existsSync(join(root, `patches/@earendil-works+pi-coding-agent+${piVersion}.patch`)),
    ).toBe(false);
    for (const [path, expected] of [
      [
        "node_modules/@earendil-works/pi-ai/dist/auth/resolve.js",
        "3fcec09018831324d9c7fb02f4aea707e8a9e4fec5a2bdf1b3d84d716fd3091e",
      ],
      [
        "node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.js",
        "44d8017928eff6721d5a56b4e71f98bcafb124f5aa6e7d3f016491e11fcf6461",
      ],
      [
        "node_modules/@earendil-works/pi-coding-agent/dist/core/provider-composer.d.ts",
        "8b6c292d4e346cb2a45186f2b3784102aa9fa5b5bd2096ef6ec4bbb235ddb504",
      ],
    ] as const)
      expect(createHash("sha256").update(read(path)).digest("hex")).toBe(expected);
    const resolve = read("node_modules/@earendil-works/pi-ai/dist/auth/resolve.js");
    expect(resolve).toContain(
      "oauth.refresh(current, AbortSignal.timeout(DEFAULT_OAUTH_REFRESH_TIMEOUT_MS))",
    );
    expect(resolve).not.toContain("AbortSignal.any([signal");
    expect(
      read("node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.js"),
    ).not.toContain("getRequestDiagnostics");
    expect(read(helperPath)).not.toContain(
      'package: "node_modules/@earendil-works/pi-coding-agent"',
    );
    expect(read("apps/control-plane/Dockerfile")).not.toContain("pi-coding-agent+1.4.0.patch");
  });

  it("keeps native Durable journals, namespace discovery and previews on the public contract", () => {
    const base = "node_modules/@earendil-works/pi-durable/dist/codemode/";
    for (const barrel of ["index.js", "index.d.ts"]) {
      expect(read(`${base}${barrel}`)).toContain("CodemodeRunDoc, CodemodeJournalDoc,");
    }
    const native = read(`${base}codemode.js`);
    expect(native).toContain("const namespaces = (this.options.namespaces ?? []).map(");
    expect(native).toContain('namespace.name.split("__").at(-1) === query');
    expect(native).toContain(
      'toCodemodeIdentifier(namespace.name).split("__").at(-1) === toCodemodeIdentifier(query)',
    );
    expect(native).toContain("Object.keys(value).slice(0, 16)");
    expect(native).toContain(": typeof value).slice(0, 256)");
    expect(native).toContain(
      'const args = call.args === undefined ? "" : argumentPreview(call.args);',
    );
    expect(native).toContain("return `tools.${made.name}(${argumentPreview(made.arguments)})`;");
    expect(native).toContain("${call.name}(${argumentPreview(call.args)})`");
    expect(native).not.toContain("JSON.stringify(call.args)");
    expect(native).not.toContain("JSON.stringify(made.arguments)");
    // Display sanitization must not change native execution, journal or replay equality.
    expect(native).toContain("sameJson(made.arguments, call.args ?? {})");
    expect(native).toContain("const args = (call.args === undefined ? {} : call.args);");
    expect(native).not.toContain("const args = (call.args ?? {});");
    expect(native).toContain("executeTool(call.name, args, this.context, { key: `c${call.id}` })");
    expect(native).toContain("{ args: call.args }");
    expect(native).toContain("tx.doc(CodemodeRunDoc, api.taskId)");
    expect(native).toContain("tx.doc(CodemodeJournalDoc, api.taskId)");
  });

  it("configures failed-run continuation through the native Harness setting", () => {
    const adapter = read("apps/control-plane/src/adapters/durable/agent.ts");
    expect(
      adapter
        .slice(adapter.indexOf("harness = await Harness.open("))
        .match(/settings: \{[^}]*\}/)?.[0],
    ).toContain('afterFailedRun: "continue"');
    const patch = read("patches/@earendil-works+pi-durable+1.4.0.patch");
    expect(patch).not.toContain("dist/harness/generation.js");
    const native = read("node_modules/@earendil-works/pi-durable/dist/harness/generation.js");
    expect(createHash("sha256").update(native).digest("hex")).toBe(
      "b7b8c610e23f100edd9cde336c28f70ae8c82f6e988f4b4564e1a732a2e1b531",
    );
    expect(native).toContain("const policy = settings.afterFailedRun;");
    expect(native).not.toContain('prepareFailure(tx, runtime, "continue")');
  });

  it("decodes native image saves with a bounded portable byte loop", () => {
    const source = read("node_modules/@earendil-works/pi-durable/dist/codemode/output.js");
    const body = source.match(
      / {8}const binary = atob\(data\);\n {8}const bytes = new Uint8Array\(binary.length\);\n {8}for \(let i = 0; i < binary.length; i\+\+\)\n {12}bytes\[i\] = binary.charCodeAt\(i\);/,
    )?.[0];
    expect(body).toBeDefined();
    expect(source).not.toContain("Uint8Array.from(atob(data)");
    const decode = runInNewContext("(data) => {" + body + "; return bytes;}", {
      atob,
      Uint8Array,
    }) as (data: string) => Uint8Array;
    for (const length of [0, 1, 2, 3, 255, 256, 257, 258]) {
      const expected = Buffer.alloc(length);
      for (let i = 0; i < length; i++) expected[i] = i % 256;
      const data = expected.toString("base64");
      const bytes = decode(data);
      expect(bytes.byteLength).toBe(expected.byteLength);
      expect(Buffer.from(bytes).equals(expected)).toBe(true);
      expect(data).toBe(expected.toString("base64"));
    }
  });

  it("bounds native display previews to keys without exposing argument values", () => {
    const native = read("node_modules/@earendil-works/pi-durable/dist/codemode/codemode.js");
    const helper = native.match(/function argumentPreview\(value\) \{[\s\S]*?\n\}/)?.[0];
    expect(helper).toBeDefined();
    const preview = runInNewContext(`(${helper})`) as (value: unknown) => string;
    expect(preview({ token: "PREVIEW_CANARY", nested: { password: "PREVIEW_CANARY" } })).toBe(
      '["token","nested"]',
    );
    expect(preview("PREVIEW_CANARY")).toBe('"string"');
    expect(preview(null)).toBe('"object"');
    expect(preview(undefined)).toBe('"undefined"');
    const many = Object.fromEntries(
      Array.from({ length: 17 }, (_, index) => [`key${index}`, "PREVIEW_CANARY"]),
    );
    expect(JSON.parse(preview(many))).toHaveLength(16);
    const long = { ["k".repeat(300)]: "PREVIEW_CANARY" };
    expect(preview(long)).toHaveLength(256);
    expect(preview(long)).not.toContain("PREVIEW_CANARY");
  });

  it("retains CPU checkpoints for both execute and deterministic start workers", () => {
    const base = "node_modules/@earendil-works/pi-codemode/dist/";
    expect(read(`${base}types.d.ts`)).toContain("workerData?: unknown;");
    expect(read(`${base}runtime/host.js`)).toContain("extension: options.workerData");
    const worker = read(`${base}runtime/worker.js`);
    expect(worker).toContain(
      "shouldInterrupt: () => data.checkpoint?.() || Atomics.load(interrupt, 0) !== 0",
    );
    const vm = read(`${base}runtime/vm.js`);
    expect(vm).toContain("interruptHandler: options.shouldInterrupt");
    expect(vm).toContain("options.shouldInterrupt()");
    expect(vm).toContain("wasi: clock ? deterministicWasi(clock) : discardOutput");
    const execution = read(`${base}runtime/execution.js`);
    expect(execution).toContain("start(code, options)");
    expect(execution).toContain("deterministic:");
  });

  it("applies exactly the installed patches during root and container installs", () => {
    expect(json("package.json").scripts?.postinstall).toBe(
      `node ${helperPath} && node scripts/fix-node-pty-prebuild-permissions.mjs`,
    );

    const patchFiles = [
      "@earendil-works+pi-ai+1.4.0.patch",
      "@earendil-works+pi-codemode+1.4.0.patch",
      "@earendil-works+pi-durable+1.4.0.patch",
    ];
    expect(
      readdirSync(join(root, "patches"))
        .filter((name) => name.endsWith(".patch"))
        .sort(),
    ).toEqual(patchFiles.toSorted());
    const controlPlane = read("apps/control-plane/Dockerfile");
    const install = controlPlane.indexOf("npm ci --workspace @pi-orb/control-plane");
    expect(install).toBeGreaterThan(-1);
    for (const source of [helperPath, ...patchFiles.map((patch) => `patches/${patch}`)]) {
      const copy = controlPlane.indexOf(`COPY ${source} ${source}`);
      expect(copy).toBeGreaterThan(-1);
      expect(copy).toBeLessThan(install);
    }
    expect(controlPlane.indexOf(`node ${helperPath}`, install)).toBeGreaterThan(install);
    expect(controlPlane).toContain("COPY patches/pi-codemode.* patches/");
    const runtime = read("apps/orb-runtime/Dockerfile");
    expect(runtime).not.toContain(helperPath);
    expect(runtime).not.toContain("COPY patches");
  });

  it("uses unmodified dependencies in the native execution image", () => {
    const snapshot = read("packages/native-image/src/snapshot.ts");
    expect(snapshot).not.toContain('"patches"');
    expect(snapshot).not.toContain('"vendor"');
    expect(snapshot).not.toContain(`"${helperPath}"`);
    expect(read("infra/native-vm/install.sh")).not.toContain(helperPath);
  });
});
