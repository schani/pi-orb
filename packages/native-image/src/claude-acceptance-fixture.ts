import { copyFile, cp, mkdir, realpath, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { build } from "esbuild";

/** Copy runtime inputs, not checkout symlinks: the guest runs as UID2000. */
export async function materializeClaudeAcceptanceFixture(directory: string, repository: string) {
  const candidate = join(directory, "candidate");
  const helpers = join(directory, "validator");
  // Resolve while the caller can traverse the checkout. No generated bundle is executed.
  const source = await realpath(repository);
  const graph = await build({
    absWorkingDir: source,
    entryPoints: ["apps/orb-runtime/src/claude/agent.ts"],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    external: ["@anthropic-ai/claude-agent-sdk"],
    metafile: true,
  });
  await mkdir(candidate);
  await mkdir(helpers);
  const packages = new Set([
    "node_modules/@anthropic-ai/claude-agent-sdk",
    // Only the acceptance platform's native binary, not every optional SDK binary.
    "node_modules/@anthropic-ai/claude-agent-sdk-linux-x64",
  ]);
  const files = new Set([
    "package.json",
    "apps/orb-runtime/package.json",
    "packages/protocol/package.json",
  ]);
  for (const input of Object.keys(graph.metafile.inputs)) {
    const parts = input.split("/");
    const modules = parts.lastIndexOf("node_modules");
    if (modules >= 0) {
      const end = modules + (parts[modules + 1]?.startsWith("@") ? 3 : 2);
      packages.add(parts.slice(0, end).join("/"));
    } else {
      files.add(input);
    }
  }
  for (const file of files) {
    await mkdir(dirname(join(candidate, file)), { recursive: true });
    await copyFile(join(source, file), join(candidate, file));
  }
  for (const path of packages) {
    await cp(join(source, path), join(candidate, path), { recursive: true, dereference: true });
  }
  // Workspaces retain their package scope without resolving through the checkout.
  await mkdir(join(candidate, "node_modules/@pi-orb"), { recursive: true });
  await symlink("../../packages/protocol", join(candidate, "node_modules/@pi-orb/protocol"));
  for (const file of [
    "claude-acceptance.sh",
    "claude-worker.mjs",
    "claude-workload.mjs",
    "claude-receipt-edge.mjs",
  ])
    await copyFile(join(source, "infra/native-vm", file), join(helpers, file));
  return { candidate, helpers };
}
