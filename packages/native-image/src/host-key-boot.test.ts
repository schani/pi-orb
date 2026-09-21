import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const sealPath = new URL("../../../infra/native-vm/seal.sh", import.meta.url);
const barrierPath = new URL("../../../infra/native-vm/wait-google-host-keys.sh", import.meta.url);
const verifierPath = new URL(
  "../../../infra/native-vm/verify-google-host-key-owner.sh",
  import.meta.url,
);
const execute = promisify(execFile);

async function withFixture(run: (fixture: HostKeyFixture) => Promise<void>): Promise<void> {
  const fixture = await HostKeyFixture.create();
  try {
    await run(fixture);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

class HostKeyFixture {
  readonly root: string;
  readonly keys: Readonly<Record<string, string>>;

  private constructor(root: string, keys: Readonly<Record<string, string>>) {
    this.root = root;
    this.keys = keys;
  }

  static async create(): Promise<HostKeyFixture> {
    const root = await mkdtemp(join(tmpdir(), "pi-orb-host-key-test-"));
    await mkdir(join(root, "etc/ssh"), { recursive: true });
    await mkdir(join(root, "published"));
    await writeFile(join(root, "etc/google_instance_id"), "12345\n");
    for (const type of ["ecdsa", "ed25519", "rsa"])
      await execute("ssh-keygen", [
        "-q",
        "-t",
        type,
        "-N",
        "",
        "-C",
        "host-key-test-comment",
        "-f",
        join(root, `etc/ssh/ssh_host_${type}_key`),
      ]);
    const keys: Record<string, string> = {};
    for (const [algorithm, type] of [
      ["ecdsa-sha2-nistp256", "ecdsa"],
      ["ssh-ed25519", "ed25519"],
      ["ssh-rsa", "rsa"],
    ] as const) {
      keys[algorithm] = (
        await readFile(join(root, `etc/ssh/ssh_host_${type}_key.pub`), "utf8")
      ).split(/\s+/)[1] as string;
    }
    const fixture = new HostKeyFixture(root, keys);
    await fixture.publishAll();
    await fixture.writeCurl();
    return fixture;
  }

  async publishAll(): Promise<void> {
    for (const [algorithm, key] of Object.entries(this.keys))
      await writeFile(join(this.root, "published", algorithm), key);
  }

  async writeCurl(options: { delayRounds?: number; expireAfterRsa?: boolean } = {}): Promise<void> {
    const script = join(this.root, "curl");
    await writeFile(
      script,
      `#!/bin/bash
url="\${!#}"
case "$url" in
  */instance/id)
    round=$(cat '${this.root}/round')
    round=$((round + 1))
    printf %s "$round" >'${this.root}/round'
    printf 12345
    ;;
  *)
    round=$(cat '${this.root}/round')
    test "$round" -gt ${options.delayRounds ?? 0} || exit 1
    algorithm=\${url##*/}
    cat '${this.root}/published/'"$algorithm"
    ${options.expireAfterRsa ? `test "$algorithm" != ssh-rsa || printf 90 >'${this.root}/clock'` : ""}
    ;;
esac
`,
      { mode: 0o755 },
    );
  }

  async run(options: { advancingClock?: boolean } = {}) {
    await writeFile(join(this.root, "round"), "0");
    const clock = join(this.root, "clock-command");
    await writeFile(
      clock,
      options.advancingClock
        ? `#!/bin/bash
value=$(cat '${this.root}/clock')
value=$((value + 45))
printf %s "$value" >'${this.root}/clock'
printf %s "$value"
`
        : `#!/bin/bash
cat '${this.root}/clock'
`,
      { mode: 0o755 },
    );
    await writeFile(join(this.root, "clock"), "0");
    return execute("bash", [barrierPath.pathname], {
      env: {
        ...process.env,
        PI_ORB_ROOT: this.root,
        PI_ORB_CURL: join(this.root, "curl"),
        PI_ORB_CLOCK: clock,
        PI_ORB_SLEEP: ":",
      },
    });
  }
}

async function expectClosed(run: Promise<unknown>): Promise<void> {
  await expect(run).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining("did not become ready within 90 seconds"),
  });
}

describe("native image SSH host-key boot contract", () => {
  it("selects the inspected Google manager as the only producer and gates SSH", async () => {
    const seal = await readFile(sealPath, "utf8");
    const barrier = await readFile(barrierPath, "utf8");
    expect(`${seal}\n${barrier}`).not.toMatch(/ssh-keygen\s+-A/);
    expect(seal).toContain("verify-google-host-key-owner.sh");
    expect(seal).toContain("pi-orb-host-key-ready.service");
    expect(barrier).toContain("/etc/google_instance_id");
    expect(seal).toMatch(/Requires=pi-orb-host-key-ready\.service/);
    expect(seal).toMatch(/After=pi-orb-host-key-ready\.service/);
    expect(seal).toContain(
      "systemd-analyze --man=no verify pi-orb-host-key-ready.service ssh.service",
    );
  });

  it("checks effective manager properties rather than vendor unit text", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-orb-host-key-verifier-"));
    try {
      const bin = join(root, "bin");
      await mkdir(bin);
      await writeFile(join(bin, "dpkg-query"), "#!/bin/bash\nprintf %s 1:20260715.00-g1\n", {
        mode: 0o755,
      });
      await writeFile(
        join(bin, "systemctl"),
        `#!/bin/bash
case "$*" in
  *'-p Type --value') printf %s notify;;
  *'-p Before --value') printf %s "\${BEFORE:-ssh.service sshd.service}";;
  *'-p ExecStart --value') printf %s "\${EXEC_START:-{ path=/usr/bin/google_guest_agent_manager ; argv[]=/usr/bin/google_guest_agent_manager ; }}";;
  'is-enabled google-guest-agent-manager.service') printf %s enabled;;
  'is-enabled google-guest-agent.service') printf %s disabled;;
  *) exit 2;;
esac
`,
        { mode: 0o755 },
      );
      const run = (env: NodeJS.ProcessEnv = {}) =>
        execute("bash", [verifierPath.pathname], {
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env },
        });
      await expect(run()).resolves.toBeDefined();
      await expect(run({ BEFORE: "ssh.service" })).rejects.toMatchObject({ code: 1 });
      await expect(
        run({ EXEC_START: "{ path=/usr/bin/overridden ; argv[]=/usr/bin/overridden ; }" }),
      ).rejects.toMatchObject({ code: 1 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("waits past 20 polls and preserves public-key comments", async () => {
    await withFixture(async (fixture) => {
      await fixture.writeCurl({ delayRounds: 30 });
      const result = await fixture.run();
      expect(result.stdout).toMatch(/ready fingerprint=SHA256:/);
      expect(Number(await readFile(join(fixture.root, "round"), "utf8"))).toBeGreaterThan(20);
    });
  });

  it.each([
    [
      "mismatched instance ID",
      async (fixture: HostKeyFixture) =>
        writeFile(join(fixture.root, "etc/google_instance_id"), "wrong\n"),
    ],
    [
      "missing public key",
      async (fixture: HostKeyFixture) => rm(join(fixture.root, "etc/ssh/ssh_host_ed25519_key.pub")),
    ],
    [
      "partial publication",
      async (fixture: HostKeyFixture) => rm(join(fixture.root, "published/ssh-rsa")),
    ],
    [
      "algorithm in the wrong namespace",
      async (fixture: HostKeyFixture) => {
        await cp(
          join(fixture.root, "etc/ssh/ssh_host_rsa_key"),
          join(fixture.root, "etc/ssh/ssh_host_ed25519_key"),
        );
        await cp(
          join(fixture.root, "etc/ssh/ssh_host_rsa_key.pub"),
          join(fixture.root, "etc/ssh/ssh_host_ed25519_key.pub"),
        );
        await writeFile(
          join(fixture.root, "published/ssh-ed25519"),
          fixture.keys["ssh-rsa"] as string,
        );
      },
    ],
  ])("keeps SSH closed for %s", async (_name, arrange) => {
    await withFixture(async (fixture) => {
      await arrange(fixture);
      await expectClosed(fixture.run({ advancingClock: true }));
    });
  });

  it("does not open when metadata requests consume the deadline", async () => {
    await withFixture(async (fixture) => {
      await fixture.writeCurl({ expireAfterRsa: true });
      await expectClosed(fixture.run());
    });
  });
});
