import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createPublicKey, createVerify } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const FAKE_ORIGIN = process.env["PI_ORB_FAKE_OPENAI"] ?? "https://fake-openai.flingit.run";

export interface FakeSession {
  sessionKey: string;
  oauthBaseUrl: string;
  inferenceBaseUrl: string;
}

const controlUrl = (sessionKey: string, path = ""): string =>
  `${FAKE_ORIGIN}/api/__mock__/sessions/${sessionKey}${path}`;

export async function createFakeSession(name: string, scenario: unknown): Promise<FakeSession> {
  const response = await fetch(`${FAKE_ORIGIN}/api/__mock__/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, scenario }),
  });
  if (!response.ok) throw new Error(`fake session creation failed: HTTP ${response.status}`);
  const body = (await response.json()) as Record<string, unknown>;
  return {
    sessionKey: String(body["sessionKey"]),
    oauthBaseUrl: String(body["oauthBaseUrl"]),
    inferenceBaseUrl: String(body["inferenceBaseUrl"]),
  };
}

export async function fakeControl(
  sessionKey: string,
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetch(controlUrl(sessionKey, path), {
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    throw new Error(`fake control ${path} failed: HTTP ${response.status}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

export async function deleteFakeSession(sessionKey: string): Promise<void> {
  await fetch(controlUrl(sessionKey), { method: "DELETE" }).catch(() => undefined);
}

export function docker(args: string[], timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    // killSignal SIGKILL: a docker CLI wedged against a distressed daemon can
    // ignore SIGTERM, and a hanging helper turns one failed test into an
    // hours-long silent teardown (observed 2026-08-16).
    execFile(
      "docker",
      args,
      { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 16e6 },
      (error, stdout, stderr) => {
        if (error !== null) reject(new Error(`docker ${args[0]}: ${stderr || error.message}`));
        else resolve(stdout.trim());
      },
    );
  });
}

export interface CommandOutcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * `docker` for commands whose *failure* is the assertion: the exit code and
 * both streams come back instead of a rejection, so a CLI's usage contract
 * (nonzero code, nothing on stdout) can be checked directly.
 */
export function dockerOutcome(args: string[], timeoutMs = 120_000): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    execFile(
      "docker",
      args,
      { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 16e6 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : Number.NaN;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

export interface IssuerKeySet {
  readonly issuer: string;
  readonly jwksUri: string;
  readonly keys: readonly Record<string, unknown>[];
}

/**
 * The relying party's half of docs/workload-identity.md: everything an
 * external verifier is told to do, done with `node:crypto` alone — read
 * discovery, fetch the advertised JWKS, and verify signature and claims
 * offline. No pi-orb code participates, which is the point: a token this
 * rejects would be rejected by GCP STS too.
 */
export async function fetchIssuerKeys(baseUrl: string): Promise<IssuerKeySet> {
  const discoveryResponse = await fetch(`${baseUrl}/.well-known/openid-configuration`);
  if (!discoveryResponse.ok) {
    throw new Error(`discovery document: HTTP ${discoveryResponse.status}`);
  }
  const discovery = (await discoveryResponse.json()) as Record<string, unknown>;
  const issuer = String(discovery["issuer"]);
  const jwksUri = String(discovery["jwks_uri"]);
  // Follow the advertised URI rather than a guessed path: a discovery document
  // pointing at a key set that is not served is itself a failure.
  const jwksResponse = await fetch(jwksUri);
  if (!jwksResponse.ok) throw new Error(`JWKS: HTTP ${jwksResponse.status}`);
  const jwks = (await jwksResponse.json()) as { keys?: Record<string, unknown>[] };
  return { issuer, jwksUri, keys: jwks.keys ?? [] };
}

export type RelyingPartyVerdict =
  | { readonly ok: true; readonly claims: Record<string, unknown>; readonly kid: string }
  | { readonly ok: false; readonly reason: string };

function decodeSegment(segment: string): Buffer {
  return Buffer.from(segment, "base64url");
}

/**
 * Verifies one token the way a relying party must: signature against the
 * served JWKS by `kid`, exact issuer, exact audience, unexpired, and
 * `token_use=exchanged`. Everything else — project, orb, incarnation — is the
 * caller's policy and is asserted on the returned claims.
 */
export function verifyIdToken(
  token: string,
  options: {
    keys: readonly Record<string, unknown>[];
    issuer: string;
    audience: string;
    nowMs?: number;
    clockSkewSeconds?: number;
  },
): RelyingPartyVerdict {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "not three JWT segments" };
  const [headerSegment, payloadSegment, signatureSegment] = parts as [string, string, string];
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(decodeSegment(headerSegment).toString("utf8")) as Record<string, unknown>;
    claims = JSON.parse(decodeSegment(payloadSegment).toString("utf8")) as Record<string, unknown>;
  } catch (error) {
    return { ok: false, reason: `undecodable JWT: ${String(error)}` };
  }
  if (header["alg"] !== "RS256")
    return { ok: false, reason: `unexpected alg ${String(header["alg"])}` };
  const kid = String(header["kid"] ?? "");
  const jwk = options.keys.find((key) => key["kid"] === kid);
  if (jwk === undefined) return { ok: false, reason: `no JWKS key for kid ${kid}` };

  let verified = false;
  try {
    const publicKey = createPublicKey({ key: jwk as never, format: "jwk" });
    verified = createVerify("RSA-SHA256")
      .update(`${headerSegment}.${payloadSegment}`)
      .verify(publicKey, decodeSegment(signatureSegment));
  } catch (error) {
    return { ok: false, reason: `signature check failed: ${String(error)}` };
  }
  if (!verified) return { ok: false, reason: "signature does not verify" };

  if (claims["iss"] !== options.issuer) {
    return { ok: false, reason: `issuer ${String(claims["iss"])} is not ${options.issuer}` };
  }
  if (claims["aud"] !== options.audience) {
    return { ok: false, reason: `audience ${String(claims["aud"])} is not ${options.audience}` };
  }
  if (claims["token_use"] !== "exchanged") {
    return { ok: false, reason: `token_use ${String(claims["token_use"])} is not exchanged` };
  }
  const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1000);
  const skew = options.clockSkewSeconds ?? 60;
  const exp = Number(claims["exp"]);
  const iat = Number(claims["iat"]);
  if (!Number.isFinite(exp) || !Number.isFinite(iat)) {
    return { ok: false, reason: "missing iat/exp" };
  }
  if (nowSeconds > exp + skew) return { ok: false, reason: "token expired" };
  if (nowSeconds + skew < iat) return { ok: false, reason: "token issued in the future" };
  return { ok: true, claims, kid };
}

/**
 * Every container of one orb, any incarnation, by the Docker provider's orb
 * label (container names carry an `-i<incarnation>` suffix, so name-based
 * lookups go stale across compute replacement).
 */
export async function orbContainerNames(orbId: string): Promise<string[]> {
  const names = await docker([
    "ps",
    "--all",
    "--filter",
    `label=pi-orb.orb-id=${orbId}`,
    "--format",
    "{{.Names}}",
  ]);
  return names
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** Best-effort cleanup of one orb's containers across all incarnations. */
export async function removeOrbContainers(orbId: string): Promise<void> {
  const names = await orbContainerNames(orbId).catch(() => [] as string[]);
  for (const name of names) {
    await docker(["rm", "-f", name]).catch(() => undefined);
  }
}

/** Thrown by a probe to abort a waitFor immediately instead of retrying. */
export class FatalProbeError extends Error {}

export async function waitFor<T>(
  what: string,
  probe: () => Promise<T | null>,
  options?: { timeoutMs?: number; intervalMs?: number },
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? 60_000;
  const intervalMs = options?.intervalMs ?? 1_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe().catch((error: unknown) => {
      if (error instanceof FatalProbeError) throw error;
      return null;
    });
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export interface ControlPlaneHandle {
  process: ChildProcess;
  port: number;
  baseUrl: string;
  authDir: string;
  logs: string[];
  stop(): Promise<void>;
}

export async function startControlPlane(options: {
  databaseUrl?: string;
  pglitePath?: string;
  processStateDirectory?: string;
  port: number;
  fake: FakeSession;
  nameFake?: FakeSession;
  dockerNetwork?: string;
  runtimeImage?: string;
  launchFailureMarker?: string;
  hostSpecGeneration?: number;
  e2eHostSpec?: string;
  authDir?: string;
}): Promise<ControlPlaneHandle> {
  const authDir = options.authDir ?? mkdtempSync(join(tmpdir(), "pi-orb-e2e-auth-"));
  const logs: string[] = [];
  const child = spawn("node", ["apps/control-plane/src/main.ts"], {
    cwd: join(import.meta.dirname, ".."),
    env: {
      ...process.env,
      ...(options.pglitePath === undefined
        ? { DATABASE_URL: options.databaseUrl }
        : {
            PI_ORB_DATABASE_KIND: "pglite",
            PI_ORB_PGLITE_PATH: options.pglitePath,
            PI_ORB_HOST_PROVIDER: "process",
            PI_ORB_PROCESS_STATE_DIR: options.processStateDirectory,
          }),
      PORT: String(options.port),
      PI_ORB_AUTH_DIR: authDir,
      PI_ORB_RUNTIME_IMAGE: options.runtimeImage,
      PI_ORB_DOCKER_NETWORK: options.dockerNetwork,
      PI_ORB_E2E_LAUNCH_FAILURE_MARKER: options.launchFailureMarker,
      PI_ORB_HOST_SPEC_GENERATION: String(options.hostSpecGeneration ?? 0),
      PI_ORB_E2E_HOST_SPEC: options.e2eHostSpec,
      PI_ORB_FAKE_OPENAI_OAUTH_URL: options.fake.oauthBaseUrl,
      PI_ORB_FAKE_OPENAI_INFERENCE_URL: options.fake.inferenceBaseUrl,
      ...(options.nameFake === undefined
        ? {}
        : { PI_ORB_NAME_INFERENCE_URL: options.nameFake.inferenceBaseUrl }),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => logs.push(chunk.toString()));

  const baseUrl = `http://127.0.0.1:${options.port}`;
  await waitFor(
    "control plane HTTP",
    async () => {
      const response = await fetch(`${baseUrl}/api/v1/projects`);
      return response.ok ? true : null;
    },
    { timeoutMs: 30_000, intervalMs: 500 },
  );
  return {
    process: child,
    port: options.port,
    baseUrl,
    authDir,
    logs,
    stop: () =>
      new Promise((resolve) => {
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
        setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 10_000).unref();
      }),
  };
}

export async function api(
  baseUrl: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, body: parsed };
}
