import { execFile, execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

// Newer git (2.55) aborts on an unreadable working directory; a sandboxed runtime can inherit one.
test("applies the identity when the runtime's working directory is unreadable", async () => {
  const root = await mkdtemp(join(tmpdir(), "git-identity-cwd-"));
  const locked = join(root, "locked");
  const home = join(root, "home");
  await mkdir(locked);
  await mkdir(home);
  const script = `
    import { createServer } from "node:http";
    import { chmodSync } from "node:fs";
    import { applyGitIdentity } from ${JSON.stringify(new URL("./apply.ts", import.meta.url).href)};
    const server = createServer((_, response) =>
      response.end(JSON.stringify({ name: "Ada Lovelace", email: "ada@example.com" })));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    process.chdir(${JSON.stringify(locked)});
    chmodSync(${JSON.stringify(locked)}, 0);
    const result = await applyGitIdentity(
      { controlPlaneUrl: "http://127.0.0.1:" + server.address().port, runtimeToken: "t" },
      ${JSON.stringify(home)},
      process.env,
    );
    server.close();
    console.log(JSON.stringify(result.isOk() ? "ok" : result.error.message));
  `;
  try {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["--input-type=module", "-e", script],
      { cwd: root },
    );
    expect(JSON.parse(stdout)).toBe("ok");
    expect(
      execFileSync("git", ["config", "--file", join(home, ".config/git/config"), "user.email"])
        .toString()
        .trim(),
    ).toBe("ada@example.com");
  } finally {
    await chmod(locked, 0o700);
    await rm(root, { recursive: true, force: true });
  }
});
