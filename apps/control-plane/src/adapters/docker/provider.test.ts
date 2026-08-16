import {
  CONTROL_PLANE_URL_ENV,
  PREVIEW_HOST_ENV,
  RUNTIME_TOKEN_ENV,
  TAILSCALE_AUTH_KEY_ENV,
  TAILSCALE_HOSTNAME_ENV,
} from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import { errAsync, okAsync } from "neverthrow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TailscaleError } from "../../domain/errors.ts";
import type { TailscaleAuthKeyMinter } from "../tailscale/client.ts";
import { DockerOrbHostProvider, publishedRuntimePort } from "./provider.ts";

interface DockerReply {
  readonly stdout?: string;
  readonly error?: string;
}

/**
 * Scripted `docker` CLI: every invocation is recorded and answered by the
 * handler the test installs. Hoisted so the `vi.mock` factory can reach it.
 */
const dockerFake = vi.hoisted(() => {
  const calls: string[][] = [];
  let handler: ((args: string[]) => { stdout?: string; error?: string }) | null = null;
  return {
    calls,
    install(next: (args: string[]) => { stdout?: string; error?: string }): void {
      handler = next;
    },
    reset(): void {
      calls.length = 0;
      handler = null;
    },
    run(args: string[]): { stdout?: string; error?: string } {
      calls.push(args);
      if (handler === null) return { error: `unscripted docker ${args.join(" ")}` };
      return handler(args);
    },
  };
});

vi.mock("node:child_process", () => ({
  execFile: (
    _file: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ): void => {
    const reply: DockerReply = dockerFake.run(args);
    if (reply.error !== undefined) callback(new Error(reply.error), "", reply.error);
    else callback(null, reply.stdout ?? "", "");
  },
}));

const task = new NoSimulationTask("docker test", false);
const context = { signal: new AbortController().signal };
const request = {
  orbId: "orb-1",
  incarnation: 0,
  bootstrap: { repositoryUrl: "https://github.com/o/r" },
};

interface ProviderOverrides {
  readonly image?: string;
  readonly network?: string;
  readonly controlPlaneUrl?: string;
  readonly extraEnv?: Readonly<Record<string, string>>;
  readonly specGeneration?: number;
  readonly tailscale?: { minter: TailscaleAuthKeyMinter; tailnetDnsName: string };
}

function makeProvider(overrides: ProviderOverrides = {}): DockerOrbHostProvider {
  return new DockerOrbHostProvider({
    image: "pi-orb-runtime:dev",
    network: "pi-orb",
    controlPlanePort: 3000,
    ...overrides,
  });
}

/** Scripts a fresh (no existing container) provision against the CLI fake. */
function installFreshHost(): void {
  dockerFake.install((args) => {
    if (args[0] === "inspect") return { error: "docker inspect: No such object: pi-orb-orb-1" };
    if (args[0] === "volume") return { stdout: "pi-orb-data-orb-1\n" };
    if (args[0] === "run") return { stdout: "deadbeef\n" };
    return { error: `unexpected docker ${args[0]}` };
  });
}

/** Provisions a fresh orb against the scripted CLI and returns the `run` argv. */
async function provisionArgv(provider: DockerOrbHostProvider): Promise<string[]> {
  installFreshHost();
  const result = await provider.provision(task, request, context);
  expect(result.isOk(), JSON.stringify(result)).toBe(true);
  const run = dockerFake.calls.find((args) => args[0] === "run");
  expect(run).toBeDefined();
  return run ?? [];
}

/** The value of `--env NAME=…` in a `docker run` argv. */
function envValue(argv: string[], name: string): string | null {
  for (let index = 0; index < argv.length - 1; index += 1) {
    const entry = argv[index + 1];
    if (argv[index] === "--env" && entry !== undefined && entry.startsWith(`${name}=`)) {
      return entry.slice(name.length + 1);
    }
  }
  return null;
}

/** A `docker inspect` payload for a running orb container. */
function inspectPayload(networkSettings: Record<string, unknown>): string {
  return JSON.stringify([
    {
      Config: {
        Labels: { "pi-orb.orb-id": "orb-1" },
        Env: [`${RUNTIME_TOKEN_ENV}=tok`],
      },
      State: { Status: "running" },
      NetworkSettings: networkSettings,
    },
  ]);
}

const withLoopbackMapping = {
  Ports: {
    "8080/tcp": [
      { HostIp: "0.0.0.0", HostPort: "55000" },
      { HostIp: "::", HostPort: "55000" },
    ],
  },
  Networks: { "pi-orb": { IPAddress: "172.20.0.5" } },
};

const withoutMapping = {
  Ports: {},
  Networks: { "pi-orb": { IPAddress: "172.20.0.5" } },
};

const withoutMappingOrIp = { Ports: {}, Networks: { "pi-orb": { IPAddress: "" } } };

const ref = { provider: "docker", resourceId: "pi-orb-orb-1" };

const minterReturning = (key: string): TailscaleAuthKeyMinter => ({
  mintAuthKey: () => okAsync(key),
});

const minterFailing = (error: TailscaleError): TailscaleAuthKeyMinter => ({
  mintAuthKey: () => errAsync(error),
});

const tailnet = { tailnetDnsName: "tailnet.ts.net" };

describe("DockerOrbHostProvider", () => {
  beforeEach(() => {
    dockerFake.reset();
  });

  it("uses incarnation-specific compute identity when creating", async () => {
    const run = await provisionArgv(makeProvider());
    expect(run.slice(run.indexOf("--name"), run.indexOf("--name") + 2)).toEqual([
      "--name",
      "pi-orb-orb-1-i0",
    ]);
    expect(run).toContain("pi-orb.host-incarnation=0");
  });

  it("publishes the runtime port on an ephemeral loopback port when creating", async () => {
    const run = await provisionArgv(makeProvider());
    const publishIndex = run.indexOf("--publish");
    expect(publishIndex).toBeGreaterThan(-1);
    expect(run[publishIndex + 1]).toBe("127.0.0.1:0:8080");
  });

  it("puts HOME on the persistent orb volume", async () => {
    const run = await provisionArgv(makeProvider());
    expect(envValue(run, "HOME")).toBe("/workspace/home");
    expect(run).toContain("pi-orb-data-orb-1:/workspace");
  });

  it("maps host.docker.internal to the host gateway and brokers through it", async () => {
    const run = await provisionArgv(makeProvider());
    expect(run).toContain("--add-host=host.docker.internal:host-gateway");
    expect(envValue(run, CONTROL_PLANE_URL_ENV)).toBe("http://host.docker.internal:3000");
    // The gateway inspection this replaced is gone.
    expect(dockerFake.calls.some((args) => args[0] === "network")).toBe(false);
  });

  it("keeps a configured control-plane URL verbatim", async () => {
    const run = await provisionArgv(makeProvider({ controlPlaneUrl: "https://broker.example" }));
    expect(envValue(run, CONTROL_PLANE_URL_ENV)).toBe("https://broker.example");
  });

  it("observes the published loopback mapping as the runtime address", async () => {
    dockerFake.install(() => ({ stdout: inspectPayload(withLoopbackMapping) }));
    const provider = makeProvider();
    const observed = await provider.observe(task, ref, context);
    expect(observed.isOk() && observed.value?.state).toBe("running");
    expect(observed.isOk() && observed.value?.runtimeAddress?.baseUrl).toBe(
      "http://127.0.0.1:55000",
    );
  });

  it("prefers an explicit 127.0.0.1 binding over other host IPs", async () => {
    dockerFake.install(() => ({
      stdout: inspectPayload({
        Ports: {
          "8080/tcp": [
            { HostIp: "::", HostPort: "49999" },
            { HostIp: "127.0.0.1", HostPort: "55001" },
          ],
        },
        Networks: { "pi-orb": { IPAddress: "172.20.0.5" } },
      }),
    }));
    const provider = makeProvider();
    const observed = await provider.observe(task, ref, context);
    expect(observed.isOk() && observed.value?.runtimeAddress?.baseUrl).toBe(
      "http://127.0.0.1:55001",
    );
  });

  it("falls back to the bridge IP when no mapping is published", async () => {
    dockerFake.install(() => ({ stdout: inspectPayload(withoutMapping) }));
    const provider = makeProvider();
    const observed = await provider.observe(task, ref, context);
    expect(observed.isOk() && observed.value?.runtimeAddress?.baseUrl).toBe(
      "http://172.20.0.5:8080",
    );
  });

  it("falls back to the container name when there is neither mapping nor bridge IP", async () => {
    dockerFake.install(() => ({ stdout: inspectPayload(withoutMappingOrIp) }));
    const provider = makeProvider();
    const observed = await provider.observe(task, ref, context);
    expect(observed.isOk() && observed.value?.runtimeAddress?.baseUrl).toBe(
      "http://pi-orb-orb-1-i0:8080",
    );
  });

  it("provision never starts an existing container carrying a different incarnation", async () => {
    dockerFake.install((args) => {
      if (args[0] === "inspect") {
        return {
          stdout: JSON.stringify([
            {
              Name: "/pi-orb-orb-1-i0",
              Config: {
                Labels: {
                  "pi-orb.orb-id": "orb-1",
                  "pi-orb.host-incarnation": "1",
                },
                Env: [`${RUNTIME_TOKEN_ENV}=tok`],
              },
              State: { Status: "exited" },
              NetworkSettings: {},
            },
          ]),
        };
      }
      return { error: `unexpected docker ${args.join(" ")}` };
    });
    const result = await makeProvider().provision(task, request, context);
    expect(result.isErr() && result.error.code).toBe("conflict");
    // The stamp is checked before any state change: no `docker start`.
    expect(dockerFake.calls.some((args) => args[0] === "start")).toBe(false);
  });

  it("provision never starts an existing container carrying a stale host spec", async () => {
    // Regression: the spec stamp is checked on the same footing as the
    // incarnation, *before* any `docker start`. Resurrecting a stale-spec
    // container in place is exactly the mutation this design forbids
    // (docs/compute-replacement.md).
    dockerFake.install((args) => {
      if (args[0] === "inspect") {
        return {
          stdout: JSON.stringify([
            {
              Name: "/pi-orb-orb-1-i0",
              Config: {
                Labels: {
                  "pi-orb.orb-id": "orb-1",
                  "pi-orb.host-incarnation": "0",
                  "pi-orb.host-spec-fingerprint": "stale-fingerprint",
                },
                Env: [`${RUNTIME_TOKEN_ENV}=tok`],
              },
              State: { Status: "exited" },
              NetworkSettings: {},
            },
          ]),
        };
      }
      return { error: `unexpected docker ${args.join(" ")}` };
    });
    const result = await makeProvider().provision(task, request, context);
    expect(result.isErr() && result.error.code).toBe("conflict");
    expect(result.isErr() && result.error.retryable).toBe(false);
    expect(dockerFake.calls.some((args) => args[0] === "start")).toBe(false);
  });

  it("provision never starts a legacy unstamped container when a spec is expected", async () => {
    dockerFake.install((args) => {
      if (args[0] === "inspect") {
        return {
          stdout: JSON.stringify([
            {
              Name: "/pi-orb-orb-1-i0",
              Config: {
                Labels: { "pi-orb.orb-id": "orb-1", "pi-orb.host-incarnation": "0" },
                Env: [`${RUNTIME_TOKEN_ENV}=tok`],
              },
              State: { Status: "exited" },
              NetworkSettings: {},
            },
          ]),
        };
      }
      return { error: `unexpected docker ${args.join(" ")}` };
    });
    const result = await makeProvider().provision(task, request, context);
    expect(result.isErr() && result.error.code).toBe("conflict");
    expect(result.isErr() && result.error.retryable).toBe(false);
    expect(dockerFake.calls.some((args) => args[0] === "start")).toBe(false);
  });

  it("start refuses a container carrying a different incarnation", async () => {
    dockerFake.install(() => ({
      stdout: JSON.stringify([
        {
          Name: "/pi-orb-orb-1-i1",
          Config: {
            Labels: {
              "pi-orb.orb-id": "orb-1",
              "pi-orb.host-incarnation": "1",
            },
          },
          State: { Status: "stopped" },
        },
      ]),
    }));
    const result = await makeProvider().start(
      task,
      {
        ref: { provider: "docker", resourceId: "pi-orb-orb-1-i1" },
        expectedIncarnation: 0,
        expectedSpecFingerprint: "irrelevant-after-incarnation-mismatch",
      },
      context,
    );
    expect(result.isErr() && result.error.code).toBe("conflict");
    expect(dockerFake.calls).toHaveLength(1);
  });

  it("applies the same address derivation when listing managed hosts", async () => {
    dockerFake.install((args) => {
      if (args[0] === "ps") return { stdout: "pi-orb-orb-1\npi-orb-orb-2\n" };
      if (args[0] === "inspect" && args[3] === "pi-orb-orb-1") {
        return { stdout: inspectPayload(withLoopbackMapping) };
      }
      return { stdout: inspectPayload(withoutMapping) };
    });
    const provider = makeProvider();
    const listed = await provider.listManagedHosts(task, context);
    expect(listed.isOk() && listed.value.length).toBe(2);
    if (listed.isOk()) {
      expect(listed.value[0]?.runtimeAddress?.baseUrl).toBe("http://127.0.0.1:55000");
      expect(listed.value[1]?.runtimeAddress?.baseUrl).toBe("http://172.20.0.5:8080");
    }
  });

  it("captures bounded container status, restart count, and exit code before discard", async () => {
    dockerFake.install(() => ({
      stdout: JSON.stringify([
        {
          Name: "/pi-orb-orb-1-i0",
          Config: {
            Labels: {
              "pi-orb.orb-id": "orb-1",
              "pi-orb.host-incarnation": "0",
            },
          },
          State: { Status: "restarting", RestartCount: 7, ExitCode: 42 },
          RestartCount: 7,
        },
      ]),
    }));
    const diagnosis = await makeProvider().diagnose(task, ref, context);
    expect(diagnosis.isOk() && diagnosis.value).toBe(
      "container_status=restarting restart_count=7 exit_code=42",
    );
  });

  it("reads the published port defensively", () => {
    expect(publishedRuntimePort({})).toBeNull();
    expect(publishedRuntimePort({ NetworkSettings: { Ports: { "8080/tcp": null } } })).toBeNull();
    expect(
      publishedRuntimePort({ NetworkSettings: { Ports: { "9090/tcp": [{ HostPort: "1" }] } } }),
    ).toBeNull();
    expect(
      publishedRuntimePort({ NetworkSettings: { Ports: { "8080/tcp": [{ HostPort: 55_000 }] } } }),
    ).toBeNull();
    expect(
      publishedRuntimePort({
        NetworkSettings: { Ports: { "8080/tcp": [{ HostIp: "", HostPort: "55002" }] } },
      }),
    ).toBe("55002");
  });
});

describe("DockerOrbHostProvider deletion", () => {
  beforeEach(() => dockerFake.reset());

  it("discards only exact-orb containers through the incarnation fence", async () => {
    const payload = (orbId: string, incarnation?: number): string =>
      JSON.stringify([
        {
          Name: `/pi-orb-${orbId}${incarnation === undefined ? "" : `-i${incarnation}`}`,
          Config: {
            Labels: {
              "pi-orb.orb-id": orbId,
              ...(incarnation === undefined
                ? {}
                : { "pi-orb.host-incarnation": String(incarnation) }),
            },
          },
          State: { Status: "stopped" },
        },
      ]);
    dockerFake.install((args) => {
      if (args[0] === "ps") {
        return {
          stdout: "pi-orb-orb-1\npi-orb-orb-1-i0\npi-orb-orb-1-i1\npi-orb-orb-1-i2\n",
        };
      }
      if (args[0] === "inspect") {
        const name = args[3];
        if (name === "pi-orb-orb-1") return { stdout: payload("orb-1") };
        const incarnation = Number(name?.slice("pi-orb-orb-1-i".length));
        return { stdout: payload("orb-1", incarnation) };
      }
      if (args[0] === "rm") return { stdout: "" };
      return { error: `unexpected docker ${args.join(" ")}` };
    });
    const result = await makeProvider().discardCompute(
      task,
      { orbId: "orb-1", throughIncarnation: 1 },
      context,
    );
    expect(result.isOk(), JSON.stringify(result)).toBe(true);
    const removed = dockerFake.calls.filter((args) => args[0] === "rm").map((args) => args[2]);
    expect(removed).toEqual(["pi-orb-orb-1", "pi-orb-orb-1-i0", "pi-orb-orb-1-i1"]);
    expect(removed).not.toContain("pi-orb-orb-1-i2");
    expect(dockerFake.calls.some((args) => args[0] === "volume")).toBe(false);
  });

  it("force-removes the container before its persistent volume and is idempotent", async () => {
    dockerFake.install((args) => {
      if (args[0] === "ps") return { stdout: "pi-orb-orb-1-i0\n" };
      if (args[0] === "inspect") {
        return {
          stdout: JSON.stringify([
            {
              Name: "/pi-orb-orb-1-i0",
              Config: {
                Labels: {
                  "pi-orb.orb-id": "orb-1",
                  "pi-orb.host-incarnation": "0",
                },
              },
            },
          ]),
        };
      }
      if (args[0] === "volume" && args[1] === "inspect") {
        return { stdout: JSON.stringify([{ Labels: { "pi-orb.orb-id": "orb-1" } }]) };
      }
      if (args[0] === "rm" || (args[0] === "volume" && args[1] === "rm")) {
        return { stdout: "" };
      }
      return { error: `unexpected docker ${args.join(" ")}` };
    });
    const result = await makeProvider().destroy(task, "orb-1", context);
    expect(result.isOk(), JSON.stringify(result)).toBe(true);
    expect(dockerFake.calls).toEqual([
      ["ps", "--all", "--filter", "label=pi-orb.orb-id=orb-1", "--format", "{{.Names}}"],
      ["inspect", "--type", "container", "pi-orb-orb-1-i0"],
      ["rm", "--force", "pi-orb-orb-1-i0"],
      ["volume", "inspect", "pi-orb-data-orb-1"],
      ["volume", "rm", "--force", "pi-orb-data-orb-1"],
    ]);
  });
  it("destroy removes a container despite an unparseable incarnation label", async () => {
    // Ownership alone authorizes deletion-grade destroy: a mangled
    // incarnation label must not leave the orb permanently undeletable.
    dockerFake.install((args) => {
      if (args[0] === "ps") return { stdout: "pi-orb-orb-1-i0\n" };
      if (args[0] === "inspect") {
        return {
          stdout: JSON.stringify([
            {
              Name: "/pi-orb-orb-1-i0",
              Config: {
                Labels: {
                  "pi-orb.orb-id": "orb-1",
                  "pi-orb.host-incarnation": "not-a-number",
                },
              },
            },
          ]),
        };
      }
      if (args[0] === "volume" && args[1] === "inspect") {
        return { stdout: JSON.stringify([{ Labels: { "pi-orb.orb-id": "orb-1" } }]) };
      }
      if (args[0] === "rm" || (args[0] === "volume" && args[1] === "rm")) {
        return { stdout: "" };
      }
      return { error: `unexpected docker ${args.join(" ")}` };
    });
    const result = await makeProvider().destroy(task, "orb-1", context);
    expect(result.isOk(), JSON.stringify(result)).toBe(true);
    expect(dockerFake.calls).toContainEqual(["rm", "--force", "pi-orb-orb-1-i0"]);
    expect(dockerFake.calls).toContainEqual(["volume", "rm", "--force", "pi-orb-data-orb-1"]);
  });

  it("discard still refuses an unparseable incarnation label", async () => {
    // The fence needs valid incarnations; guessing could delete newer compute.
    dockerFake.install((args) => {
      if (args[0] === "ps") return { stdout: "pi-orb-orb-1-i0\n" };
      if (args[0] === "inspect") {
        return {
          stdout: JSON.stringify([
            {
              Name: "/pi-orb-orb-1-i0",
              Config: {
                Labels: {
                  "pi-orb.orb-id": "orb-1",
                  "pi-orb.host-incarnation": "not-a-number",
                },
              },
            },
          ]),
        };
      }
      return { error: `unexpected docker ${args.join(" ")}` };
    });
    const result = await makeProvider().discardCompute(
      task,
      { orbId: "orb-1", throughIncarnation: 5 },
      context,
    );
    expect(result.isErr() && result.error.code).toBe("conflict");
    expect(dockerFake.calls.some((args) => args[0] === "rm")).toBe(false);
  });

  it("refuses to delete a deterministic-name container without the orb label", async () => {
    dockerFake.install((args) => {
      if (args[0] === "ps") return { stdout: "pi-orb-orb-1-i0\n" };
      if (args[0] === "inspect") {
        return {
          stdout: JSON.stringify([{ Name: "/pi-orb-orb-1-i0", Config: { Labels: {} } }]),
        };
      }
      return { error: `unexpected docker ${args.join(" ")}` };
    });
    const result = await makeProvider().destroy(task, "orb-1", context);
    expect(result.isErr() && result.error.code).toBe("conflict");
    expect(dockerFake.calls).toHaveLength(2);
  });
});

describe("DockerOrbHostProvider host specification", () => {
  beforeEach(() => {
    dockerFake.reset();
  });

  const specInput = { orbId: request.orbId, repositoryUrl: request.bootstrap.repositoryUrl };
  const desired = (overrides: ProviderOverrides = {}): string =>
    makeProvider(overrides).desiredSpecFingerprint(specInput);

  /** A `docker inspect` payload for the orb's incarnation-0 container. */
  function containerPayload(labels: Record<string, string>, status = "running"): string {
    return JSON.stringify([
      {
        Name: "/pi-orb-orb-1-i0",
        Config: {
          Labels: { "pi-orb.orb-id": "orb-1", "pi-orb.host-incarnation": "0", ...labels },
          Env: [`${RUNTIME_TOKEN_ENV}=tok`],
        },
        State: { Status: status },
        NetworkSettings: withoutMapping,
      },
    ]);
  }

  it("is stable for the same launch facts", () => {
    expect(desired()).toBe(desired());
    expect(desired({ extraEnv: { A: "1", B: "2" } })).toBe(
      desired({ extraEnv: { B: "2", A: "1" } }),
    );
  });

  it("changes when any launch fact that requires new compute changes", () => {
    const base = desired();
    expect(desired({ image: "pi-orb-runtime:next" })).not.toBe(base);
    expect(desired({ network: "other-net" })).not.toBe(base);
    expect(desired({ controlPlaneUrl: "https://broker.example" })).not.toBe(base);
    expect(desired({ extraEnv: { OPENAI_BASE_URL: "http://a" } })).not.toBe(base);
    expect(
      makeProvider().desiredSpecFingerprint({ ...specInput, repositoryUrl: "https://other/repo" }),
    ).not.toBe(base);
    const withTailscale = desired({
      tailscale: { minter: minterReturning("tskey-auth-abc"), ...tailnet },
    });
    expect(withTailscale).not.toBe(base);
  });

  it("changes when an extraEnv value changes, not just its key set", () => {
    expect(desired({ extraEnv: { OPENAI_BASE_URL: "http://a" } })).not.toBe(
      desired({ extraEnv: { OPENAI_BASE_URL: "http://b" } }),
    );
  });

  it("does not change with the spec generation alone", () => {
    // The generation is a rollover fence, not part of the specification:
    // bumping it must never replace every orb's compute.
    expect(desired({ specGeneration: 7 })).toBe(desired({ specGeneration: 0 }));
    expect(makeProvider({ specGeneration: 7 }).specGeneration).toBe(7);
  });

  /** The value of `--label NAME=…` in a `docker run` argv. */
  function labelValue(argv: string[], name: string): string | null {
    for (let index = 0; index < argv.length - 1; index += 1) {
      const entry = argv[index + 1];
      if (argv[index] === "--label" && entry !== undefined && entry.startsWith(`${name}=`)) {
        return entry.slice(name.length + 1);
      }
    }
    return null;
  }

  it("stamps the desired fingerprint on the container it creates", async () => {
    const provider = makeProvider();
    const run = await provisionArgv(provider);
    expect(labelValue(run, "pi-orb.host-spec-fingerprint")).toBe(
      provider.desiredSpecFingerprint(specInput),
    );
  });

  it("reports the container's stamp in observations", async () => {
    dockerFake.install(() => ({
      stdout: containerPayload({ "pi-orb.host-spec-fingerprint": "fingerprint-abc" }),
    }));
    const observed = await makeProvider().observe(task, ref, context);
    expect(observed.isOk() && observed.value?.specFingerprint).toBe("fingerprint-abc");
  });

  it("observes a legacy unstamped container as having no fingerprint", async () => {
    dockerFake.install(() => ({ stdout: containerPayload({}) }));
    const observed = await makeProvider().observe(task, ref, context);
    expect(observed.isOk(), JSON.stringify(observed)).toBe(true);
    expect(observed.isOk() && observed.value !== null).toBe(true);
    expect(observed.isOk() && observed.value?.specFingerprint).toBeNull();
  });

  it("round-trips the provisioned stamp through observation", async () => {
    const provider = makeProvider({ image: "pi-orb-runtime:next" });
    const run = await provisionArgv(provider);
    const stamped = labelValue(run, "pi-orb.host-spec-fingerprint") ?? "";
    dockerFake.reset();
    dockerFake.install(() => ({
      stdout: containerPayload({ "pi-orb.host-spec-fingerprint": stamped }),
    }));
    const observed = await provider.observe(task, ref, context);
    expect(observed.isOk() && observed.value?.specFingerprint).toBe(
      provider.desiredSpecFingerprint(specInput),
    );
  });

  it("start refuses a container whose stamp differs from the expectation", async () => {
    dockerFake.install(() => ({
      stdout: containerPayload({ "pi-orb.host-spec-fingerprint": "old-fingerprint" }, "exited"),
    }));
    const result = await makeProvider().start(
      task,
      { ref, expectedIncarnation: 0, expectedSpecFingerprint: "new-fingerprint" },
      context,
    );
    expect(result.isErr() && result.error.code).toBe("conflict");
    expect(result.isErr() && result.error.retryable).toBe(false);
    expect(dockerFake.calls.some((args) => args[0] === "start")).toBe(false);
  });

  it("start accepts a legacy unstamped container only when no stamp is expected", async () => {
    dockerFake.install((args) => {
      if (args[0] === "inspect") return { stdout: containerPayload({}, "exited") };
      if (args[0] === "start") return { stdout: "" };
      return { error: `unexpected docker ${args.join(" ")}` };
    });
    const legacy = await makeProvider().start(
      task,
      { ref, expectedIncarnation: 0, expectedSpecFingerprint: null },
      context,
    );
    expect(legacy.isOk(), JSON.stringify(legacy)).toBe(true);
    expect(dockerFake.calls.some((args) => args[0] === "start")).toBe(true);

    dockerFake.reset();
    dockerFake.install(() => ({
      stdout: containerPayload({ "pi-orb.host-spec-fingerprint": "fingerprint-abc" }, "exited"),
    }));
    const stamped = await makeProvider().start(
      task,
      { ref, expectedIncarnation: 0, expectedSpecFingerprint: null },
      context,
    );
    expect(stamped.isErr() && stamped.error.code).toBe("conflict");
    expect(stamped.isErr() && stamped.error.retryable).toBe(false);
    expect(dockerFake.calls.some((args) => args[0] === "start")).toBe(false);
  });
});

describe("DockerOrbHostProvider tailscale env", () => {
  beforeEach(() => {
    dockerFake.reset();
  });

  it("omits the tailscale variables when the feature is not configured", async () => {
    const run = await provisionArgv(makeProvider());
    expect(envValue(run, TAILSCALE_AUTH_KEY_ENV)).toBeNull();
    expect(envValue(run, TAILSCALE_HOSTNAME_ENV)).toBeNull();
    expect(envValue(run, PREVIEW_HOST_ENV)).toBeNull();
  });

  it("delivers the auth key, hostname and preview host on creation", async () => {
    const run = await provisionArgv(
      makeProvider({ tailscale: { minter: minterReturning("tskey-auth-abc"), ...tailnet } }),
    );
    expect(envValue(run, TAILSCALE_AUTH_KEY_ENV)).toBe("tskey-auth-abc");
    expect(envValue(run, TAILSCALE_HOSTNAME_ENV)).toBe("pi-orb-orb-1");
    expect(envValue(run, PREVIEW_HOST_ENV)).toBe("pi-orb-orb-1.tailnet.ts.net");
  });

  it("fails provisioning retryably and creates no container when minting fails", async () => {
    installFreshHost();
    const provider = makeProvider({
      tailscale: {
        minter: minterFailing({
          type: "tailscale_error",
          code: "rejected",
          message: "tailnet said no",
          retryable: false,
        }),
        ...tailnet,
      },
    });
    const result = await provider.provision(task, request, context);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      // Retryable even for a terminal tailscale error: the reconciler
      // provisions again rather than failing the orb over port exposure.
      expect(result.error.retryable).toBe(true);
      expect(result.error.code).toBe("operation_failed");
      expect(result.error.message).toContain("tailnet said no");
    }
    expect(dockerFake.calls.some((args) => args[0] === "run")).toBe(false);
  });

  it("does not re-mint for a reused container", async () => {
    let minted = 0;
    const provider = makeProvider({
      tailscale: {
        minter: {
          mintAuthKey: () => {
            minted += 1;
            return okAsync("tskey-auth-new");
          },
        },
        ...tailnet,
      },
    });
    dockerFake.install((args) => {
      if (args[0] === "inspect") {
        return {
          stdout: JSON.stringify([
            {
              Config: {
                Env: [`${RUNTIME_TOKEN_ENV}=tok`, `${TAILSCALE_AUTH_KEY_ENV}=tskey-auth-old`],
                Labels: {
                  "pi-orb.orb-id": "orb-1",
                  "pi-orb.host-spec-fingerprint": provider.desiredSpecFingerprint({
                    orbId: request.orbId,
                    repositoryUrl: request.bootstrap.repositoryUrl,
                  }),
                },
              },
              State: { Status: "running" },
              NetworkSettings: { Networks: { "pi-orb": { IPAddress: "172.20.0.5" } } },
            },
          ]),
        };
      }
      return { stdout: "ok\n" };
    });
    const result = await provider.provision(task, request, context);
    expect(result.isOk(), JSON.stringify(result)).toBe(true);
    expect(minted).toBe(0);
    expect(dockerFake.calls.some((args) => args[0] === "run")).toBe(false);
  });
});
