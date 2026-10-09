import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareCheckout } from "./checkout.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function retainedRepo(): { workDir: string; repoDir: string } {
  const workDir = mkdtempSync(join(tmpdir(), "pi-orb-checkout-"));
  roots.push(workDir);
  const repoDir = join(workDir, "repo");
  mkdirSync(repoDir);
  return { workDir, repoDir };
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd }).toString();

describe("retained checkout", () => {
  it("reports the HEAD commit", async () => {
    const { workDir, repoDir } = retainedRepo();
    git(repoDir, "init", "-q");
    writeFileSync(join(repoDir, "a"), "a");
    git(repoDir, "add", "a");
    git(repoDir, "commit", "-qm", "a");

    const result = await prepareCheckout(workDir, "https://example.invalid/r.git");

    expect(result._unsafeUnwrap()).toBe(git(repoDir, "rev-parse", "HEAD").trim());
  });

  it("reports no commit for a repository without commits", async () => {
    const { workDir, repoDir } = retainedRepo();
    git(repoDir, "init", "-q");

    const result = await prepareCheckout(workDir, "https://example.invalid/r.git");

    expect(result._unsafeUnwrap()).toBeNull();
  });

  it("fails when refs exist but HEAD does not resolve", async () => {
    const { workDir, repoDir } = retainedRepo();
    git(repoDir, "init", "-q");
    writeFileSync(join(repoDir, "a"), "a");
    git(repoDir, "add", "a");
    git(repoDir, "commit", "-qm", "a");
    git(repoDir, "symbolic-ref", "HEAD", "refs/heads/missing");

    const result = await prepareCheckout(workDir, "https://example.invalid/r.git");

    expect(result._unsafeUnwrapErr().code).toBe("clone_failed");
  });
});
