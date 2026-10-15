import { execFile } from "node:child_process";
import { expect, it, vi } from "vitest";
import { docker } from "./harness.ts";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: vi.fn(),
}));

it("retains original Docker exit/signal metadata alongside stderr", async () => {
  const failure = Object.assign(new Error("Command failed"), {
    code: 137,
    signal: "SIGKILL",
    killed: true,
  });
  vi.mocked(execFile).mockImplementationOnce((...args: unknown[]) => {
    const callback = args[args.length - 1] as (
      error: Error,
      stdout: string,
      stderr: string,
    ) => void;
    callback(failure, "", "build transport closed");
    return {} as ReturnType<typeof execFile>;
  });
  await expect(docker(["build", "."], 600_000)).rejects.toMatchObject({
    message: "docker build: build transport closed",
    cause: failure,
  });
});
