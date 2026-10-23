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
import { beforeAll, describe, expect, it } from "vitest";
import { runDst } from "../../../apps/control-plane/src/testkit/sim.ts";
import { withDstArtifacts } from "../../../testkit/dst-artifacts.ts";
import { hostKeyAlgorithms as algorithms, generateHostKeyPairs } from "./testkit/host-key-pairs.ts";

const barrierPath = new URL("../../../infra/native-vm/wait-google-host-keys.sh", import.meta.url);

interface GoogleGuest {
  writeInstanceId(): void;
  install(type: string): void;
  publish(algorithm: string): void;
}

// Google's late first-boot effects in order; each prefix is one barrier input state.
const googleSteps: readonly { checkpoint: string; apply(guest: GoogleGuest): void }[] = [
  { checkpoint: "late-write-instance-id-before-keys", apply: (guest) => guest.writeInstanceId() },
  ...algorithms.flatMap(([type, algorithm]) => [
    { checkpoint: `late-generate-${type}`, apply: (guest: GoogleGuest) => guest.install(type) },
    {
      checkpoint: `late-publish-${algorithm}`,
      apply: (guest: GoogleGuest) => guest.publish(algorithm),
    },
  ]),
];

type BarrierResult = { ready: boolean; clock: number };
type BarrierTable = ReadonlyMap<string, BarrierResult>;

// Real production-barrier result per state, keyed by the last applied Google step.
let barrierTable: BarrierTable;
let publicKeys: Map<string, string>;

function algorithmType(algorithm: string): string {
  const type = algorithms.find((entry) => entry[1] === algorithm)?.[0];
  if (type === undefined) throw new Error(`unknown algorithm ${algorithm}`);
  return type;
}

function createFixture(keyPairs: ReturnType<typeof generateHostKeyPairs>) {
  const root = mkdtempSync(join(tmpdir(), "pi-orb-host-key-dst-"));
  mkdirSync(join(root, "etc/ssh"), { recursive: true });
  mkdirSync(join(root, "generated"));
  mkdirSync(join(root, "published"));
  keyPairs.copyTo(join(root, "generated"));
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
  writeFileSync(clock, `#!/bin/bash\ncat '${clockValue}'\n`);
  chmodSync(clock, 0o755);
  const sleep = join(root, "sleep");
  writeFileSync(sleep, `#!/bin/bash\nprintf 90 >'${clockValue}'\n`);
  chmodSync(sleep, 0o755);
  const publicKey = (type: string) =>
    readFileSync(join(root, `generated/${type}.pub`), "utf8").split(/\s+/)[1] as string;
  const guest: GoogleGuest = {
    writeInstanceId() {
      writeFileSync(join(root, "etc/google_instance_id"), "validator-instance\n");
    },
    install(type) {
      copyFileSync(join(root, `generated/${type}`), join(root, `etc/ssh/ssh_host_${type}_key`));
      copyFileSync(
        join(root, `generated/${type}.pub`),
        join(root, `etc/ssh/ssh_host_${type}_key.pub`),
      );
    },
    publish(algorithm) {
      writeFileSync(join(root, "published", algorithm), publicKey(algorithmType(algorithm)));
    },
  };
  return {
    root,
    guest,
    publicKeys: new Map(algorithms.map(([type]) => [type, publicKey(type)])),
    probe(): BarrierResult {
      writeFileSync(clockValue, "0");
      let ready = true;
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
      } catch {
        ready = false;
      }
      return { ready, clock: Number(readFileSync(clockValue, "utf8")) };
    },
  };
}

beforeAll(() => {
  const keyPairs = generateHostKeyPairs(() => {});
  const fixture = createFixture(keyPairs);
  try {
    publicKeys = fixture.publicKeys;
    const table = new Map([["empty", fixture.probe()]]);
    for (const step of googleSteps) {
      step.apply(fixture.guest);
      table.set(step.checkpoint, fixture.probe());
    }
    barrierTable = table;
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    keyPairs.dispose();
  }
});

async function scenario(
  sim: Parameters<Parameters<typeof runDst>[1]>[0],
  table: BarrierTable,
): Promise<{ total: number; successful: number }> {
  let state = "empty";
  let clock = 0;
  let total = 0;
  let successful = 0;
  const installed = new Map<string, string>();
  const published = new Map<string, string>();
  const guest: GoogleGuest = {
    writeInstanceId() {},
    install(type) {
      installed.set(type, publicKeys.get(type) as string);
    },
    publish(algorithm) {
      published.set(algorithm, publicKeys.get(algorithmType(algorithm)) as string);
    },
  };
  const probe = () => {
    const result = table.get(state);
    if (result === undefined) throw new Error(`unverified barrier state ${state}`);
    total++;
    if (result.ready) successful++;
    clock = result.clock;
    return result.ready;
  };
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
        for (const step of googleSteps) {
          step.apply(guest);
          state = step.checkpoint;
          await task.checkpoint("google", step.checkpoint);
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
        presented = installed.get("ed25519");
        pinned = published.get("ssh-ed25519");
        await task.checkpoint("validator", "acceptance-probe");
      },
    },
  ]);
  if (result.isErr()) throw result.error;
  expect(googleDone).toBe(true);
  expect(presented).toBeDefined();
  expect(pinned).toBe(presented);
  expect(clock, "successful probe must not need the timeout clock").toBe(0);
  return { total, successful };
}

describe("native validator first-boot SSH identity (DST)", () => {
  it("runs the production barrier once per reachable Google first-boot state", () => {
    const closed = { ready: false, clock: 90 };
    expect([...barrierTable]).toEqual([
      ["empty", closed],
      ["late-write-instance-id-before-keys", closed],
      ["late-generate-ecdsa", closed],
      ["late-publish-ecdsa-sha2-nistp256", closed],
      ["late-generate-ed25519", closed],
      ["late-publish-ssh-ed25519", closed],
      ["late-generate-rsa", closed],
      ["late-publish-ssh-rsa", { ready: true, clock: 0 }],
    ]);
  });

  it("explores late per-key publication schedules against the verified barrier table", async ({
    signal,
  }) => {
    let schedules = 0;
    await runDst(
      { name: "native-validator-host-key-stability", iterations: 50, signal },
      async (sim) => {
        const counts = await scenario(sim, barrierTable);
        expect(counts.total).toBeGreaterThanOrEqual(2);
        expect(counts.successful).toBe(1);
        schedules++;
      },
    );
    expect(schedules).toBe(process.env["DST_REPLAY"] ? 1 : 50);
  });

  it("rejects a barrier that opens on an empty first-boot snapshot", async () =>
    withDstArtifacts(async () => {
      const alwaysReady = new Map(
        [...barrierTable.keys()].map((state) => [state, { ready: true, clock: 0 }]),
      );
      await expect(
        runDst({ name: "invalid-host-key-barrier", iterations: 1 }, async (sim) => {
          await scenario(sim, alwaysReady);
        }),
      ).rejects.toThrow("empty first-boot snapshot");
    }));
});
