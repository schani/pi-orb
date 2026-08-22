import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_TTL_SECONDS,
  ID_TOKEN_PATH,
  RUNTIME_SUBPROTOCOL,
  type ServerFrame,
  TERMINAL_SUBPROTOCOL,
} from "@pi-orb/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  api,
  type CommandOutcome,
  type ControlPlaneHandle,
  createFakeSession,
  deleteFakeSession,
  docker,
  dockerOutcome,
  type FakeSession,
  FatalProbeError,
  fakeControl,
  fetchIssuerKeys,
  orbContainerNames,
  removeOrbContainers,
  startControlPlane,
  verifyIdToken,
  waitFor,
} from "./harness.ts";

/**
 * The full docs/testing.md slice against the real Pi SDK and fake OpenAI
 * service: device login, scripted streaming with a real tool round trip,
 * history replication, and the controlled-stop drain. The default backend is
 * real PostgreSQL + Docker. PI_ORB_E2E_BACKEND=process selects the Docker-free
 * PGlite + process-provider composition and exercises the same scenario.
 */

const PG_CONTAINER = "pi-orb-e2e-pg";
const PG_PORT = 5436;
const CP_PORT = 7144;
const NETWORK = "pi-orb";
const RUNTIME_IMAGE = "pi-orb-runtime:dev";
const REPOSITORY_URL = "https://github.com/schani/pi-orb";
const PROCESS_BACKEND = process.env["PI_ORB_E2E_BACKEND"] === "process";

const SCENARIO = {
  auth: {
    accountId: "acct_pi_orb_e2e",
    device: { manualApprove: true },
  },
  model: {
    rules: [
      {
        match: { userMessage: { regex: "run the e2e tool check" } },
        steps: [
          { type: "reasoning", text: "I will run the requested check with bash.", deltas: 3 },
          { type: "toolCall", name: "bash", arguments: { command: "echo E2E_TOOL_OK" } },
          { type: "usage", input_tokens: 120, output_tokens: 25 },
          { type: "stop", status: "completed" },
        ],
      },
      {
        match: { toolResultContains: { regex: "E2E_TOOL_OK" } },
        steps: [
          { type: "text", content: "The check succeeded: E2E_TOOL_OK.", deltas: 4 },
          { type: "usage", input_tokens: 180, output_tokens: 12 },
          { type: "stop", status: "completed" },
        ],
      },
      {
        match: { default: true },
        steps: [
          { type: "text", content: "Unexpected prompt reached the fallback rule." },
          { type: "stop", status: "completed" },
        ],
      },
    ],
  },
};

const NAME_SCENARIO = {
  auth: { accountId: "acct_pi_orb_e2e" },
  model: {
    rules: [
      {
        match: { default: true },
        steps: [
          { type: "text", content: "Run E2E Tool Check" },
          { type: "stop", status: "completed" },
        ],
      },
    ],
  },
};

let fake: FakeSession;
let nameFake: FakeSession;
let controlPlane: ControlPlaneHandle;
let orbId = "";
let failedOrbId = "";
let specOrbId = "";
let localStateDirectory = "";

function processHostDirectory(id: string): string {
  return join(localStateDirectory, "process-hosts", id);
}

/**
 * Compute is gone while the durable workspace remains. Docker backend: no
 * container labeled for the orb, any incarnation. Process backend: host
 * metadata gone while the workspace (optionally a specific surviving file)
 * is still on disk.
 */
async function computeIncarnation(id: string): Promise<number | null> {
  if (PROCESS_BACKEND) {
    const path = join(processHostDirectory(id), "host.json");
    if (!existsSync(path)) return null;
    return Number((JSON.parse(readFileSync(path, "utf8")) as { incarnation: number }).incarnation);
  }
  const [name] = await orbContainerNames(id);
  if (name === undefined) return null;
  const match = /-i(\d+)$/.exec(name);
  return match === null ? null : Number(match[1]);
}

/**
 * The identity of the compute incarnation currently backing the orb, as
 * opposed to its incarnation *number*. Docker: the container ID, which changes
 * whenever the container is recreated. Process: the recorded process-group
 * leader plus its loopback port, which change whenever the child is
 * relaunched. Either one detects an in-place bounce that leaves the
 * incarnation number untouched — the mutation `docs/compute-replacement.md`
 * forbids and which an incarnation-only assertion cannot see.
 */
async function computeIdentity(id: string, incarnation: number): Promise<string> {
  if (PROCESS_BACKEND) {
    const metadata = JSON.parse(
      readFileSync(join(processHostDirectory(id), "host.json"), "utf8"),
    ) as { processGroupId: number | null; port: number };
    return `pgid=${String(metadata.processGroupId)} port=${String(metadata.port)}`;
  }
  return await docker(["inspect", "-f", "{{.Id}}", `pi-orb-${id}-i${incarnation}`]);
}

/** The runtime token the given incarnation actually carries. */
async function readRuntimeToken(id: string, incarnation: number): Promise<string> {
  if (PROCESS_BACKEND) {
    const metadata = JSON.parse(
      readFileSync(join(processHostDirectory(id), "host.json"), "utf8"),
    ) as { runtimeToken: string };
    return metadata.runtimeToken;
  }
  const environment = JSON.parse(
    await docker(["inspect", `pi-orb-${id}-i${incarnation}`, "--format", "{{json .Config.Env}}"]),
  ) as string[];
  const entry = environment.find((value) => value.startsWith("PI_ORB_RUNTIME_TOKEN="));
  if (entry === undefined) {
    throw new Error(`runtime token missing from inspect for ${id} i${incarnation}`);
  }
  return entry.slice("PI_ORB_RUNTIME_TOKEN=".length);
}

/**
 * The durable lifecycle edges for one orb, in emission order, out of the log
 * tail the harness captures. Chunks are joined before splitting: a stdout
 * chunk boundary can fall inside a line.
 */
function lifecycleLines(id: string): string[] {
  return controlPlane.logs
    .join("")
    .split("\n")
    .filter((line) => line.includes(`lifecycle: orb=${id} `));
}

/**
 * A bounded wait on the orb's lifecycle edges. The edges are written to stdout
 * slightly before the API view catches up, so asserting them directly after a
 * state wait would race the pipe; the timeout dumps the same diagnostics as
 * every other wait through `withOrbDiagnostics`.
 */
async function waitForLifecycleEdges(
  what: string,
  id: string,
  predicate: (lines: string[]) => boolean,
): Promise<void> {
  await waitFor(what, async () => (predicate(lifecycleLines(id)) ? true : null), {
    timeoutMs: 30_000,
    intervalMs: 500,
  });
}

async function computeAbsent(id: string, workspaceFile?: string): Promise<boolean> {
  if (PROCESS_BACKEND) {
    const hostDirectory = processHostDirectory(id);
    const witness =
      workspaceFile === undefined
        ? join(hostDirectory, "workspace")
        : join(hostDirectory, "workspace", workspaceFile);
    return !existsSync(join(hostDirectory, "host.json")) && existsSync(witness);
  }
  return (await orbContainerNames(id)).length === 0;
}

/**
 * The discard fence has completed: views synthesize the
 * `discarding_failed_compute` state detail only while the orb row still
 * carries a non-null discard fence, so its disappearance from the API proves
 * the fence cleared (views.ts).
 */
async function waitForDiscardFenceCleared(id: string): Promise<void> {
  await waitFor(
    "discard fence cleared",
    async () => {
      const view = await api(controlPlane.baseUrl, "GET", `/api/v1/orbs/${id}`);
      const detail = view.body["stateDetail"] as { type?: string } | undefined;
      return detail?.type === "discarding_failed_compute" ? null : true;
    },
    { timeoutMs: 60_000, intervalMs: 1_000 },
  );
}

/**
 * Each failure test has exactly one deliberate 65-second negative-observation
 * window: observe more than two terminal-backstop intervals and fail
 * immediately if compute reappears without explicit Start/message intent.
 */
async function observeNoAutonomousReplacement(id: string, workspaceFile?: string): Promise<void> {
  const negativeDeadline = Date.now() + 65_000;
  while (Date.now() < negativeDeadline) {
    expect(await computeAbsent(id, workspaceFile)).toBe(true);
    expect((await api(controlPlane.baseUrl, "GET", `/api/v1/orbs/${id}`)).body["state"]).toBe(
      "failed",
    );
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

/** Write files into the orb's live workspace through the current incarnation. */
async function writeWorkspaceFiles(
  id: string,
  incarnation: number,
  files: Record<string, string>,
): Promise<void> {
  if (PROCESS_BACKEND) {
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(processHostDirectory(id), "workspace", name), content);
    }
    return;
  }
  await docker([
    "exec",
    `pi-orb-${id}-i${incarnation}`,
    "node",
    "-e",
    "const files=JSON.parse(process.argv[1]);" +
      "for(const [name,content] of Object.entries(files))" +
      "require('fs').writeFileSync('/workspace/'+name,content)",
    JSON.stringify(files),
  ]);
}

/** Read one workspace file back through the given incarnation. */
async function readWorkspaceFile(id: string, incarnation: number, name: string): Promise<string> {
  if (PROCESS_BACKEND) {
    return readFileSync(join(processHostDirectory(id), "workspace", name), "utf8");
  }
  return await docker([
    "exec",
    `pi-orb-${id}-i${incarnation}`,
    "node",
    "-e",
    "process.stdout.write(require('fs').readFileSync('/workspace/'+process.argv[1],'utf8'))",
    name,
  ]);
}

/** The audience this suite's fake relying party accepts (docs/workload-identity.md). */
const IDENTITY_AUDIENCE = "urn:pi-orb-e2e:rp";

/**
 * Mint through the in-orb CLI exactly as a workload would: the shim on the
 * container's PATH, the provider-injected environment, and nothing else.
 * Docker only — the process provider inherits host executables and installs no
 * image shim, like every other `docker exec` step in this suite.
 */
function mintViaCli(
  id: string,
  incarnation: number,
  args: readonly string[],
): Promise<CommandOutcome> {
  return dockerOutcome(["exec", `pi-orb-${id}-i${incarnation}`, "pi-orb", "id-token", ...args]);
}

/**
 * A mint attempted with a bearer the *test* holds, bypassing the CLI. This is
 * how revocation is proved: a bearer whose incarnation is gone, or whose orb
 * is stopped, has no live compute left to run the CLI in.
 */
async function mintDirect(
  bearer: string,
  audience: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${controlPlane.baseUrl}${ID_TOKEN_PATH}`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({ audience }),
  });
  return {
    status: response.status,
    body: (await response.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

/**
 * First-timeout diagnostics shared by every test: the current orb API view,
 * the provider inventory for the orb, and the control-plane log tail captured
 * by the harness.
 */
async function dumpOrbDiagnostics(id: string): Promise<void> {
  if (id !== "") {
    const view = await api(controlPlane.baseUrl, "GET", `/api/v1/orbs/${id}`).catch(() => null);
    console.error("=== orb view ===", JSON.stringify(view?.body));
    if (PROCESS_BACKEND) {
      const hostDirectory = processHostDirectory(id);
      const entries = existsSync(hostDirectory) ? readdirSync(hostDirectory) : [];
      console.error(
        "=== process host inventory ===",
        JSON.stringify({ hostDirectory, entries, hostMetadata: entries.includes("host.json") }),
      );
    } else {
      const names = await orbContainerNames(id).catch((error: unknown) => [
        `unavailable: ${String(error)}`,
      ]);
      console.error("=== docker inventory ===", JSON.stringify(names));
    }
  }
  console.error("=== control-plane logs (tail) ===");
  console.error(controlPlane.logs.join("").split("\n").slice(-40).join("\n"));
}

/** Run a test body and dump the shared diagnostics on any failure. */
async function withOrbDiagnostics(id: () => string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (error) {
    await dumpOrbDiagnostics(id()).catch(() => undefined);
    throw error;
  }
}

beforeAll(async () => {
  fake = await createFakeSession(`pi-orb-e2e-${Date.now()}`, SCENARIO);
  nameFake = await createFakeSession(`pi-orb-name-e2e-${Date.now()}`, NAME_SCENARIO);

  if (PROCESS_BACKEND) {
    localStateDirectory = mkdtempSync(join(tmpdir(), "pi-orb-e2e-local-"));
    controlPlane = await startControlPlane({
      pglitePath: join(localStateDirectory, "control-plane.pglite"),
      processStateDirectory: join(localStateDirectory, "process-hosts"),
      port: CP_PORT,
      fake,
      nameFake,
      launchFailureMarker: ".pi-orb-e2e-launch-failure.json",
      hostSpecGeneration: 1,
      e2eHostSpec: "stage2-spec-a",
    });
    return;
  }

  await docker(["network", "create", NETWORK]).catch(() => undefined);
  // Always rebuild: a build-if-absent gate silently runs stale runtime code.
  // With a warm layer cache this takes seconds.
  await docker(["build", "-f", "apps/orb-runtime/Dockerfile", "-t", RUNTIME_IMAGE, "."], 600_000);

  await docker(["rm", "-f", PG_CONTAINER]).catch(() => undefined);
  await docker([
    "run",
    "--detach",
    "--name",
    PG_CONTAINER,
    "-e",
    "POSTGRES_USER=pi-orb",
    "-e",
    "POSTGRES_PASSWORD=pi-orb",
    "-e",
    "POSTGRES_DB=pi_orb",
    "-p",
    `127.0.0.1:${PG_PORT}:5432`,
    "postgres:16",
  ]);
  await waitFor(
    "postgres ready",
    async () => {
      const out = await docker(["exec", PG_CONTAINER, "pg_isready", "-U", "pi-orb"]);
      return out.includes("accepting connections") ? true : null;
    },
    { timeoutMs: 60_000 },
  );

  controlPlane = await startControlPlane({
    databaseUrl: `postgres://pi-orb:pi-orb@127.0.0.1:${PG_PORT}/pi_orb`,
    port: CP_PORT,
    fake,
    nameFake,
    dockerNetwork: NETWORK,
    runtimeImage: RUNTIME_IMAGE,
    launchFailureMarker: ".pi-orb-e2e-launch-failure.json",
    hostSpecGeneration: 1,
    e2eHostSpec: "stage2-spec-a",
  });
}, 720_000);

afterAll(async () => {
  if (!PROCESS_BACKEND) {
    for (const id of [orbId, failedOrbId, specOrbId]) {
      if (id === "") continue;
      await removeOrbContainers(id);
      await docker(["volume", "rm", "-f", `pi-orb-data-${id}`]).catch(() => undefined);
    }
  }
  await controlPlane?.stop();
  if (!PROCESS_BACKEND) await docker(["rm", "-f", PG_CONTAINER]).catch(() => undefined);
  if (fake !== undefined) await deleteFakeSession(fake.sessionKey);
  if (nameFake !== undefined) await deleteFakeSession(nameFake.sessionKey);
  if (localStateDirectory !== "") rmSync(localStateDirectory, { recursive: true, force: true });
}, 120_000);

async function restartControlPlaneWithSpec(spec: string, generation: number): Promise<void> {
  // Restarting the control plane terminates its child compute on the process
  // backend — that is exactly why the SIGHUP seam exists. Docker compute
  // survives, so only the docker leg may use a restart to change generation.
  if (PROCESS_BACKEND) {
    throw new Error("restartControlPlaneWithSpec kills process-backend compute; use SIGHUP");
  }
  const authDir = controlPlane.authDir;
  await controlPlane.stop();
  controlPlane = await startControlPlane({
    databaseUrl: `postgres://pi-orb:pi-orb@127.0.0.1:${PG_PORT}/pi_orb`,
    port: CP_PORT,
    fake,
    nameFake,
    dockerNetwork: NETWORK,
    runtimeImage: RUNTIME_IMAGE,
    launchFailureMarker: ".pi-orb-e2e-launch-failure.json",
    hostSpecGeneration: generation,
    e2eHostSpec: spec,
    authDir,
  });
}

describe("full slice E2E", () => {
  it("runs login, a scripted tool round trip, replication, and drain", async () => {
    try {
      await runScenario();
    } catch (error) {
      // Dump every diagnostic surface before failing.
      await dumpOrbDiagnostics(orbId).catch(() => undefined);
      const requests = await fakeControl(fake.sessionKey, "/requests").catch(() => null);
      console.error("=== fake inference requests ===", JSON.stringify(requests));
      if (orbId !== "") {
        const logs = PROCESS_BACKEND
          ? (() => {
              try {
                return readFileSync(join(processHostDirectory(orbId), "runtime.err.log"), "utf8");
              } catch (error) {
                return `unavailable: ${String(error)}`;
              }
            })()
          : await orbContainerNames(orbId)
              .then((names) => {
                const [name] = names;
                return name === undefined
                  ? "no containers labeled for orb"
                  : docker(["logs", "--tail", "40", name]);
              })
              .catch((error: unknown) => `unavailable: ${String(error)}`);
        console.error("=== orb runtime logs ===\n", logs);
      }
      throw error;
    }
  }, 720_000);

  it("replaces one deliberately failed incarnation only after explicit Start", async () => {
    const base = controlPlane.baseUrl;
    const projectId = randomUUID();
    const replacementOrbId = randomUUID();
    await withOrbDiagnostics(
      () => replacementOrbId,
      async () => {
        const project = await api(base, "POST", "/api/v1/projects", {
          id: projectId,
          name: `e2e-compute-replacement-${projectId.slice(0, 8)}`,
          repositoryUrl: REPOSITORY_URL,
        });
        expect(project.status, JSON.stringify(project.body)).toBe(201);
        const created = await api(base, "POST", `/api/v1/projects/${projectId}/orbs`, {
          id: replacementOrbId,
        });
        expect(created.status, JSON.stringify(created.body)).toBe(202);
        await waitFor(
          "replacement fixture running",
          async () => {
            const view = await api(base, "GET", `/api/v1/orbs/${replacementOrbId}`);
            if (view.body["state"] === "failed") {
              throw new FatalProbeError(
                `replacement fixture failed: ${String(view.body["lastError"])}`,
              );
            }
            return view.body["state"] === "running" ? true : null;
          },
          { timeoutMs: 300_000, intervalMs: 1_000 },
        );

        const sentinel = `replacement-sentinel-${randomUUID()}`;
        await writeWorkspaceFiles(replacementOrbId, 0, {
          "replacement-sentinel": sentinel,
          ".pi-orb-e2e-launch-failure.json": JSON.stringify({
            orbId: replacementOrbId,
            incarnation: 0,
          }),
        });
        const oldToken = await readRuntimeToken(replacementOrbId, 0);
        const historyBefore = await api(base, "GET", `/api/v1/orbs/${replacementOrbId}/history`);
        expect(historyBefore.status).toBe(200);

        // Workload identity end to end (docs/workload-identity.md): the orb
        // mints through its own CLI and an outside verifier accepts it using
        // nothing but the published discovery document and JWKS.
        if (!PROCESS_BACKEND) {
          const issuer = await fetchIssuerKeys(base);
          expect(issuer.keys.length).toBeGreaterThan(0);
          const minted = await mintViaCli(replacementOrbId, 0, ["--audience", IDENTITY_AUDIENCE]);
          expect(minted.code, minted.stderr).toBe(0);
          // The contract the credential-source protocols depend on: the JWT
          // and one trailing newline are the entire stdout.
          expect(minted.stdout).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\n$/);
          const token = minted.stdout.slice(0, -1);

          const verdict = verifyIdToken(token, {
            keys: issuer.keys,
            issuer: issuer.issuer,
            audience: IDENTITY_AUDIENCE,
          });
          expect(verdict.ok ? "verified" : verdict.reason).toBe("verified");
          if (verdict.ok) {
            expect(verdict.claims["iss"]).toBe(issuer.issuer);
            expect(verdict.claims["sub"]).toBe(replacementOrbId);
            expect(verdict.claims["orb_id"]).toBe(replacementOrbId);
            expect(verdict.claims["project_id"]).toBe(projectId);
            expect(verdict.claims["host_incarnation"]).toBe(0);
            expect(verdict.claims["token_use"]).toBe("exchanged");
            expect(Number(verdict.claims["exp"]) - Number(verdict.claims["iat"])).toBe(
              DEFAULT_TTL_SECONDS,
            );
          }
          // The verifier is not a rubber stamp: audience, issuer, and
          // signature each have to be able to fail.
          expect(
            verifyIdToken(token, {
              keys: issuer.keys,
              issuer: issuer.issuer,
              audience: "urn:pi-orb-e2e:other",
            }).ok,
          ).toBe(false);
          expect(
            verifyIdToken(token, {
              keys: issuer.keys,
              issuer: "https://issuer.example",
              audience: IDENTITY_AUDIENCE,
            }).ok,
          ).toBe(false);
          expect(
            verifyIdToken(token.slice(0, token.length - 8), {
              keys: issuer.keys,
              issuer: issuer.issuer,
              audience: IDENTITY_AUDIENCE,
            }).ok,
          ).toBe(false);

          // An explicit lifetime, and a lifetime the CLI must refuse locally.
          const custom = await mintViaCli(replacementOrbId, 0, [
            "--audience",
            IDENTITY_AUDIENCE,
            "--ttl-seconds",
            "120",
          ]);
          expect(custom.code, custom.stderr).toBe(0);
          const customVerdict = verifyIdToken(custom.stdout.trimEnd(), {
            keys: issuer.keys,
            issuer: issuer.issuer,
            audience: IDENTITY_AUDIENCE,
          });
          expect(customVerdict.ok ? "verified" : customVerdict.reason).toBe("verified");
          if (customVerdict.ok) {
            expect(Number(customVerdict.claims["exp"]) - Number(customVerdict.claims["iat"])).toBe(
              120,
            );
          }
          const rejected = await mintViaCli(replacementOrbId, 0, [
            "--audience",
            IDENTITY_AUDIENCE,
            "--ttl-seconds",
            "10",
          ]);
          expect(rejected.code).not.toBe(0);
          expect(rejected.stdout).toBe("");
          expect(rejected.stderr).toContain("--ttl-seconds must be 60..3600");
        }

        expect((await api(base, "POST", `/api/v1/orbs/${replacementOrbId}/stop`)).status).toBe(202);
        await waitFor(
          "replacement fixture stopped",
          async () =>
            (await api(base, "GET", `/api/v1/orbs/${replacementOrbId}`)).body["state"] === "stopped"
              ? true
              : null,
          { timeoutMs: 120_000, intervalMs: 1_000 },
        );
        // Stopping closes minting before the bearer changes: Docker keeps the
        // container and therefore the same bearer across a stop, so this 403
        // isolates the lifecycle gate from the 401 a rotated bearer gets after
        // the replacement below (docs/workload-identity.md).
        if (!PROCESS_BACKEND) {
          const stoppedMint = await mintDirect(oldToken, IDENTITY_AUDIENCE);
          expect(stoppedMint.status, JSON.stringify(stoppedMint.body)).toBe(403);
          expect(stoppedMint.body["error"]).toBe("not_mintable");
          // The refusal is visible in the product, not only in the response.
          const identity = (await api(base, "GET", `/api/v1/orbs/${replacementOrbId}`)).body[
            "identity"
          ] as { failureCode?: string } | undefined;
          expect(identity?.failureCode).toBe("not_mintable");
        }
        expect((await api(base, "POST", `/api/v1/orbs/${replacementOrbId}/start`)).status).toBe(
          202,
        );

        const failed = await waitFor(
          "injected incarnation failed",
          async () => {
            const view = await api(base, "GET", `/api/v1/orbs/${replacementOrbId}`);
            return view.body["state"] === "failed" ? view.body : null;
          },
          { timeoutMs: 300_000, intervalMs: 1_000 },
        );
        expect(failed["lastError"]).toEqual(expect.stringContaining("e2e_launch_failure"));
        await waitFor(
          "injected compute disposed",
          async () =>
            (await computeAbsent(replacementOrbId, "replacement-sentinel")) ? true : null,
          { timeoutMs: 120_000, intervalMs: 1_000 },
        );
        await waitForDiscardFenceCleared(replacementOrbId);
        const unauthorized = await fetch(`${base}/runtime/v1/tokens/model`, {
          method: "POST",
          headers: { authorization: `Bearer ${oldToken}`, "content-type": "application/json" },
          body: JSON.stringify({ reason: "startup" }),
        });
        expect(unauthorized.status).toBe(401);
        // The same discarded bearer can no longer mint identity either, and
        // the answer is indistinguishable from an unknown orb's.
        const staleMint = await mintDirect(oldToken, IDENTITY_AUDIENCE);
        expect(staleMint.status, JSON.stringify(staleMint.body)).toBe(401);
        expect(staleMint.body["error"]).toBe("unauthorized");

        await observeNoAutonomousReplacement(replacementOrbId, "replacement-sentinel");

        expect((await api(base, "POST", `/api/v1/orbs/${replacementOrbId}/start`)).status).toBe(
          202,
        );
        await waitFor(
          "clean replacement running",
          async () => {
            const view = await api(base, "GET", `/api/v1/orbs/${replacementOrbId}`);
            if (view.body["state"] === "failed") {
              throw new FatalProbeError(
                `clean replacement failed: ${String(view.body["lastError"])}`,
              );
            }
            return view.body["state"] === "running" ? true : null;
          },
          { timeoutMs: 300_000, intervalMs: 1_000 },
        );
        expect(await readRuntimeToken(replacementOrbId, 1)).not.toBe(oldToken);
        expect(await readWorkspaceFile(replacementOrbId, 1, "replacement-sentinel")).toBe(sentinel);
        // The new incarnation mints with its own bearer, and the token names
        // the incarnation that asked for it — the claim an incarnation-
        // sensitive relying party authorizes on.
        if (!PROCESS_BACKEND) {
          const issuer = await fetchIssuerKeys(base);
          const replacementMint = await mintViaCli(replacementOrbId, 1, [
            "--audience",
            IDENTITY_AUDIENCE,
          ]);
          expect(replacementMint.code, replacementMint.stderr).toBe(0);
          const verdict = verifyIdToken(replacementMint.stdout.trimEnd(), {
            keys: issuer.keys,
            issuer: issuer.issuer,
            audience: IDENTITY_AUDIENCE,
          });
          expect(verdict.ok ? "verified" : verdict.reason).toBe("verified");
          if (verdict.ok) {
            expect(verdict.claims["host_incarnation"]).toBe(1);
            expect(verdict.claims["orb_id"]).toBe(replacementOrbId);
          }
        }
        // Exactly one compute identity exists for the orb, and it is the
        // replacement incarnation 1 — never the discarded incarnation 0 or a
        // duplicate.
        if (PROCESS_BACKEND) {
          const metadata = JSON.parse(
            readFileSync(join(processHostDirectory(replacementOrbId), "host.json"), "utf8"),
          ) as { incarnation?: number };
          expect(metadata.incarnation).toBe(1);
        } else {
          expect(await orbContainerNames(replacementOrbId)).toEqual([
            `pi-orb-${replacementOrbId}-i1`,
          ]);
        }
        const historyAfter = await api(base, "GET", `/api/v1/orbs/${replacementOrbId}/history`);
        expect(historyAfter.status).toBe(200);
        expect(historyAfter.body["records"]).toEqual(historyBefore.body["records"]);
        expect(historyAfter.body["session"]).not.toBeNull();

        expect((await api(base, "DELETE", `/api/v1/projects/${projectId}`)).status).toBe(202);
        await waitFor(
          "replacement fixture deleted",
          async () =>
            (await api(base, "GET", `/api/v1/projects/${projectId}`)).status === 404 ? true : null,
          { timeoutMs: 240_000, intervalMs: 1_000 },
        );
      },
    );
  }, 600_000);

  it("leaves running compute untouched and replaces stale stopped compute on Start", async () => {
    const projectId = randomUUID();
    specOrbId = randomUUID();
    await withOrbDiagnostics(
      () => specOrbId,
      async () => {
        expect(
          (
            await api(controlPlane.baseUrl, "POST", "/api/v1/projects", {
              id: projectId,
              name: `e2e-host-spec-${projectId.slice(0, 8)}`,
              repositoryUrl: REPOSITORY_URL,
            })
          ).status,
        ).toBe(201);
        expect(
          (
            await api(controlPlane.baseUrl, "POST", `/api/v1/projects/${projectId}/orbs`, {
              id: specOrbId,
            })
          ).status,
        ).toBe(202);
        await waitFor(
          "host-spec fixture running",
          async () => {
            const view = await api(controlPlane.baseUrl, "GET", `/api/v1/orbs/${specOrbId}`);
            if (view.body["state"] === "failed") {
              throw new FatalProbeError(String(view.body["lastError"]));
            }
            return view.body["state"] === "running" ? true : null;
          },
          { timeoutMs: 300_000, intervalMs: 1_000 },
        );
        expect(await computeIncarnation(specOrbId)).toBe(0);
        const sentinel = `stage2-${specOrbId}`;
        await writeWorkspaceFiles(specOrbId, 0, { "stage2-sentinel": sentinel });
        // Captured before the specification changes: the running incarnation
        // must still be this exact compute afterwards, not a same-numbered
        // replacement or an in-place bounce.
        const runningIdentity = await computeIdentity(specOrbId, 0);
        const staleToken = await readRuntimeToken(specOrbId, 0);

        // A deployed spec change does not bounce running compute. Restarting
        // the control plane models the next revision while preserving the
        // database, provider state, and credential directory.
        if (PROCESS_BACKEND) {
          controlPlane.process.kill("SIGHUP");
          await waitFor("E2E host spec advanced", async () =>
            controlPlane.logs.join("").includes("E2E host specification advanced") ? true : null,
          );
        } else {
          await restartControlPlaneWithSpec("stage2-spec-b", 2);
        }
        // Deliberate elapsed-time wait #2 in this suite (docs/compute-replacement.md):
        // the assertion is a negative one — several reconcile passes at the new
        // specification must leave the running orb's compute completely alone —
        // and a negative has no completion signal to wait on.
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        expect(
          (await api(controlPlane.baseUrl, "GET", `/api/v1/orbs/${specOrbId}`)).body["state"],
        ).toBe("running");
        expect(await computeIncarnation(specOrbId)).toBe(0);
        expect(await computeIdentity(specOrbId, 0)).toBe(runningIdentity);

        expect(
          (await api(controlPlane.baseUrl, "POST", `/api/v1/orbs/${specOrbId}/stop`)).status,
        ).toBe(202);
        await waitFor(
          "host-spec fixture stopped",
          async () =>
            (await api(controlPlane.baseUrl, "GET", `/api/v1/orbs/${specOrbId}`)).body["state"] ===
            "stopped"
              ? true
              : null,
          { timeoutMs: 120_000, intervalMs: 1_000 },
        );
        expect(await computeIncarnation(specOrbId)).toBe(0);
        // A stopped Docker container keeps its ID, so the stale compute must
        // still be the exact same container. The process backend clears the
        // recorded process group when the child exits, so a stopped host there
        // legitimately has no process identity left to compare.
        if (!PROCESS_BACKEND) {
          expect(await computeIdentity(specOrbId, 0)).toBe(runningIdentity);
        }
        expect(
          (await api(controlPlane.baseUrl, "POST", `/api/v1/orbs/${specOrbId}/start`)).status,
        ).toBe(202);
        await waitFor(
          "host-spec replacement running",
          async () => {
            const view = await api(controlPlane.baseUrl, "GET", `/api/v1/orbs/${specOrbId}`);
            if (view.body["state"] === "failed") {
              throw new FatalProbeError(String(view.body["lastError"]));
            }
            return view.body["state"] === "running" && (await computeIncarnation(specOrbId)) === 1
              ? true
              : null;
          },
          { timeoutMs: 300_000, intervalMs: 1_000 },
        );
        expect(await readWorkspaceFile(specOrbId, 1, "stage2-sentinel")).toBe(sentinel);
        // The replacement rotated the compute identity and its runtime token,
        // and exactly one compute identity remains for the orb.
        expect(await computeIdentity(specOrbId, 1)).not.toBe(runningIdentity);
        expect(await readRuntimeToken(specOrbId, 1)).not.toBe(staleToken);
        if (PROCESS_BACKEND) {
          const metadata = JSON.parse(
            readFileSync(join(processHostDirectory(specOrbId), "host.json"), "utf8"),
          ) as { incarnation?: number };
          expect(metadata.incarnation).toBe(1);
        } else {
          expect(await orbContainerNames(specOrbId)).toEqual([`pi-orb-${specOrbId}-i1`]);
        }
        // The durable edges tie the replacement to the specification change:
        // a discard requested for `host_spec_changed`, then the replacement
        // incarnation provisioned after it (docs/compute-replacement.md).
        await waitForLifecycleEdges("host-spec replacement lifecycle edges", specOrbId, (lines) => {
          const discarded = lines.findIndex(
            (line) =>
              line.includes(" compute-discard-requested ") &&
              line.includes("reason=host_spec_changed"),
          );
          const provisioned = lines.findIndex(
            (line) => line.includes(" replacement-provisioned ") && line.includes("incarnation=1"),
          );
          return discarded >= 0 && provisioned > discarded;
        });

        // Docker leg only: a draining *lower*-generation revision must decline
        // the replacement and start the existing incarnation unchanged, so a
        // stale revision can never replace newer-spec compute backward.
        // `restartControlPlaneWithSpec` would terminate process-backend
        // compute, which is why this leg is Docker-only.
        if (!PROCESS_BACKEND) {
          expect(
            (await api(controlPlane.baseUrl, "POST", `/api/v1/orbs/${specOrbId}/stop`)).status,
          ).toBe(202);
          await waitFor(
            "host-spec fixture stopped before declined generation",
            async () =>
              (await api(controlPlane.baseUrl, "GET", `/api/v1/orbs/${specOrbId}`)).body[
                "state"
              ] === "stopped"
                ? true
                : null,
            { timeoutMs: 120_000, intervalMs: 1_000 },
          );
          const declinedIdentity = await computeIdentity(specOrbId, 1);
          // Lower generation, different effective specification: the fresh log
          // array of the restarted handle contains only this revision's edges.
          await restartControlPlaneWithSpec("stage2-spec-c", 1);
          expect(
            (await api(controlPlane.baseUrl, "POST", `/api/v1/orbs/${specOrbId}/start`)).status,
          ).toBe(202);
          await waitFor(
            "declined-generation start running",
            async () => {
              const view = await api(controlPlane.baseUrl, "GET", `/api/v1/orbs/${specOrbId}`);
              if (view.body["state"] === "failed") {
                throw new FatalProbeError(String(view.body["lastError"]));
              }
              return view.body["state"] === "running" ? true : null;
            },
            { timeoutMs: 300_000, intervalMs: 1_000 },
          );
          await waitForLifecycleEdges("spec-replacement declined edge", specOrbId, (lines) =>
            lines.some((line) => line.includes(" spec-replacement-declined ")),
          );
          expect(await computeIncarnation(specOrbId)).toBe(1);
          expect(await computeIdentity(specOrbId, 1)).toBe(declinedIdentity);
          expect(await orbContainerNames(specOrbId)).toEqual([`pi-orb-${specOrbId}-i1`]);
          expect(lifecycleLines(specOrbId).join("\n")).not.toContain("compute-discard-requested");
          // Leave the suite on a control plane whose configured specification
          // matches the committed one.
          await restartControlPlaneWithSpec("stage2-spec-b", 2);
        }
        expect(
          (await api(controlPlane.baseUrl, "DELETE", `/api/v1/projects/${projectId}`)).status,
        ).toBe(202);
      },
    );
  }, 600_000);

  it("surfaces a real clone failure, disposes compute, and never autonomously replaces it", async () => {
    const base = controlPlane.baseUrl;
    const projectId = randomUUID();
    const missingRepository = `https://github.com/schani/pi-orb-e2e-missing-${randomUUID()}`;
    await withOrbDiagnostics(
      () => failedOrbId,
      async () => {
        const project = await api(base, "POST", "/api/v1/projects", {
          id: projectId,
          name: `e2e-clone-failure-${projectId.slice(0, 8)}`,
          repositoryUrl: missingRepository,
        });
        expect(project.status, JSON.stringify(project.body)).toBe(201);

        failedOrbId = randomUUID();
        const createdAt = Date.now();
        const created = await api(base, "POST", `/api/v1/projects/${projectId}/orbs`, {
          id: failedOrbId,
        });
        expect(created.status, JSON.stringify(created.body)).toBe(202);

        const failed = await waitFor(
          "terminal clone failure",
          async () => {
            const view = await api(base, "GET", `/api/v1/orbs/${failedOrbId}`);
            return view.body["state"] === "failed" ? view.body : null;
          },
          { timeoutMs: 120_000, intervalMs: 1_000 },
        );
        expect(Date.now() - createdAt).toBeLessThan(120_000);
        expect(failed["lastError"]).toEqual(
          expect.stringContaining("runtime_failed: clone_failed:"),
        );
        expect(failed["lastError"]).not.toEqual(expect.stringContaining("deadline_exceeded"));

        await waitFor(
          "failed compute absent",
          async () => ((await computeAbsent(failedOrbId)) ? true : null),
          { timeoutMs: 60_000, intervalMs: 1_000 },
        );
        await waitForDiscardFenceCleared(failedOrbId);
        if (!PROCESS_BACKEND) {
          await expect(
            docker(["volume", "inspect", `pi-orb-data-${failedOrbId}`]),
          ).resolves.toContain(failedOrbId);
        }

        await observeNoAutonomousReplacement(failedOrbId);

        const durable = await api(base, "GET", `/api/v1/orbs/${failedOrbId}`);
        expect(durable.body["lastError"]).toBe(failed["lastError"]);
      },
    );
  }, 260_000);

  async function runScenario(): Promise<void> {
    const base = controlPlane.baseUrl;

    // Project + orb through the real API (docs/testing.md steps 1-2).
    const projectId = randomUUID();
    const project = await api(base, "POST", "/api/v1/projects", {
      id: projectId,
      name: `e2e-${projectId.slice(0, 8)}`,
      repositoryUrl: REPOSITORY_URL,
    });
    expect(project.status, JSON.stringify(project.body)).toBe(201);
    orbId = randomUUID();
    const orb = await api(base, "POST", `/api/v1/projects/${projectId}/orbs`, { id: orbId });
    expect(orb.status, JSON.stringify(orb.body)).toBe(202);

    // Device login: the test plays the human via the fake's control API.
    const challenge = await waitFor(
      "device-login challenge",
      async () => {
        const view = await api(base, "GET", `/api/v1/orbs/${orbId}`);
        const action = view.body["actionRequired"] as Record<string, unknown> | undefined;
        return typeof action?.["userCode"] === "string" && action["userCode"] !== ""
          ? (action["userCode"] as string)
          : null;
      },
      { timeoutMs: 60_000 },
    );
    await fakeControl(fake.sessionKey, "/deviceauth/approve", { user_code: challenge });

    // Clone + session + auth resolve inside the container (docs/testing.md steps 3-4).
    await waitFor(
      "orb running",
      async () => {
        const view = await api(base, "GET", `/api/v1/orbs/${orbId}`);
        if (view.body["state"] === "failed") {
          throw new FatalProbeError(`orb failed: ${String(view.body["lastError"])}`);
        }
        return view.body["state"] === "running" ? true : null;
      },
      { timeoutMs: 300_000, intervalMs: 2_000 },
    );

    // A real PTY traverses browser route → control-plane binary proxy → runtime.
    const terminalSocket = new WebSocket(
      `ws://127.0.0.1:${CP_PORT}/api/v1/orbs/${orbId}/terminal`,
      [TERMINAL_SUBPROTOCOL],
    );
    await new Promise<void>((resolve, reject) => {
      terminalSocket.once("open", resolve);
      terminalSocket.once("error", reject);
    });
    let terminalOutput = "";
    let terminalClosedBeforeStop = false;
    let stopRequested = false;
    const terminalClosed = new Promise<void>((resolve) => {
      terminalSocket.once("close", () => {
        if (!stopRequested) terminalClosedBeforeStop = true;
        resolve();
      });
    });
    const terminalComplete = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("terminal E2E timed out")), 30_000);
      terminalSocket.on("message", (data, isBinary) => {
        if (isBinary) {
          terminalOutput += data.toString();
          if (terminalOutput.includes("TERMINAL_E2E_OK")) {
            clearTimeout(timer);
            resolve();
          }
          return;
        }
        const control = JSON.parse(data.toString()) as {
          type?: string;
          error?: { message?: string };
        };
        if (control.type === "terminal.ready") {
          // Leave the shell open: the controlled stop below must close it and
          // its socket rather than leaking a process-provider descendant.
          terminalSocket.send(Buffer.from("printf TERMINAL_E2E_OK\\n\r"));
        } else if (control.type === "terminal.error") {
          clearTimeout(timer);
          reject(new Error(control.error?.message ?? "terminal error"));
        }
      });
    });
    terminalSocket.send(JSON.stringify({ v: 1, type: "terminal.open", cols: 100, rows: 30 }));
    await terminalComplete;
    expect(terminalOutput).toContain("TERMINAL_E2E_OK");

    // Live connection through the content-agnostic proxy (docs/testing.md steps 5-6).
    const history = await api(base, "GET", `/api/v1/orbs/${orbId}/history`);
    const cursor = (history.body["cursor"] as string | null) ?? null;

    const frames: ServerFrame[] = [];
    const socket = new WebSocket(`ws://127.0.0.1:${CP_PORT}/api/v1/orbs/${orbId}/live`, [
      RUNTIME_SUBPROTOCOL,
    ]);
    const frameWaiters: (() => void)[] = [];
    socket.on("message", (data) => {
      frames.push(JSON.parse(data.toString()) as ServerFrame);
      for (const waiter of frameWaiters.splice(0)) waiter();
    });
    const untilFrame = <T>(
      what: string,
      find: () => T | undefined,
      timeoutMs = 120_000,
    ): Promise<T> =>
      new Promise((resolve, reject) => {
        const deadline = setTimeout(
          () => reject(new Error(`timed out waiting for frame: ${what}`)),
          timeoutMs,
        );
        const check = (): void => {
          const found = find();
          if (found !== undefined) {
            clearTimeout(deadline);
            resolve(found);
          } else {
            frameWaiters.push(check);
          }
        };
        check();
      });

    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", (error) => reject(error));
    });
    socket.send(
      JSON.stringify({
        v: 1,
        type: "client.hello",
        clientInstanceId: randomUUID(),
        afterRecordId: cursor,
      }),
    );
    const syncCompleted = await untilFrame("sync.completed", () =>
      frames.find((frame) => frame.type === "sync.completed"),
    );

    // One scripted turn: reasoning + real bash tool + final text.
    let headId = syncCompleted.type === "sync.completed" ? syncCompleted.headId : null;
    for (const frame of frames) {
      if (frame.type === "history.record") headId = frame.record.id;
    }
    const requestId = randomUUID();
    socket.send(
      JSON.stringify({
        v: 1,
        type: "client.request",
        requestId,
        action: {
          type: "message",
          expectedHeadId: headId,
          content: [{ type: "text", text: "please run the e2e tool check" }],
        },
      }),
    );
    const result = await untilFrame("request.result", () =>
      frames.find((frame) => frame.type === "request.result" && frame.requestId === requestId),
    );
    expect(result.type === "request.result" && result.result.type).toBe("accepted");

    await untilFrame(
      "bash tool completed",
      () =>
        frames.find(
          (frame) =>
            frame.type === "runtime.event" &&
            frame.event.type === "tool_state" &&
            frame.event.name === "bash" &&
            frame.event.state === "completed",
        ),
      180_000,
    );
    await untilFrame(
      "operation finished",
      () =>
        frames.find(
          (frame) => frame.type === "runtime.event" && frame.event.type === "operation_finished",
        ),
      180_000,
    );
    const finalText = await untilFrame(
      "final assistant record",
      () =>
        frames.find(
          (frame) =>
            frame.type === "history.record" &&
            JSON.stringify(frame.record).includes("The check succeeded: E2E_TOOL_OK."),
        ),
      60_000,
    );
    expect(finalText).toBeDefined();
    const sawReasoningDelta = frames.some(
      (frame) =>
        frame.type === "runtime.event" &&
        frame.event.type === "output_patch" &&
        frame.event.blockType === "reasoning",
    );
    expect(sawReasoningDelta, "streamed reasoning deltas reached the client").toBe(true);

    // A user-shell action executes directly through Pi (not through the model),
    // streams as a shell block, and publishes its persisted bashExecution entry.
    for (const frame of frames) {
      if (frame.type === "history.record") headId = frame.headId ?? frame.record.id;
    }
    const shellRequestId = randomUUID();
    socket.send(
      JSON.stringify({
        v: 1,
        type: "client.request",
        requestId: shellRequestId,
        action: {
          type: "shell",
          expectedHeadId: headId,
          command: "printf USER_SHELL_E2E_OK",
          excludeFromContext: false,
        },
      }),
    );
    const shellResult = await untilFrame("shell request.result", () =>
      frames.find((frame) => frame.type === "request.result" && frame.requestId === shellRequestId),
    );
    if (shellResult.type !== "request.result" || shellResult.result.type !== "accepted") {
      throw new Error("shell request was not accepted");
    }
    const shellOperationId = shellResult.result.operationId;
    await untilFrame("shell output", () =>
      frames.find(
        (frame) =>
          frame.type === "runtime.event" &&
          frame.event.type === "output_patch" &&
          frame.event.operationId === shellOperationId &&
          frame.event.blockType === "shell" &&
          frame.event.patch.text.includes("USER_SHELL_E2E_OK"),
      ),
    );
    await untilFrame("shell history record", () =>
      frames.find(
        (frame) =>
          frame.type === "history.record" &&
          frame.record.type === "event" &&
          frame.record.eventType === "pi.bash_execution" &&
          JSON.stringify(frame.record).includes("USER_SHELL_E2E_OK"),
      ),
    );
    await untilFrame("shell operation finished", () =>
      frames.find(
        (frame) =>
          frame.type === "runtime.event" &&
          frame.event.type === "operation_finished" &&
          frame.event.operationId === shellOperationId &&
          frame.event.outcome === "completed",
      ),
    );

    const generatedName = await waitFor(
      "orb auto-named",
      async () => {
        const current = await api(base, "GET", `/api/v1/orbs/${orbId}`);
        return current.body["name"] === "Run E2E Tool Check" ? current.body["name"] : null;
      },
      { timeoutMs: 60_000, intervalMs: 1_000 },
    );
    expect(generatedName).toBe("Run E2E Tool Check");

    // Replication lands through the HTTP pull, not the WebSocket (docs/history-replication.md).
    const replicated = await waitFor(
      "history replicated to database",
      async () => {
        const snapshot = await api(base, "GET", `/api/v1/orbs/${orbId}/history`);
        const records = snapshot.body["records"] as unknown[];
        const serialized = JSON.stringify(records);
        return serialized.includes("E2E_TOOL_OK") &&
          serialized.includes("The check succeeded") &&
          serialized.includes("USER_SHELL_E2E_OK") &&
          records.length >= 5
          ? records.length
          : null;
      },
      { timeoutMs: 60_000, intervalMs: 2_000 },
    );

    // The fake saw exactly the two scripted inference turns, the second one
    // carrying the real tool output produced inside the orb.
    const requests = await fakeControl(fake.sessionKey, "/requests");
    const inferenceCalls = JSON.stringify(requests);
    expect(inferenceCalls).toContain("E2E_TOOL_OK");

    socket.close();

    // Controlled stop: drain, then host stop (docs/testing.md step 8).
    expect(terminalClosedBeforeStop, "terminal stayed open until deliberate stop").toBe(false);
    stopRequested = true;
    const stop = await api(base, "POST", `/api/v1/orbs/${orbId}/stop`);
    expect(stop.status).toBe(202);
    await waitFor(
      "orb stopped",
      async () => {
        const view = await api(base, "GET", `/api/v1/orbs/${orbId}`);
        return view.body["state"] === "stopped" ? true : null;
      },
      { timeoutMs: 120_000, intervalMs: 2_000 },
    );
    await Promise.race([
      terminalClosed,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("terminal socket did not close on stop")), 30_000),
      ),
    ]);

    // Stopped-orb history serves from the database alone (docs/testing.md step 9).
    const stopped = await api(base, "GET", `/api/v1/orbs/${orbId}/history`);
    const stoppedRecords = stopped.body["records"] as unknown[];
    expect(stoppedRecords.length).toBe(replicated);
    expect(JSON.stringify(stoppedRecords)).toContain("The check succeeded: E2E_TOOL_OK.");
    expect(JSON.stringify(stoppedRecords)).toContain("USER_SHELL_E2E_OK");

    // Whole-project deletion fans out through the same deletion-grade cleanup.
    // Keep one child stopped with replicated history and a second child running
    // so completion proves mixed-state resources are all gone before the row.
    const secondOrbId = randomUUID();
    const secondOrb = await api(base, "POST", `/api/v1/projects/${projectId}/orbs`, {
      id: secondOrbId,
    });
    expect(secondOrb.status, JSON.stringify(secondOrb.body)).toBe(202);
    await waitFor(
      "second orb running",
      async () => {
        const view = await api(base, "GET", `/api/v1/orbs/${secondOrbId}`);
        if (view.body["state"] === "failed") {
          throw new FatalProbeError(`second orb failed: ${String(view.body["lastError"])}`);
        }
        return view.body["state"] === "running" ? true : null;
      },
      { timeoutMs: 300_000, intervalMs: 2_000 },
    );

    const deletion = await api(base, "DELETE", `/api/v1/projects/${projectId}`);
    expect(deletion.status, JSON.stringify(deletion.body)).toBe(202);
    expect(deletion.body["state"]).toBe("deleting");
    expect(deletion.body["deletionProgress"]).toMatchObject({
      total: 2,
      remaining: 2,
      blocked: 0,
    });
    const lateChild = await api(base, "POST", `/api/v1/projects/${projectId}/orbs`, {
      id: randomUUID(),
    });
    expect(lateChild.status).toBe(409);

    await waitFor(
      "project deletion completed",
      async () => {
        const view = await api(base, "GET", `/api/v1/projects/${projectId}`);
        return view.status === 404 ? true : null;
      },
      { timeoutMs: 240_000, intervalMs: 1_000 },
    );
    for (const deletedOrbId of [orbId, secondOrbId]) {
      expect((await api(base, "GET", `/api/v1/orbs/${deletedOrbId}`)).status).toBe(404);
      expect((await api(base, "GET", `/api/v1/orbs/${deletedOrbId}/history`)).status).toBe(404);
      if (PROCESS_BACKEND) {
        expect(() =>
          readFileSync(
            join(localStateDirectory, "process-hosts", deletedOrbId, "host.json"),
            "utf8",
          ),
        ).toThrow();
      } else {
        expect(await orbContainerNames(deletedOrbId)).toEqual([]);
        await expect(
          docker(["volume", "inspect", `pi-orb-data-${deletedOrbId}`]),
        ).rejects.toThrow();
      }
    }
    const projects = await api(base, "GET", "/api/v1/projects");
    expect(
      (projects.body["items"] as Array<{ id: string }>).some((item) => item.id === projectId),
    ).toBe(false);
  }
});
