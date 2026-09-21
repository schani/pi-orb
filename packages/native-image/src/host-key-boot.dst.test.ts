import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeRecordingSimulation, runDst } from "../../../apps/control-plane/src/testkit/sim.ts";

const barrierPath = new URL("../../../infra/native-vm/wait-google-host-keys.sh", import.meta.url);
const algorithms = [
  ["ecdsa", "ecdsa-sha2-nistp256"],
  ["ed25519", "ssh-ed25519"],
  ["rsa", "ssh-rsa"],
] as const;

type Probe = () => boolean;

function createFixture(): {
  root: string;
  install(type: string): void;
  publish(algorithm: string): void;
  clockValue(): number;
  probe: Probe;
} {
  const root = mkdtempSync(join(tmpdir(), "pi-orb-host-key-dst-"));
  mkdirSync(join(root, "etc/ssh"), { recursive: true });
  mkdirSync(join(root, "generated"));
  mkdirSync(join(root, "published"));
  for (const [type] of algorithms)
    execFileSync("ssh-keygen", [
      "-q",
      "-t",
      type,
      "-N",
      "",
      "-C",
      "dst-host-key-comment",
      "-f",
      join(root, `generated/${type}`),
    ]);
  const curl = join(root, "curl");
  writeFileSync(
    curl,
    `#!/bin/bash
url="\${!#}"
case "$url" in
  */instance/id) printf validator-instance;;
  *) cat '${root}/published/'"\${url##*/}";;
esac
`,
  );
  chmodSync(curl, 0o755);
  const clock = join(root, "clock");
  const clockValue = join(root, "clock-value");
  writeFileSync(clockValue, "0");
  writeFileSync(clock, `#!/bin/bash\ncat '${clockValue}'\n`);
  chmodSync(clock, 0o755);
  const sleep = join(root, "sleep");
  writeFileSync(sleep, `#!/bin/bash\nprintf 90 >'${clockValue}'\n`);
  chmodSync(sleep, 0o755);
  let version = 0;
  let probedVersion = -1;
  let probeResult = false;
  return {
    root,
    install(type) {
      copyFileSync(join(root, `generated/${type}`), join(root, `etc/ssh/ssh_host_${type}_key`));
      copyFileSync(
        join(root, `generated/${type}.pub`),
        join(root, `etc/ssh/ssh_host_${type}_key.pub`),
      );
      version++;
    },
    publish(algorithm) {
      const type = algorithms.find((entry) => entry[1] === algorithm)?.[0];
      if (type === undefined) throw new Error(`unknown algorithm ${algorithm}`);
      const key = readFileSync(join(root, `generated/${type}.pub`), "utf8").split(/\s+/)[1];
      writeFileSync(join(root, "published", algorithm), key as string);
      version++;
    },
    clockValue() {
      return Number(readFileSync(clockValue, "utf8"));
    },
    probe() {
      if (probedVersion === version) return probeResult;
      probedVersion = version;
      writeFileSync(clockValue, "0");
      try {
        execFileSync("bash", [barrierPath.pathname], {
          env: {
            ...process.env,
            PI_ORB_ROOT: root,
            PI_ORB_CURL: curl,
            PI_ORB_CLOCK: clock,
            PI_ORB_SLEEP: sleep,
          },
          stdio: "ignore",
        });
        probeResult = true;
      } catch {
        probeResult = false;
      }
      return probeResult;
    },
  };
}

async function scenario(
  sim: Parameters<Parameters<typeof runDst>[1]>[0],
  fixture: ReturnType<typeof createFixture>,
  probe: Probe,
): Promise<void> {
  let earlyReady = false;
  let googleDone = false;
  let presented: string | undefined;
  let pinned: string | undefined;

  expect(probe(), "an empty first-boot snapshot must not open SSH").toBe(false);
  const result = await sim.runTasks([
    {
      name: "manager-early-ready",
      f: async (task) => {
        await task.checkpoint("google", "manager-early-initialization");
        earlyReady = true;
      },
    },
    {
      name: "google-late-first-boot",
      f: async (task) => {
        while (!earlyReady) await task.checkpoint("google", "wait-early-ready");
        writeFileSync(join(fixture.root, "etc/google_instance_id"), "validator-instance\n");
        // Installing the first key below advances the fixture snapshot.
        await task.checkpoint("google", "late-write-instance-id-before-keys");
        for (const [type, algorithm] of algorithms) {
          fixture.install(type);
          await task.checkpoint("google", `late-generate-${type}`);
          fixture.publish(algorithm);
          await task.checkpoint("google", `late-publish-${algorithm}`);
        }
        googleDone = true;
      },
    },
    {
      name: "oslogin-ssh-reload",
      f: async (task) => {
        while (!earlyReady) await task.checkpoint("oslogin", "wait-early-ready");
        await task.checkpoint("oslogin", "reload-or-restart-ssh");
      },
    },
    {
      name: "readiness-and-probe",
      f: async (task) => {
        while (!earlyReady) await task.checkpoint("validator", "wait-systemd-before-ssh");
        while (!probe()) await task.checkpoint("validator", "wait-google-host-key-effects");
        await task.checkpoint("validator", "ssh-ready");
        const publicKey = readFileSync(
          join(fixture.root, "etc/ssh/ssh_host_ed25519_key.pub"),
          "utf8",
        );
        presented = publicKey.split(/\s+/)[1];
        pinned = readFileSync(join(fixture.root, "published/ssh-ed25519"), "utf8");
        await task.checkpoint("validator", "acceptance-probe");
      },
    },
  ]);
  if (result.isErr()) throw result.error;
  expect(googleDone).toBe(true);
  expect(presented).toBeDefined();
  expect(pinned).toBe(presented);
  expect(fixture.clockValue(), "successful probe must not need the timeout clock").toBe(0);
}

describe("native validator first-boot SSH identity (DST)", () => {
  it("executes the production barrier across late per-key publication schedules", async () => {
    const roots: string[] = [];
    try {
      await runDst({ name: "native-validator-host-key-stability", iterations: 50 }, async (sim) => {
        const fixture = createFixture();
        roots.push(fixture.root);
        await scenario(sim, fixture, fixture.probe);
      });
    } finally {
      for (const root of roots) rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it("times out an incomplete production probe only through the fake sleep", () => {
    const fixture = createFixture();
    try {
      writeFileSync(join(fixture.root, "etc/google_instance_id"), "validator-instance\n");
      fixture.install("ecdsa");
      fixture.publish("ecdsa-sha2-nistp256");
      expect(fixture.clockValue()).toBe(0);
      expect(fixture.probe()).toBe(false);
      expect(fixture.clockValue()).toBe(90);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects an always-success barrier even if its source has expected marker strings", async () => {
    const fixture = createFixture();
    try {
      const invalid = Object.assign(() => true, {
        source: "google_instance_id ecdsa-sha2-nistp256 ssh-ed25519 ssh-rsa",
      });
      await expect(
        scenario(makeRecordingSimulation({ name: "invalid-host-key-barrier" }), fixture, invalid),
      ).rejects.toThrow("empty first-boot snapshot");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
