import { chmodSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// node-pty 1.1.0's macOS prebuilt spawn-helper can be extracted without its
// executable bit by npm ci, making every local PTY open fail with
// `posix_spawnp failed`. Linux runtime images discard prebuilds and compile
// node-pty from source, so this only repairs the local macOS artifact.
if (process.platform === "darwin") {
  const helper = fileURLToPath(
    new URL(
      `../node_modules/node-pty/prebuilds/darwin-${process.arch}/spawn-helper`,
      import.meta.url,
    ),
  );
  if (existsSync(helper)) chmodSync(helper, 0o755);
}
