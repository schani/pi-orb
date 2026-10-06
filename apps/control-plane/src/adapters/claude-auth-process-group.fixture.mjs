#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync, renameSync, watch, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);
const mode = process.argv[2];

if (mode === "--qualify") {
  // PID 1 reaps orphaned fixture descendants; exiting it kills the entire namespace,
  // including on a failed assertion or a test-runner crash.
  const init = `
import os, signal, sys
uid, gid = int(sys.argv[1]), int(sys.argv[2])
main = os.fork()
if main == 0:
    os.setgroups([])
    os.setgid(gid)
    os.setuid(uid)
    os.environ["CLAUDE_AUTH_GROUP_NAMESPACE"] = "1"
    os.environ["CLAUDE_AUTH_GROUP_MUTATION"] = sys.argv[3]
    os.execv(sys.argv[4], sys.argv[4:])
while True:
    try:
        pid, status = os.waitpid(-1, 0)
    except InterruptedError:
        continue
    if pid == main:
        code = os.waitstatus_to_exitcode(status)
        sys.exit(code if code >= 0 else 128 - code)
`;
  const child = spawn(
    "sudo",
    [
      "-n",
      "unshare",
      "--net",
      "--pid",
      "--fork",
      "--mount-proc",
      "/usr/bin/python3",
      "-c",
      init,
      String(process.getuid()),
      String(process.getgid()),
      process.argv[3] ?? "none",
      process.execPath,
      "node_modules/vitest/vitest.mjs",
      "run",
      "apps/control-plane/src/adapters/claude-auth-process-group.contract.test.ts",
      "--maxWorkers=1",
    ],
    { stdio: "inherit" },
  );
  child.on("error", () => process.exit(125));
  child.on("exit", (code) => process.exit(code ?? 125));
} else {
  const metadata = () => {
    const stat = readFileSync("/proc/self/stat", "utf8").split(") ")[1].split(" ");
    return { pid: process.pid, ppid: Number(stat[1]), pgid: Number(stat[2]), sid: Number(stat[3]) };
  };
  process.on("SIGHUP", () => {});
  if (mode === "--child") {
    process.on("SIGTERM", () => {
      writeFileSync("child-term-pending", "observed");
      renameSync("child-term-pending", "child-term");
    });
    // A real handle keeps the orphan alive after the wrapper closes IPC.
    watch(process.cwd(), () => {});
    // The existing seccomp guard must deny this before any packet reaches a service.
    const probe = createConnection({ host: "127.0.0.1", port: 9 });
    probe.on("error", (error) => {
      process.send({ child: metadata(), networkDenied: error.code === "EPERM" });
    });
    probe.on("connect", () => {
      probe.destroy();
      process.send({ child: metadata(), networkDenied: false });
    });
  } else {
    process.on("SIGTERM", () => {
      if (mode === "--root-first") process.exit(0);
    });
    const child = spawn(process.execPath, [self, "--child"], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    child.on("message", (message) => {
      process.stdout.write(`OWNED_READY ${JSON.stringify({ parent: metadata(), ...message })}\n`);
      process.stdout.write("https://claude.com/cai/oauth/authorize?state=synthetic-public\n");
      process.stdout.write("Paste code here if prompted > \n");
      process.stdout.write(
        "Your OAuth token (valid for 1 year):\nsk-ant-oat01-synthetic-group-only\n",
      );
    });
  }
}
