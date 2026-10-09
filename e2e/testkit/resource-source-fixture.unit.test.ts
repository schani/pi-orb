import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { okAsync } from "neverthrow";
import { expect, it, vi } from "vitest";
import { gatedResourceSource, localResourceSource } from "./resource-source-fixture.ts";

it("maps fake GitHub URLs through ordinary Git and resolves immutable skills/assets at one SHA", async () => {
  const root = mkdtempSync(join(tmpdir(), "durable-resource-fixture-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  try {
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.test");
    git("config", "uploadpack.allowFilter", "true");
    git("config", "uploadpack.allowAnySHA1InWant", "true");
    mkdirSync(join(root, ".agents/skills/check"), { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), "PINNED_INSTRUCTIONS");
    writeFileSync(
      join(root, ".agents/skills/check/SKILL.md"),
      "---\nname: check\ndescription: Fixture skill\n---\nUse data.txt.\n",
    );
    writeFileSync(join(root, ".agents/skills/check/data.txt"), "PINNED_ASSET");
    git("add", ".");
    git("commit", "-qm", "resource snapshot");
    const pinned = git("rev-parse", "HEAD");
    const source = localResourceSource(root);
    const snapshot = await source.acquire({
      orbId: randomUUID(),
      url: "https://github.com/fixture/resources",
      signal: new AbortController().signal,
    });
    expect(snapshot.isOk(), JSON.stringify(snapshot)).toBe(true);
    if (snapshot.isErr()) return;
    expect(snapshot.value.commitSha).toBe(pinned);
    expect(snapshot.value.skillRoot).toBe(".agents/skills");
    expect(
      snapshot.value.files.some(
        (file) =>
          file.path.endsWith("data.txt") && new TextDecoder().decode(file.bytes) === "PINNED_ASSET",
      ),
    ).toBe(true);
    writeFileSync(join(root, "AGENTS.md"), "LATER_BRANCH_INSTRUCTIONS");
    git("add", ".");
    git("commit", "-qm", "main moved");
    expect(git("rev-parse", "HEAD")).not.toBe(pinned);
    expect(
      new TextDecoder().decode(
        snapshot.value.files.find((file) => file.path === "AGENTS.md")?.bytes,
      ),
    ).toBe("PINNED_INSTRUCTIONS");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("aborting the Git readiness gate never invokes the source after release", async () => {
  let entered!: () => void;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const server = createServer((_req, _res) => {
    entered();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing gate");
  const acquire = vi.fn(() =>
    okAsync({
      orbId: "orb",
      commitSha: "a".repeat(40),
      instructionPath: null,
      skillRoot: null,
      files: [],
    }),
  );
  const controller = new AbortController();
  try {
    const source = gatedResourceSource({ acquire }, `http://127.0.0.1:${address.port}/gate`);
    const pending = source.acquire({
      orbId: randomUUID(),
      url: "https://github.com/fixture/repo",
      signal: controller.signal,
    });
    await reached;
    controller.abort();
    const result = await pending;
    expect(result.isErr() && result.error.code).toBe("cancelled");
    expect(acquire).not.toHaveBeenCalled();
  } finally {
    controller.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
