import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const hostKeyAlgorithms = [
  ["ecdsa", "ecdsa-sha2-nistp256"],
  ["ed25519", "ssh-ed25519"],
  ["rsa", "ssh-rsa"],
] as const;

// One real keypair per algorithm per file; only isolated copies enter a scenario.
export function generateHostKeyPairs(onGenerate: () => void) {
  const source = mkdtempSync(join(tmpdir(), "pi-orb-host-key-source-"));
  try {
    for (const [type] of hostKeyAlgorithms) {
      onGenerate();
      execFileSync("ssh-keygen", [
        "-q",
        "-t",
        type,
        "-N",
        "",
        "-C",
        "host-key-test-comment",
        "-f",
        join(source, type),
      ]);
      chmodSync(join(source, type), 0o400);
      chmodSync(join(source, `${type}.pub`), 0o444);
    }
  } catch (error) {
    rmSync(source, { recursive: true, force: true });
    throw error;
  }
  return {
    copyTo(directory: string, name: (type: string) => string = (type) => type) {
      for (const [type] of hostKeyAlgorithms) {
        for (const suffix of ["", ".pub"]) {
          const target = join(directory, `${name(type)}${suffix}`);
          copyFileSync(join(source, `${type}${suffix}`), target);
          chmodSync(target, suffix === "" ? 0o600 : 0o644);
        }
      }
    },
    dispose() {
      rmSync(source, { recursive: true, force: true });
    },
  };
}
