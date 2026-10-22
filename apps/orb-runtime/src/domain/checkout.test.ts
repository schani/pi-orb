import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok } from "neverthrow";
import { expect, it, vi } from "vitest";
import { prepareCheckout } from "./checkout.ts";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
it("pins fresh checkout before publishing it and bypasses admission on resume", async () => {
  const root = mkdtempSync(join(tmpdir(), "checkout-pin-"));
  const commands: string[][] = [];
  vi.mocked(execFile).mockImplementation(((
    command: string,
    args: string[],
    options: { cwd: string },
    callback: (error: null, stdout: string, stderr: string) => void,
  ) => {
    expect(command).toBe("git");
    commands.push(args);
    if (args[0] === "clone") mkdirSync(join(root, ".clone-tmp", ".git"), { recursive: true });
    callback(null, "a".repeat(40), "");
  }) as never);
  const pin = vi.fn(async () => ok([["checkout", "--detach", "b".repeat(40)]]));
  try {
    expect((await prepareCheckout(root, "https://github.com/o/r", pin)).isOk()).toBe(true);
    expect(commands.map((args) => args[0])).toEqual(["clone", "checkout", "rev-parse"]);
    expect((await prepareCheckout(root, "https://github.com/o/r", pin)).isOk()).toBe(true);
    expect(pin).toHaveBeenCalledTimes(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it("fails closed before cloning if initial admission fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "checkout-revoked-"));
  vi.mocked(execFile).mockClear();
  try {
    const result = await prepareCheckout(root, "https://github.com/o/r", async () =>
      err({ code: "clone_failed", message: "revoked", retryable: false }),
    );
    expect(result.isErr()).toBe(true);
    expect(execFile).not.toHaveBeenCalled();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it.each([null, "https://github.com/o/r"])(
  "preserves a no-repository workspace after the project URL becomes %s without Git or pin admission",
  async (repositoryUrl) => {
    const root = mkdtempSync(join(tmpdir(), "checkout-no-repo-"));
    vi.mocked(execFile).mockClear();
    const pin = vi.fn(async () => ok([]));
    try {
      expect((await prepareCheckout(root, null, pin))._unsafeUnwrap()).toBeNull();
      expect(existsSync(join(root, "repo"))).toBe(true);
      expect(existsSync(join(root, "repo", ".git"))).toBe(false);
      writeFileSync(join(root, "repo", "retained"), "work");
      expect((await prepareCheckout(root, repositoryUrl, pin))._unsafeUnwrap()).toBeNull();
      expect(existsSync(join(root, "repo", ".git"))).toBe(false);
      expect(readFileSync(join(root, "repo", "retained"), "utf8")).toBe("work");
      expect(execFile).not.toHaveBeenCalled();
      expect(pin).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
