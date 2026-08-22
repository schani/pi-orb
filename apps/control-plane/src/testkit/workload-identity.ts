import { ApplicationFailure, type SimulationTask } from "determined";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import type { SignerError, SigningKeyConflict, StoreError } from "../domain/errors.ts";
import type {
  CasSigningKeyStateParams,
  GeneratedSigningKey,
  IdTokenClaims,
  MintIdSource,
  SigningKeyGenerator,
  SigningKeyMaterialDeps,
  SigningKeyRow,
  SigningKeyStore,
  TokenSigner,
} from "../domain/ports.ts";
import { type ActiveSigningKeyMaterial, SigningKeyMaterialCache } from "../domain/signing-keys.ts";
import { FAILPOINTS } from "./failpoints.ts";

const unavailable = (message: string): StoreError => ({
  type: "store_error",
  code: "unavailable",
  message,
  retryable: true,
});

/** A shape the schema refuses outright, so no retry can repair it. */
const corruption = (message: string): StoreError => ({
  type: "store_error",
  code: "corruption",
  message,
  retryable: false,
});

function accessGate<T>(
  task: SimulationTask,
  failpoint: string,
  reason: string,
  f: () => T,
): ResultAsync<T, StoreError> {
  const run = async (): Promise<T> => {
    await task.sleep(1 + task.random(`signing key latency: ${reason}`) * 5, reason);
    await task.failpoint(failpoint, reason);
    return f();
  };
  return ResultAsync.fromPromise(run(), (error) => {
    if (error instanceof ApplicationFailure) return unavailable(`${reason}: ${error.message}`);
    return task.abortSimulation(error);
  });
}

/**
 * Deterministic in-memory `SigningKeyStore` with the semantics the PostgreSQL
 * adapter must implement (docs/workload-identity.md), including the two shapes
 * its schema refuses: a duplicate `kid` and a second active key.
 */
export class FakeSigningKeyStore implements SigningKeyStore {
  private readonly rows = new Map<string, SigningKeyRow>();

  /** Simulates leftovers of another instance: an unfenced direct write. */
  seedKey(row: SigningKeyRow): void {
    this.rows.set(row.kid, row);
  }

  snapshot(kid: string): SigningKeyRow | null {
    return this.rows.get(kid) ?? null;
  }

  /** Every row, oldest first — the durable truth, read without a task. */
  allRows(): SigningKeyRow[] {
    return [...this.rows.values()].sort(
      (left, right) => left.createdAt - right.createdAt || compareKid(left.kid, right.kid),
    );
  }

  activeRows(): SigningKeyRow[] {
    return this.allRows().filter((row) => row.state === "active");
  }

  listSigningKeys(task: SimulationTask): ResultAsync<SigningKeyRow[], StoreError> {
    return accessGate(task, FAILPOINTS.signingKeyRead, "list signing keys", () =>
      [...this.rows.values()].sort(
        (left, right) => left.createdAt - right.createdAt || compareKid(left.kid, right.kid),
      ),
    );
  }

  insertSigningKey(
    task: SimulationTask,
    row: SigningKeyRow,
  ): ResultAsync<SigningKeyRow, StoreError> {
    return accessGate(task, FAILPOINTS.signingKeyWrite, "insert signing key", () => {
      if (this.rows.has(row.kid)) {
        return { refused: corruption(`duplicate signing key ${row.kid}`) };
      }
      if (row.state === "active" && this.activeKid(row.kid) !== null) {
        return { refused: corruption(`signing key ${row.kid} would be a second active key`) };
      }
      this.rows.set(row.kid, row);
      return { refused: null, row };
    }).andThen((outcome) =>
      outcome.refused !== null ? errAsync(outcome.refused) : okAsync(outcome.row),
    );
  }

  casSigningKeyState(
    task: SimulationTask,
    params: CasSigningKeyStateParams,
  ): ResultAsync<SigningKeyRow, StoreError | SigningKeyConflict> {
    return accessGate(task, FAILPOINTS.signingKeyWrite, "cas signing key state", () => {
      const current = this.rows.get(params.kid);
      if (current === undefined || current.rowVersion !== params.expectedRowVersion) {
        return { refused: { type: "signing_key_conflict" as const } };
      }
      if (params.state === "active" && this.activeKid(params.kid) !== null) {
        return { refused: corruption(`signing key ${params.kid} would be a second active key`) };
      }
      const updated: SigningKeyRow = {
        ...current,
        state: params.state,
        rowVersion: current.rowVersion + 1,
        ...(params.activatedAt !== undefined ? { activatedAt: params.activatedAt } : {}),
        ...(params.retiredAt !== undefined ? { retiredAt: params.retiredAt } : {}),
      };
      this.rows.set(params.kid, updated);
      return { refused: null, row: updated };
    }).andThen((outcome) =>
      outcome.refused !== null
        ? errAsync<SigningKeyRow, StoreError | SigningKeyConflict>(outcome.refused)
        : okAsync(outcome.row),
    );
  }

  /** The active key other than `exceptKid`, which is the row being written. */
  private activeKid(exceptKid: string): string | null {
    for (const row of this.rows.values()) {
      if (row.state === "active" && row.kid !== exceptKid) return row.kid;
    }
    return null;
  }
}

const compareKid = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const base64url = (value: string): string => Buffer.from(value, "utf8").toString("base64url");

/**
 * Deterministic stand-in for the RS256 signer. The output is JWT-shaped —
 * `base64url(header).base64url(claims).<signature>` — with a literal signature
 * segment, so a scenario can decode exactly what would have been signed and
 * assert on the claims. Real signature verification belongs to the stage-2
 * `node:crypto` adapter and its JWKS tests, not here.
 */
export class FakeTokenSigner implements TokenSigner {
  /** Successful signatures; the count a rate-limit scenario bounds. */
  calls = 0;

  private readonly kid: string;
  /** Remaining scripted outages, for the recovery leg a probability cannot pin down. */
  private outages = 0;

  constructor(kid = "fake-key-1") {
    this.kid = kid;
  }

  /** Fail the next `count` signatures, then serve normally again. */
  failNextSignatures(count: number): void {
    this.outages = count;
  }

  signIdToken(
    task: SimulationTask,
    claims: IdTokenClaims,
  ): ResultAsync<{ jwt: string; kid: string }, SignerError> {
    const run = async (): Promise<{ jwt: string; kid: string }> => {
      await task.sleep(1 + task.random("signer latency") * 5, "sign id token");
      await task.failpoint(FAILPOINTS.signerSign, "sign id token");
      if (this.outages > 0) {
        this.outages -= 1;
        throw new ApplicationFailure("scripted signing key outage");
      }
      this.calls += 1;
      const header = base64url(JSON.stringify({ alg: "RS256", kid: this.kid }));
      return { jwt: `${header}.${base64url(JSON.stringify(claims))}.fake`, kid: this.kid };
    };
    return ResultAsync.fromPromise(run(), (error) => {
      if (error instanceof ApplicationFailure) {
        return {
          type: "signer_error" as const,
          code: "unavailable" as const,
          message: `sign id token: ${error.message}`,
          retryable: true as const,
        };
      }
      return task.abortSimulation(error);
    });
  }
}

/** The claims a `FakeTokenSigner` JWT carries, as the relying party would read them. */
export function decodeFakeIdToken(jwt: string): IdTokenClaims {
  const segments = jwt.split(".");
  const payload = segments[1];
  if (segments.length !== 3 || payload === undefined) {
    throw new Error(`not a JWT-shaped token: ${jwt}`);
  }
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as IdTokenClaims;
}

/** The `kid` in a `FakeTokenSigner` JWT header. */
export function decodeFakeIdTokenKid(jwt: string): string {
  const header = jwt.split(".")[0];
  if (header === undefined) throw new Error(`not a JWT-shaped token: ${jwt}`);
  return String(JSON.parse(Buffer.from(header, "base64url").toString("utf8")).kid);
}

/**
 * Deterministic stand-in for RSA key generation. Real 2048-bit generation is
 * neither reproducible nor cheap enough for a simulation loop; what scenarios
 * need is a distinguishable key with a distinguishable `kid`. Each simulated
 * control-plane instance gets its own prefix, because two instances generating
 * the *same* `kid` is a collision real thumbprints do not have and would turn
 * a race scenario into a duplicate-primary-key scenario.
 */
export class FakeSigningKeyGenerator implements SigningKeyGenerator {
  /** Keys handed out, whether or not they ever reached a durable row. */
  generated = 0;

  private readonly prefix: string;

  constructor(prefix = "kid") {
    this.prefix = prefix;
  }

  generate(task: SimulationTask): ResultAsync<GeneratedSigningKey, SignerError> {
    const run = async (): Promise<GeneratedSigningKey> => {
      await task.sleep(1 + task.random("keygen latency") * 20, "generate signing key");
      await task.failpoint(FAILPOINTS.signingKeyGenerate, "generate signing key");
      this.generated += 1;
      const kid = `${this.prefix}-${this.generated}`;
      return {
        kid,
        privateKeyPem: `fake-private-key:${kid}`,
        publicJwk: { kty: "RSA", alg: "RS256", use: "sig", kid, n: `modulus-of-${kid}`, e: "AQAB" },
      };
    };
    return ResultAsync.fromPromise(run(), (error) => {
      if (error instanceof ApplicationFailure) {
        return {
          type: "signer_error" as const,
          code: "unavailable" as const,
          message: `generate signing key: ${error.message}`,
          retryable: true as const,
        };
      }
      return task.abortSimulation(error);
    });
  }
}

/**
 * A signer that goes through the real key-selection path
 * (`SigningKeyMaterialCache` over the store and the secret store) and fakes
 * only the cryptography. That is the split that matters for simulation: which
 * key signs, and whether it is published, are product decisions worth racing;
 * RSA itself is covered by `adapters/oidc/jose.test.ts`.
 */
export class KeyStoreBackedTokenSigner implements TokenSigner {
  /** Successful signatures. */
  calls = 0;

  private readonly deps: SigningKeyMaterialDeps;
  private readonly cache = new SigningKeyMaterialCache();

  constructor(deps: SigningKeyMaterialDeps) {
    this.deps = deps;
  }

  signIdToken(
    task: SimulationTask,
    claims: IdTokenClaims,
  ): ResultAsync<{ jwt: string; kid: string }, SignerError> {
    return this.cache.load(task, this.deps).andThen((material) =>
      ResultAsync.fromPromise(this.signWith(task, material, claims), (error) => {
        if (error instanceof ApplicationFailure) {
          return {
            type: "signer_error" as const,
            code: "signing_failed" as const,
            message: `sign id token: ${error.message}`,
            retryable: true as const,
          };
        }
        return task.abortSimulation(error);
      }),
    );
  }

  private async signWith(
    task: SimulationTask,
    material: ActiveSigningKeyMaterial,
    claims: IdTokenClaims,
  ): Promise<{ jwt: string; kid: string }> {
    await task.sleep(1 + task.random("signer latency") * 5, "sign id token");
    await task.failpoint(FAILPOINTS.signerSign, "sign id token");
    this.calls += 1;
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: material.kid }));
    // The signature names the material it came from, so a scenario can prove a
    // token was signed with the key its header claims and not merely labelled.
    const signature = base64url(material.privateKeyPem);
    return {
      jwt: `${header}.${base64url(JSON.stringify(claims))}.${signature}`,
      kid: material.kid,
    };
  }
}

/** The private material a `KeyStoreBackedTokenSigner` token was signed with. */
export function decodeFakeSignatureMaterial(jwt: string): string {
  const signature = jwt.split(".")[2];
  if (signature === undefined) throw new Error(`not a JWT-shaped token: ${jwt}`);
  return Buffer.from(signature, "base64url").toString("utf8");
}

/**
 * Counter-based `jti` source. Uniqueness under concurrent mints is the
 * property scenarios assert, and a counter makes a duplicate a real defect
 * rather than an entropy coincidence.
 */
export class FakeMintIdSource implements MintIdSource {
  private counter = 0;

  newJti(_task: SimulationTask): string {
    this.counter += 1;
    return `jti-${this.counter}`;
  }
}
