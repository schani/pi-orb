import { execFileSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { NoSimulationTask } from "determined";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resourceError } from "../../domain/resources.ts";
import { command } from "./git.ts";
import { GitHubOwnerSkillSource } from "./owner-skills.ts";

const task = new NoSimulationTask("github owner skill", false);
const url = "https://github.com/example/catalog/tree/main/skills/demo";
const content = "---\nname: demo\ndescription: Test\n---\nInstructions\n";
const image = Buffer.from([137, 80, 78, 71, 0, 255, 128]);
let repo: string;
let sha: string;
let staging: Set<string>;
let calls: string[][];
const git = (...args: string[]) =>
  execFileSync("git", args, {
    cwd: repo,
    env: {
      PATH: process.env.PATH,
      HOME: repo,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
    stdio: "pipe",
  });
const runner: typeof command = (args, cwd, env, signal, input, inspectPack) => {
  staging.add(cwd);
  calls.push(args);
  // Only this fixture runner translates the validated public GitHub remote to a local repository.
  const local = args.map((arg) =>
    arg === "https://github.com/example/catalog.git" ? pathToFileURL(repo).href : arg,
  );
  return command(local, cwd, { ...env, GIT_CONFIG_COUNT: "0" }, signal, input, inspectPack);
};
const source = () => new GitHubOwnerSkillSource({ command: runner });
async function expectClean() {
  expect(staging.size).toBeGreaterThan(0);
  for (const path of staging) await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
}
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "owner-skill-fixture-"));
  staging = new Set();
  calls = [];
  git("init", "-b", "main");
  git("config", "user.name", "fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "uploadpack.allowFilter", "true");
  git("config", "uploadpack.allowAnySHA1InWant", "true");
  await mkdir(join(repo, "skills/demo/assets/nested"), { recursive: true });
  await writeFile(join(repo, "skills/demo/SKILL.md"), content);
  await writeFile(join(repo, "skills/demo/assets/nested/image.png"), image);
  await writeFile(join(repo, "skills/demo/LICENSE"), "License text\n");
  await writeFile(join(repo, "skills/demo/run.sh"), "#!/bin/sh\nprintf hello\n");
  await chmod(join(repo, "skills/demo/run.sh"), 0o755);
  await writeFile(join(repo, "unrelated.bin"), Buffer.alloc(1024 * 1024, 111));
  git("add", ".");
  git("commit", "-m", "fixture");
  sha = git("rev-parse", "HEAD").toString().trim();
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
  for (const path of staging) await rm(path, { recursive: true, force: true });
});

describe("GitHub owner skill folder source", () => {
  it("imports the whole folder losslessly, without unrelated blobs or checkout", async () => {
    const result = await source().acquire(task, { url });
    expect(result.isErr() ? { error: result.error, calls } : null).toBeNull();
    expect(result.isOk() && result.value).toEqual({
      content,
      files: [
        {
          path: "LICENSE",
          base64: Buffer.from("License text\n").toString("base64"),
          executable: false,
        },
        { path: "assets/nested/image.png", base64: image.toString("base64"), executable: false },
        {
          path: "run.sh",
          base64: Buffer.from("#!/bin/sh\nprintf hello\n").toString("base64"),
          executable: true,
        },
      ],
      source: { url, commitSha: sha },
    });
    expect(calls.some((args) => args.includes("checkout"))).toBe(false);
    const blobs = calls.filter((args) => args[0] === "cat-file" && args.includes("--batch"));
    expect(blobs.length).toBeGreaterThan(0);
    const unrelatedOid = git("rev-parse", "HEAD:unrelated.bin").toString().trim();
    expect(calls.flat()).not.toContain(unrelatedOid);
    await expectClean();
  });
  it("pins preview once and imports that SHA after the branch moves", async () => {
    const preview = await source().acquire(task, { url });
    expect(preview.isOk()).toBe(true);
    await writeFile(join(repo, "skills/demo/SKILL.md"), `${content}Moved branch\n`);
    git("add", ".");
    git("commit", "-m", "move");
    calls = [];
    const imported = await source().acquire(task, { url, commitSha: sha });
    expect(imported.isOk() && imported.value.content).toBe(content);
    expect(imported.isOk() && imported.value.source?.commitSha).toBe(sha);
    expect(calls.filter((args) => args[0] === "fetch").flat()).not.toContain("main");
    const moved = await source().acquire(task, { url });
    expect(moved.isOk() && moved.value.content).toBe(`${content}Moved branch\n`);
    await expectClean();
  });
  it.each([
    "http://github.com/example/catalog/tree/main/skills/demo",
    "https://evil.invalid/example/catalog/tree/main/skills/demo",
    "https://github.com.evil.invalid/example/catalog/tree/main/skills/demo",
    "https://user:secret@github.com/example/catalog/tree/main/skills/demo",
    "https://github.com:443/example/catalog/tree/main/skills/demo",
    `${url}?download=1`,
    `${url}#readme`,
    "https://github.com/example/catalog/tree/main",
    "https://github.com/example/catalog/tree/main/../demo",
    "https://github.com/example/catalog/tree/main/skills/%2e%2e/demo",
    "https://github.com/example/catalog/tree/main/skills/%2Fdemo",
    "https://github.com/example/catalog/tree/main/skills/%5cdemo",
    "https://github.com/example/catalog/tree/feature%2Fbranch/skills/demo",
    "https://github.com/example/catalog/tree/--upload-pack=evil/skills/demo",
    "https://github.com/example/catalog/tree/bad..ref/skills/demo",
    "https://github.com/example/catalog/tree/x.lock/skills/demo",
    "https://github.com/example/catalog/tree/main/skills/%ff",
    "https://github.com/example/catalog/tree/main/skills/%",
    "https://github.com/example/catalog/tree/main/skills/\ud800",
    "https://github.com/example/catalog/tree/main/skills/%00",
    "https://github.com/example/catalog/tree/main/skills/%2500",
    "https://github.com/example/catalog/tree/main/skills/\\demo",
    "https://github.com/example/catalog/tree/main/skills//demo",
  ])("rejects unsafe URL before creating staging or running Git: %s", async (badUrl) => {
    const result = await source().acquire(task, { url: badUrl });
    expect(result.isErr() && result.error.code).toBe("invalid");
    expect(calls).toEqual([]);
    expect(staging.size).toBe(0);
  });
  it.each(["HEAD", "--help", "a".repeat(39), "A".repeat(40), `${"a".repeat(40)}\n`])(
    "rejects malformed pinned SHA: %s",
    async (commitSha) => {
      const result = await source().acquire(task, { url, commitSha });
      expect(result.isErr() && result.error.code).toBe("invalid");
      expect(calls).toEqual([]);
    },
  );
  it("decodes Unicode folder components exactly once", async () => {
    await mkdir(join(repo, "skills/café"));
    await writeFile(join(repo, "skills/café/SKILL.md"), content);
    git("add", ".");
    git("commit", "-m", "unicode");
    const result = await source().acquire(task, { url: url.replace("demo", "caf%C3%A9") });
    expect(result.isOk() && result.value.content).toBe(content);
  });
  it.each(["missing", "skills/demo/assets"])("reports absent folder/root: %s", async (folder) => {
    const result = await source().acquire(task, { url: url.replace("skills/demo", folder) });
    expect(result.isErr() && result.error.code).toBe("not_found");
    await expectClean();
  });
  it.each(["symlink", "submodule"])("rejects %s anywhere in the folder", async (kind) => {
    if (kind === "symlink") {
      await symlink("LICENSE", join(repo, "skills/demo/link"));
      git("add", ".");
    } else git("update-index", "--add", "--cacheinfo", `160000,${sha},skills/demo/submodule`);
    git("commit", "-m", kind);
    const result = await source().acquire(task, { url });
    expect(result.isErr() && result.error.code).toBe("invalid");
    await expectClean();
  });
  it("rejects a symlink folder rather than following it", async () => {
    await symlink("demo", join(repo, "skills/alias"));
    git("add", ".");
    git("commit", "-m", "alias");
    const result = await source().acquire(task, { url: url.replace("demo", "alias") });
    expect(result.isErr()).toBe(true);
    await expectClean();
  });
  it.each([
    ["root", 64 * 1024 + 1],
    ["bundle", 8 * 1024 * 1024],
  ] as const)("checks %s byte budget before reading blobs", async (kind, size) => {
    await writeFile(
      join(repo, "skills/demo", kind === "root" ? "SKILL.md" : "huge.bin"),
      Buffer.alloc(size),
    );
    git("add", ".");
    git("commit", "-m", "budget");
    const result = await source().acquire(task, { url });
    expect(result.isErr() && result.error.code).toBe("invalid");
    expect(calls.some((args) => args.includes("--batch"))).toBe(false);
    await expectClean();
  });
  it("rejects invalid UTF-8 in root but preserves arbitrary support bytes", async () => {
    await writeFile(join(repo, "skills/demo/SKILL.md"), Buffer.from([255]));
    git("add", ".");
    git("commit", "-m", "encoding");
    const result = await source().acquire(task, { url });
    expect(result.isErr() && result.error.code).toBe("invalid");
    await expectClean();
  });
  it("cleans staging after command errors without leaking remote diagnostics", async () => {
    const failing: typeof command = (_args, cwd) => {
      staging.add(cwd);
      return errAsync(resourceError("fetch", "fixture failure"));
    };
    const result = await new GitHubOwnerSkillSource({ command: failing }).acquire(task, { url });
    expect(result.isErr() && result.error.code).toBe("unavailable");
    expect(result.isErr() && result.error.message).not.toContain("fixture failure");
    await expectClean();
  });
  it("avoids staging for already cancelled operations", async () => {
    const abort = new AbortController();
    abort.abort();
    const result = await source().acquire(task, { url }, abort.signal);
    expect(result.isErr() && result.error.code).toBe("unavailable");
    expect(calls).toEqual([]);
  });
  it("cleans up cancellation during fetch", async () => {
    const abort = new AbortController();
    const cancel: typeof command = (args, cwd, env, signal, input, inspectPack) => {
      if (args[0] === "fetch") abort.abort();
      return runner(args, cwd, env, signal, input, inspectPack);
    };
    const result = await new GitHubOwnerSkillSource({ command: cancel }).acquire(
      task,
      { url },
      abort.signal,
    );
    expect(result.isErr() && result.error.code).toBe("unavailable");
    await expectClean();
  });
  it.each([5000, 5001])("bounds the full folder to 5,000 files: %s", async (count) => {
    const oid = git("rev-parse", "HEAD:skills/demo/SKILL.md").toString().trim();
    const listing: typeof command = (args, ...rest) =>
      args[0] === "ls-tree"
        ? okAsync(
            Buffer.from(
              Array.from(
                { length: count },
                (_, index) => `100644 blob ${oid}\t${index === 0 ? "SKILL.md" : `file-${index}`}\0`,
              ).join(""),
            ),
          )
        : runner(args, ...rest);
    const result = await new GitHubOwnerSkillSource({ command: listing }).acquire(task, { url });
    expect(result.isOk()).toBe(count === 5000);
    if (result.isOk()) expect(result.value.files).toHaveLength(4999);
    else expect(result.error.code).toBe("invalid");
    await expectClean();
  });
  it.each(["../escape", "/absolute", "a//b", "a/./b", "a/../b", "a\\b", "line\nbreak"])(
    "rejects hostile tree paths: %s",
    async (path) => {
      const listing: typeof command = (args, ...rest) =>
        args[0] === "ls-tree"
          ? okAsync(Buffer.from(`100644 blob ${sha}\t${path}\0`))
          : runner(args, ...rest);
      const result = await new GitHubOwnerSkillSource({ command: listing }).acquire(task, { url });
      expect(result.isErr() && result.error.code).toBe("invalid");
      expect(calls.filter((args) => args[0] === "fetch")).toHaveLength(1);
      await expectClean();
    },
  );
  it("rejects malformed UTF-8 tree names", async () => {
    const listing: typeof command = (args, ...rest) =>
      args[0] === "ls-tree"
        ? okAsync(Buffer.concat([Buffer.from(`100644 blob ${sha}\t`), Buffer.from([255, 0])]))
        : runner(args, ...rest);
    const result = await new GitHubOwnerSkillSource({ command: listing }).acquire(task, { url });
    expect(result.isErr() && result.error.code).toBe("invalid");
    await expectClean();
  });
  it("counts repeated content at each path against the expanded byte budget", async () => {
    await writeFile(join(repo, "skills/demo/SKILL.md"), Buffer.alloc(64 * 1024, 65));
    git("add", ".");
    git("commit", "-m", "large root");
    const oid = git("rev-parse", "HEAD:skills/demo/SKILL.md").toString().trim();
    const listing: typeof command = (args, ...rest) =>
      args[0] === "ls-tree"
        ? okAsync(
            Buffer.from(
              Array.from(
                { length: 129 },
                (_, index) => `100644 blob ${oid}\t${index === 0 ? "SKILL.md" : `file-${index}`}\0`,
              ).join(""),
            ),
          )
        : runner(args, ...rest);
    const result = await new GitHubOwnerSkillSource({ command: listing }).acquire(task, { url });
    expect(result.isErr() && result.error.code).toBe("invalid");
    expect(calls.some((args) => args.includes("--batch"))).toBe(false);
    await expectClean();
  });
  it("checks staged pack bytes after fetch and cleans excess", async () => {
    const largePack: typeof command = (args, cwd, ...rest) => {
      if (args[0] !== "fetch") return runner(args, cwd, ...rest);
      const pack = join(cwd, "objects/pack/fixture.pack");
      return ResultAsync.fromPromise(
        writeFile(pack, "").then(() => truncate(pack, 128 * 1024 * 1024 + 1)),
        () => resourceError("fetch", "fixture write failed"),
      ).map(() => Buffer.alloc(0));
    };
    const result = await new GitHubOwnerSkillSource({ command: largePack }).acquire(task, { url });
    expect(result.isErr() && result.error.code).toBe("invalid");
    await expectClean();
  });
  it("maps the bounded command output failure and cleans staging", async () => {
    const limited: typeof command = (args, ...rest) =>
      args[0] === "fetch"
        ? errAsync(resourceError("limit", "Output budget exceeded"))
        : runner(args, ...rest);
    const result = await new GitHubOwnerSkillSource({ command: limited }).acquire(task, { url });
    expect(result.isErr() && result.error.code).toBe("invalid");
    await expectClean();
  });
  it("enforces its operation deadline and cleans staging", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    try {
      const expire: typeof command = (args, ...rest) => {
        if (args[0] === "fetch") deadline.abort();
        return runner(args, ...rest);
      };
      const result = await new GitHubOwnerSkillSource({ command: expire }).acquire(task, { url });
      expect(timeout).toHaveBeenCalledWith(180_000);
      expect(result.isErr() && result.error.message).toBe(
        "GitHub skill acquisition deadline exceeded",
      );
      await expectClean();
    } finally {
      timeout.mockRestore();
    }
  });
  it("rejects blob corruption before returning a bundle", async () => {
    const corrupt: typeof command = (args, ...rest) =>
      runner(args, ...rest).map((bytes) => {
        if (!args.includes("--batch")) return bytes;
        const changed = Buffer.from(bytes);
        const index = changed.indexOf(10) + 1;
        changed[index] = (changed[index] ?? 0) ^ 1;
        return changed;
      });
    const result = await new GitHubOwnerSkillSource({ command: corrupt }).acquire(task, { url });
    expect(result.isErr() && result.error.message).toContain("integrity check");
    await expectClean();
  });
  it("isolates Git credentials/config and forbids redirects/non-HTTPS transports", async () => {
    const inspect: typeof command = (args, cwd, env, signal, input, inspectPack) => {
      expect(env.GIT_CONFIG_COUNT).toBeDefined();
      const config = new Map(
        Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, index) => [
          env[`GIT_CONFIG_KEY_${index}`],
          env[`GIT_CONFIG_VALUE_${index}`],
        ]),
      );
      expect(config.get("http.followRedirects")).toBe("false");
      expect(config.get("protocol.allow")).toBe("never");
      expect(config.get("protocol.https.allow")).toBe("always");
      expect(config.get("credential.helper")).toBe("");
      return runner(args, cwd, env, signal, input, inspectPack);
    };
    expect(
      (await new GitHubOwnerSkillSource({ command: inspect }).acquire(task, { url })).isOk(),
    ).toBe(true);
  });
});
