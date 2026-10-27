import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { type ExecutionEnv, FileError } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { OwnerSkillsSnapshot } from "@pi-orb/protocol";
import { expect, it } from "vitest";
import { ownerSkillBundle } from "./owner-skill-bundle.ts";
import { installOwnerSkills } from "./owner-skill-delivery.ts";

export const adoptedSkills: OwnerSkillsSnapshot["skills"] = [
  {
    name: "images",
    content: "---\nname: images\ndescription: images\n---\n",
    source: { url: "https://github.com/o/r/tree/main/skill", commitSha: "a".repeat(40) },
    files: [
      {
        path: "assets/a.png",
        base64: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]).toString("base64"),
        executable: false,
      },
      {
        path: "scripts/run.sh",
        base64: Buffer.from("#!/bin/sh\nprintf imported").toString("base64"),
        executable: true,
      },
    ],
  },
];

it("hashes names, root content, sorted paths, bytes and executable bits, not source metadata", () => {
  const a = ownerSkillBundle(adoptedSkills)._unsafeUnwrap();
  expect(
    ownerSkillBundle([
      { ...adoptedSkills[0]!, files: [...adoptedSkills[0]!.files].reverse(), source: null },
    ])._unsafeUnwrap().hash,
  ).toBe(a.hash);
  for (const change of [
    { name: "other" },
    { content: "changed" },
    { files: [{ ...adoptedSkills[0]!.files[0]!, executable: true }] },
    { files: [{ ...adoptedSkills[0]!.files[0]!, base64: "AA==" }] },
  ])
    expect(ownerSkillBundle([{ ...adoptedSkills[0]!, ...change }])._unsafeUnwrap().hash).not.toBe(
      a.hash,
    );
  expect(a.root).toBe(`../.pi-orb/owner-skills/${a.hash}`);
});

it("rejects escaping, conflicting and duplicate captured paths before file operations", () => {
  for (const path of ["../x", "/x", "a/../b", "SKILL.md", "scripts/run.sh"]) {
    expect(
      ownerSkillBundle([
        {
          ...adoptedSkills[0]!,
          files: [...adoptedSkills[0]!.files, { path, base64: "", executable: false }],
        },
      ]).isErr(),
    ).toBe(true);
  }
});

it("installs identical adopted bytes/modes; verifies and refuses corruption; isolates process contexts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "owner-delivery-"));
  const env = new NodeExecutionEnv({ cwd: dir });
  const first = ownerSkillBundle(adoptedSkills, dir)._unsafeUnwrap();
  const latest = ownerSkillBundle(
    [{ ...adoptedSkills[0]!, content: "new settings" }],
    dir,
  )._unsafeUnwrap();
  try {
    expect((await installOwnerSkills(env, first, BACKGROUND_CONTEXT))._unsafeUnwrap()).toBe(
      "installed",
    );
    for (const f of first.files) {
      expect(readFileSync(f.path)).toEqual(Buffer.from(f.bytes));
      expect(statSync(f.path).mode & 0o777).toBe(f.executable ? 0o700 : 0o600);
    }
    expect((await installOwnerSkills(env, first, BACKGROUND_CONTEXT))._unsafeUnwrap()).toBe(
      "verified",
    );
    writeFileSync(first.files[0]!.path, "corrupt");
    expect((await installOwnerSkills(env, first, BACKGROUND_CONTEXT)).isErr()).toBe(true);
    expect(readFileSync(first.files[0]!.path, "utf8")).toBe("corrupt");
    rmSync(first.root, { recursive: true });
    expect((await installOwnerSkills(env, first, BACKGROUND_CONTEXT))._unsafeUnwrap()).toBe(
      "installed",
    );
    expect((await installOwnerSkills(env, latest, BACKGROUND_CONTEXT)).isOk()).toBe(true);
    expect(readFileSync(first.files[0]!.path)).toEqual(Buffer.from(first.files[0]!.bytes));
    // A replacement binds the captured first snapshot, never latest owner settings.
    rmSync(first.root, { recursive: true });
    expect((await installOwnerSkills(env, first, BACKGROUND_CONTEXT))._unsafeUnwrap()).toBe(
      "installed",
    );
    expect(readFileSync(first.files[0]!.path)).toEqual(Buffer.from(first.files[0]!.bytes));
  } finally {
    await env.cleanup(BACKGROUND_CONTEXT);
    rmSync(dir, { recursive: true, force: true });
  }
});

it("returns a visible typed failure instead of admitting tools with a missing installation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "owner-delivery-denied-"));
  const env = new NodeExecutionEnv({ cwd: dir });
  env.writeFile = async () => ({ ok: false, error: new FileError("permission_denied", "denied") });
  try {
    const result = await installOwnerSkills(
      env,
      ownerSkillBundle(adoptedSkills, dir)._unsafeUnwrap(),
      BACKGROUND_CONTEXT,
    );
    expect(result.isErr() && result.error).toMatchObject({
      type: "resource_error",
      message: expect.stringContaining("Cannot install owner skills at "),
    });
  } finally {
    await env.cleanup(BACKGROUND_CONTEXT);
    rmSync(dir, { recursive: true, force: true });
  }
});

it("refuses symlink installation parents without touching their target", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "owner-parent-"));
  const dir = join(workspace, "repo");
  mkdirSync(dir);
  const target = mkdtempSync(join(tmpdir(), "owner-outside-"));
  const env = new NodeExecutionEnv({ cwd: dir });
  try {
    symlinkSync(target, join(workspace, ".pi-orb"));
    const result = await installOwnerSkills(
      env,
      ownerSkillBundle(adoptedSkills)._unsafeUnwrap(),
      BACKGROUND_CONTEXT,
    );
    expect(result.isErr()).toBe(true);
    expect(statSync(target).isDirectory()).toBe(true);
    expect(
      (await env.listDir(target, BACKGROUND_CONTEXT)).ok &&
        (await env.listDir(target, BACKGROUND_CONTEXT)),
    ).toMatchObject({ value: [] });
  } finally {
    await env.cleanup(BACKGROUND_CONTEXT);
    rmSync(workspace, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

it("validates a large binary support file without recursive regex stack exhaustion", () => {
  const base64 = Buffer.alloc(8 * 1024 * 1024 - 1024, 255).toString("base64");
  expect(
    ownerSkillBundle([
      { ...adoptedSkills[0]!, files: [{ path: "large.bin", base64, executable: false }] },
    ]).isOk(),
  ).toBe(true);
});

it("reports failed staging cleanup instead of returning success", async () => {
  const dir = mkdtempSync(join(tmpdir(), "owner-cleanup-"));
  const env = new NodeExecutionEnv({ cwd: dir });
  env.remove = async () => ({ ok: false, error: new FileError("permission_denied", "denied") });
  try {
    expect(
      (
        await installOwnerSkills(
          env,
          ownerSkillBundle(adoptedSkills, dir)._unsafeUnwrap(),
          BACKGROUND_CONTEXT,
        )
      ).isErr(),
    ).toBe(true);
  } finally {
    await env.cleanup(BACKGROUND_CONTEXT);
    rmSync(dir, { recursive: true, force: true });
  }
});

it("accepts concurrent installers observing a missing parent before either creates it", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "owner-parent-race-"));
  const dir = join(workspace, "repo");
  mkdirSync(dir);
  const env = new NodeExecutionEnv({ cwd: dir });
  const original = env.fileInfo.bind(env);
  let reads = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  env.fileInfo = async (path, ctx) => {
    const value = await original(path, ctx);
    if (path === "../.pi-orb" && !value.ok) {
      reads++;
      if (reads === 2) release();
      await gate;
    }
    return value;
  };
  try {
    const bundle = ownerSkillBundle(adoptedSkills)._unsafeUnwrap();
    const values = await Promise.all([
      installOwnerSkills(env, bundle, BACKGROUND_CONTEXT),
      installOwnerSkills(env, bundle, BACKGROUND_CONTEXT),
    ]);
    expect(reads).toBe(2);
    expect(values.every((v) => v.isOk())).toBe(true);
    for (const f of bundle.files)
      expect(readFileSync(join(dir, f.path)).equals(Buffer.from(f.bytes))).toBe(true);
  } finally {
    await env.cleanup(BACKGROUND_CONTEXT);
    rmSync(workspace, { recursive: true, force: true });
  }
});

it("concurrent publish preserves an already healthy immutable directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "owner-publish-race-"));
  const env = new NodeExecutionEnv({ cwd: dir });
  const bundle = ownerSkillBundle(adoptedSkills, dir)._unsafeUnwrap();
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const staged = async () => {
    arrived++;
    if (arrived === 2) release();
    await gate;
  };
  try {
    const values = await Promise.all([
      installOwnerSkills(env, bundle, BACKGROUND_CONTEXT, staged),
      installOwnerSkills(env, bundle, BACKGROUND_CONTEXT, staged),
    ]);
    expect(values.every((v) => v.isOk())).toBe(true);
    const inode = statSync(bundle.root).ino;
    expect((await installOwnerSkills(env, bundle, BACKGROUND_CONTEXT))._unsafeUnwrap()).toBe(
      "verified",
    );
    expect(statSync(bundle.root).ino).toBe(inode);
    expect(readdirSync(dir)).toEqual([bundle.hash]);
  } finally {
    await env.cleanup(BACKGROUND_CONTEXT);
    rmSync(dir, { recursive: true, force: true });
  }
});

it("cancellation at the publication checkpoint leaves no partial bundle or staging directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "owner-interrupted-"));
  const env = new NodeExecutionEnv({ cwd: dir });
  const bundle = ownerSkillBundle(adoptedSkills, dir)._unsafeUnwrap();
  const abort = new AbortController();
  try {
    const result = await installOwnerSkills(
      env,
      bundle,
      withAbortSignal(abort.signal, BACKGROUND_CONTEXT),
      async () => {
        abort.abort();
      },
    );
    expect(result.isErr()).toBe(true);
    expect(existsSync(bundle.root)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  } finally {
    await env.cleanup(BACKGROUND_CONTEXT);
    rmSync(dir, { recursive: true, force: true });
  }
});

it("streams expanded manifests below the execution RPC limit without changing Unicode bytes", async () => {
  const bundle = ownerSkillBundle(
    Array.from({ length: 40 }, (_, i) => ({
      name: `skill-${i}`,
      content: "---\nname: skill\ndescription: d\n---\n",
      source: null,
      files: Array.from({ length: 4999 }, (_, j) => ({
        path: `文件-${j}-🌍`,
        base64: "",
        executable: false,
      })),
    })),
  )._unsafeUnwrap();
  const expected = Buffer.from(
    JSON.stringify(
      bundle.files.map((f) => ({
        path: posix.relative(bundle.root, f.path),
        sha256: f.sha256,
        executable: f.executable,
      })),
    ),
  );
  expect(expected.byteLength).toBeGreaterThan(16 * 1024 * 1024);
  const writes: Array<{ kind: string; path: string; bytes: Buffer }> = [];
  const removed: string[] = [];
  let executions = 0;
  const write = async (kind: string, path: string, content: string | Uint8Array) => {
    const bytes = Buffer.from(content);
    const payload = JSON.stringify({
      path,
      content: typeof content === "string" ? content : bytes.toString("base64"),
    });
    if (Buffer.byteLength(payload) > 16 * 1024 * 1024)
      return { ok: false, error: new FileError("unknown", "RPC body too large") };
    writes.push({ kind, path, bytes });
    return { ok: true, value: undefined };
  };
  const env = {
    fileInfo: async () => ({ ok: true, value: { kind: "directory" } }),
    createDir: async () => ({ ok: true, value: undefined }),
    writeFile: (path: string, content: string | Uint8Array) => write("write", path, content),
    appendFile: (path: string, content: string | Uint8Array) => write("append", path, content),
    exec: async (_args: string[], options: { onOutput: (text: string) => void }) => {
      executions++;
      options.onOutput("verified");
      return { ok: true, value: { exitCode: 0 } };
    },
    remove: async (path: string) => {
      removed.push(path);
      return { ok: true, value: undefined };
    },
  } as unknown as ExecutionEnv;
  expect((await installOwnerSkills(env, bundle, BACKGROUND_CONTEXT))._unsafeUnwrap()).toBe(
    "verified",
  );
  expect(writes.length).toBeGreaterThan(1);
  expect(writes.map((w) => w.kind)).toEqual(["write", ...writes.slice(1).map(() => "append")]);
  expect(
    writes.every((w) => w.path === writes[0]?.path && w.bytes.byteLength <= 4 * 1024 * 1024),
  ).toBe(true);
  expect(Buffer.concat(writes.map((w) => w.bytes)).equals(expected)).toBe(true);
  expect(executions).toBe(1);
  expect(removed).toEqual([posix.dirname(writes[0]!.path)]);
  env.appendFile = async () => ({ ok: false, error: new FileError("permission_denied", "denied") });
  expect((await installOwnerSkills(env, bundle, BACKGROUND_CONTEXT)).isErr()).toBe(true);
  expect(executions).toBe(1);
  expect(removed).toHaveLength(2);
});

it("keeps captured owner skills outside the Git checkout in the owned workspace", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "owner-clean-git-"));
  const cwd = join(workspace, "repo");
  mkdirSync(cwd);
  const env = new NodeExecutionEnv({ cwd });
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
  try {
    git("init", "--quiet");
    expect(git("status", "--porcelain", "--untracked-files=all")).toBe("");
    const bundle = ownerSkillBundle(adoptedSkills)._unsafeUnwrap();
    expect((await installOwnerSkills(env, bundle, BACKGROUND_CONTEXT))._unsafeUnwrap()).toBe(
      "installed",
    );
    expect(git("status", "--porcelain", "--untracked-files=all")).toBe("");
    expect(bundle.root).toBe(`../.pi-orb/owner-skills/${bundle.hash}`);
    for (const file of bundle.files) {
      const path = join(cwd, file.path);
      expect(path.startsWith(join(workspace, ".pi-orb/owner-skills") + "/")).toBe(true);
      expect(readFileSync(path).equals(Buffer.from(file.bytes))).toBe(true);
      expect(statSync(path).mode & 0o777).toBe(file.executable ? 0o700 : 0o600);
    }
    expect(git("status", "--porcelain", "--untracked-files=all")).toBe("");
  } finally {
    await env.cleanup(BACKGROUND_CONTEXT);
    rmSync(workspace, { recursive: true, force: true });
  }
});
