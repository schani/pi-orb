import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
    if (args[0] === "clone") mkdirSync(join(root, ".clone-tmp"));
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
