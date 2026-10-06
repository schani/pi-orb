import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { materializeClaudeAcceptanceFixture } from "./claude-acceptance-fixture.ts";

const execute = promisify(execFile);

it.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "materializes a UID2000 fixture independent of a mode0700 checkout ancestor",
  async () => {
    const restricted = await mkdtemp(join(tmpdir(), "claude-restricted-checkout-"));
    const directory = await mkdtemp(join(tmpdir(), "claude-owned-fixture-"));
    const repository = new URL("../../../", import.meta.url).pathname;
    const checkout = join(restricted, "checkout");
    // UID2000 is also the local runner: root ownership makes the denial deterministic.
    const privileged = process.getuid?.() === 0;
    const asRoot = (args: [string, ...string[]]) =>
      execute(privileged ? args[0] : "sudo", privileged ? args.slice(1) : ["-n", "--", ...args]);
    const asGuest = (args: [string, ...string[]]) =>
      asRoot(["setpriv", "--reuid=2000", "--regid=2000", "--clear-groups", ...args]);
    try {
      await chmod(directory, 0o755);
      await symlink(repository, checkout);
      await asRoot(["chown", "0:0", restricted]);
      const denied = await asGuest([
        process.execPath,
        "--input-type=module",
        "-e",
        `import { createRequire } from 'node:module'; createRequire(${JSON.stringify(join(checkout, "package.json"))})('neverthrow');`,
      ]).then(
        () => "unexpected-success",
        (error: { stderr: string }) => error.stderr,
      );
      expect(denied).toContain("Cannot find module 'neverthrow'");
      await asRoot(["chown", `${process.getuid?.() ?? 0}:0`, restricted]);
      const fixture = await materializeClaudeAcceptanceFixture(directory, checkout);
      await asRoot(["chown", "0:0", restricted]);
      const probe = await asGuest([
        process.execPath,
        "--input-type=module",
        "-e",
        `import { createRequire } from 'node:module';
import { accessSync, constants } from 'node:fs';
import { pathToFileURL } from 'node:url';
const root = process.argv[1];
const require = createRequire(root + '/package.json');
require('neverthrow');
await import(pathToFileURL(root + '/apps/orb-runtime/src/claude/agent.ts'));
const helpers = process.argv[2];
process.argv[2] = root;
await import(pathToFileURL(helpers + '/claude-receipt-edge.mjs'));
accessSync(require.resolve('@anthropic-ai/claude-agent-sdk-linux-x64/claude'), constants.X_OK);
console.log('uid=' + process.getuid());`,
        fixture.candidate,
        fixture.helpers,
      ]);
      expect(probe.stderr).toBe("");
      expect(probe.stdout.trim()).toBe("uid=2000");
    } finally {
      await asRoot(["chown", `${process.getuid?.() ?? 0}:0`, restricted]);
      await rm(restricted, { recursive: true, force: true });
      await rm(directory, { recursive: true, force: true });
    }
  },
);
