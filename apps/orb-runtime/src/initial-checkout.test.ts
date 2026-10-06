import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initialCheckoutCommands } from "./initial-checkout.ts";

describe("fresh checkout pin", () => {
  it("initializes main at the snapshot commit even when origin main advanced", async () => {
    const root = await mkdtemp(join(tmpdir(), "checkout-pin-"));
    const git = (cwd: string, args: string[]) =>
      execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    try {
      const source = join(root, "source");
      execFileSync("git", ["init", "-b", "main", source], { stdio: "ignore" });
      git(source, ["config", "user.name", "Test"]);
      git(source, ["config", "user.email", "test@example.com"]);
      await writeFile(join(source, "AGENTS.md"), "snapshot");
      git(source, ["add", "."]);
      git(source, ["commit", "-m", "snapshot"]);
      const sha = git(source, ["rev-parse", "HEAD"]);
      await writeFile(join(source, "AGENTS.md"), "new branch head");
      git(source, ["commit", "-am", "advance"]);
      const checkout = join(root, "checkout");
      execFileSync("git", ["clone", source, checkout], { stdio: "ignore" });
      const commands = initialCheckoutCommands(sha);
      expect(commands.isOk()).toBe(true);
      if (commands.isErr()) return;
      for (const command of commands.value) git(checkout, command);
      expect(git(checkout, ["rev-parse", "HEAD"])).toBe(sha);
      expect(git(checkout, ["branch", "--show-current"])).toBe("main");
      expect(git(checkout, ["show", "HEAD:AGENTS.md"])).toBe("snapshot");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("fetches immutable commit and initializes main without moving later resumes", () => {
    const sha = "b".repeat(40);
    const result = initialCheckoutCommands(sha);
    expect(result.isOk()).toBe(true);
    if (result.isOk())
      expect(result.value).toEqual([
        ["fetch", "origin", sha],
        ["checkout", "-B", "main", sha],
      ]);
  });
  it("allows SDK branch resolution when no central snapshot pin was requested", () => {
    expect(initialCheckoutCommands(undefined)._unsafeUnwrap()).toEqual([]);
  });
  it.each(["main", "--help", "a".repeat(39), "a".repeat(41)])("rejects invalid pin %s", (pin) => {
    expect(initialCheckoutCommands(pin).isErr()).toBe(true);
  });
});
