import type { SimulationTask } from "determined";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import type { SignerError, SigningKeyConflict, StoreError } from "./errors.ts";
import { logEvent } from "./log.ts";
import type {
  JwksDeps,
  SigningKeyDeps,
  SigningKeyMaterialDeps,
  SigningKeyRow,
  SigningKeyStore,
  StoredSigningKey,
} from "./ports.ts";

/**
 * Issuer signing-key management (docs/workload-identity.md, "Issuer and
 * signing requirements"). Three durable states — `pending`, `active`,
 * `retired` — and one rule the schema enforces: at most one key is active.
 *
 * JWKS publishes `pending` + `active` + recently `retired` keys, which is what
 * makes overlapping rotation work. A key is published *before* it signs
 * anything and stays published after it stops, so a verifier holding a cached
 * key set can always explain a token that is still inside its own lifetime.
 *
 * This module is the one place in the domain that touches private key
 * material: it has to carry a generated PEM from the generator port to the
 * secret store, and back out of the secret store to the signer adapter. It
 * never logs it, never returns it in an error, and never writes it anywhere
 * but the secret store. `node:crypto` stays out of the domain entirely
 * (docs/testing.md): generation is a port, signing is the `TokenSigner`
 * adapter's job.
 */

/**
 * The secret-store provider name holding issuer private keys. One parent
 * secret, one immutable version per key, addressed exactly — never `latest`
 * (docs/credentials.md).
 */
export const SIGNING_KEY_SECRET_PROVIDER = "oidc-signing-key";

/**
 * How many times a convergence loop re-reads after losing a race. Every
 * iteration is provoked by another instance having made progress, so a small
 * bound is enough; exhausting it is reported as unavailable rather than
 * spinning.
 */
const MAX_CONVERGENCE_ATTEMPTS = 4;

const signerError = (code: SignerError["code"], message: string): SignerError => ({
  type: "signer_error",
  code,
  message,
  retryable: true,
});

const unavailable = (message: string): SignerError => signerError("unavailable", message);

/**
 * Any store trouble on a key path is "no usable signing material", which is
 * the only thing the caller can act on: the issuer fails closed and the
 * request is retried. A `corruption`/`invariant` store error keeps its message
 * so the boot log still names the real cause.
 */
function fromStore(reason: string, error: StoreError | SigningKeyConflict): SignerError {
  if (error.type === "signing_key_conflict") return unavailable(`${reason}: lost a CAS race`);
  return unavailable(`${reason}: ${error.message}`);
}

/** The most recently published key awaiting activation, if any. */
function newestPending(rows: readonly SigningKeyRow[]): SigningKeyRow | undefined {
  let newest: SigningKeyRow | undefined;
  for (const row of rows) {
    if (row.state !== "pending") continue;
    if (newest === undefined || row.createdAt > newest.createdAt) newest = row;
  }
  return newest;
}

const activeRow = (rows: readonly SigningKeyRow[]): SigningKeyRow | undefined =>
  rows.find((row) => row.state === "active");

function listKeys(
  task: SimulationTask,
  keys: SigningKeyStore,
): ResultAsync<SigningKeyRow[], SignerError> {
  return keys.listSigningKeys(task).mapErr((error) => fromStore("list signing keys", error));
}

/**
 * Ensures the deployment can sign, and returns the key it will sign with.
 *
 * Idempotent and safe to run on every boot of every instance that mints. The
 * three cases, in the order they are preferred:
 *
 * 1. A key is already active: nothing to do. This is the steady state.
 * 2. A key is published but not active — a rotation that crashed between
 *    retiring the old key and activating the new one, or one that has not
 *    reached activation yet. It is activated rather than replaced: it is
 *    already in JWKS, so verifiers can explain its signatures immediately.
 * 3. Nothing exists at all (first boot, or a deployment whose keys were all
 *    retired). A key is generated, its private half written to the secret
 *    store, and the row inserted *directly* as `active`. Publishing it as
 *    `pending` first would buy nothing: the alternative to signing with an
 *    unseen key here is not signing at all, and no verifier can hold a cached
 *    key set that would have explained a key that never existed. Ordinary key
 *    changes take the overlapping path in `rotateSigningKey` instead.
 *
 * Two instances booting together race on the unique-active index, not on a
 * read: the loser's insert or CAS is refused, it re-reads, destroys the secret
 * version nobody references, and returns the winner's key. It never destroys a
 * version whose row it cannot prove is absent — an unreferenced version is
 * inert, while destroying a referenced one would break the issuer permanently.
 *
 * Fails closed on a secret store or key store that cannot be reached: no
 * unsigned tokens, no fallback key (docs/workload-identity.md).
 */
export function ensureActiveSigningKey(
  task: SimulationTask,
  deps: SigningKeyDeps,
  options: { readonly now: number },
): ResultAsync<SigningKeyRow, SignerError> {
  const run = async (): Promise<Result<SigningKeyRow, SignerError>> => {
    let lastFailure = unavailable("no active signing key could be established");
    for (let attempt = 0; attempt < MAX_CONVERGENCE_ATTEMPTS; attempt++) {
      const rows = await listKeys(task, deps.keys);
      if (rows.isErr()) return err(rows.error);

      const active = activeRow(rows.value);
      if (active !== undefined) return ok(active);

      const pending = newestPending(rows.value);
      if (pending !== undefined) {
        const activated = await deps.keys.casSigningKeyState(task, {
          kid: pending.kid,
          expectedRowVersion: pending.rowVersion,
          state: "active",
          activatedAt: options.now,
        });
        if (activated.isOk()) {
          // Which key the deployment signs with is a security fact, and this
          // one was decided by machinery rather than by an operator.
          logEvent(task, "issuer-key-activated", {
            kid: activated.value.kid,
            reason: "adopted_published",
          });
          return ok(activated.value);
        }
        lastFailure = fromStore("activate published signing key", activated.error);
        continue;
      }

      const generated = await deps.generator.generate(task);
      if (generated.isErr()) return err(generated.error);
      const written = await deps.secrets.writeSecret<StoredSigningKey>(
        task,
        SIGNING_KEY_SECRET_PROVIDER,
        { privateKeyPem: generated.value.privateKeyPem },
      );
      if (written.isErr()) return err(fromStore("write signing key material", written.error));
      const secretVersion = written.value.version;

      const inserted = await deps.keys.insertSigningKey(task, {
        kid: generated.value.kid,
        secretVersion,
        publicJwk: generated.value.publicJwk,
        state: "active",
        createdAt: options.now,
        activatedAt: options.now,
        retiredAt: null,
        rowVersion: 0,
      });
      if (inserted.isOk()) {
        logEvent(task, "issuer-key-activated", { kid: inserted.value.kid, reason: "created" });
        return ok(inserted.value);
      }
      lastFailure = fromStore("insert signing key", inserted.error);

      // The insert failed, which does not prove it did not commit — a dropped
      // response after a committed write looks the same from here. Re-read
      // before touching the secret version.
      const after = await listKeys(task, deps.keys);
      if (after.isErr()) return err(after.error);
      const ours = after.value.find((row) => row.kid === generated.value.kid);
      if (ours !== undefined) {
        if (ours.state === "active") return ok(ours);
        continue;
      }
      const winner = activeRow(after.value);
      if (winner !== undefined) {
        // Our row is absent *and* someone else is active, which together prove
        // the version is unreferenced forever: our insert asked for `active`,
        // so the unique-active index can no longer admit it even if the write
        // we lost the answer to is still in flight. Without an active winner
        // that proof does not hold, and the version is left alone rather than
        // risking an active row whose material is gone. Failing to destroy it
        // is not worth failing the boot over — it is inert either way.
        await deps.secrets.destroySecret(task, SIGNING_KEY_SECRET_PROVIDER, secretVersion);
        logEvent(task, "issuer-key-race-lost", {
          kid: generated.value.kid,
          active: winner.kid,
        });
        return ok(winner);
      }
    }
    return err(lastFailure);
  };
  return new ResultAsync(run());
}

/**
 * Publishes a key without signing with it, resuming an interrupted rotation
 * rather than stacking a second pending key on top of it.
 */
function publishPendingKey(
  task: SimulationTask,
  deps: SigningKeyDeps,
  now: number,
): ResultAsync<SigningKeyRow, SignerError> {
  const run = async (): Promise<Result<SigningKeyRow, SignerError>> => {
    const rows = await listKeys(task, deps.keys);
    if (rows.isErr()) return err(rows.error);
    const existing = newestPending(rows.value);
    if (existing !== undefined) {
      logEvent(task, "issuer-key-rotation-resumed", { kid: existing.kid });
      return ok(existing);
    }

    const generated = await deps.generator.generate(task);
    if (generated.isErr()) return err(generated.error);
    const written = await deps.secrets.writeSecret<StoredSigningKey>(
      task,
      SIGNING_KEY_SECRET_PROVIDER,
      { privateKeyPem: generated.value.privateKeyPem },
    );
    if (written.isErr()) return err(fromStore("write signing key material", written.error));
    const secretVersion = written.value.version;

    const inserted = await deps.keys.insertSigningKey(task, {
      kid: generated.value.kid,
      secretVersion,
      publicJwk: generated.value.publicJwk,
      state: "pending",
      createdAt: now,
      activatedAt: null,
      retiredAt: null,
      rowVersion: 0,
    });
    if (inserted.isOk()) {
      // Published, not yet signing: the edge a verifier's cache refresh is
      // measured against if a rotation later turns out to have been too fast.
      logEvent(task, "issuer-key-published", { kid: inserted.value.kid });
      return ok(inserted.value);
    }

    const after = await listKeys(task, deps.keys);
    if (after.isOk()) {
      const ours = after.value.find((row) => row.kid === generated.value.kid);
      // The insert committed after all; the response was simply lost.
      if (ours !== undefined) return ok(ours);
    }
    // The version is deliberately left in place even though no row names it.
    // Unlike the boot path, this insert asks for `pending`, which no index
    // refuses, so a write whose answer was lost may still land — and a
    // published key whose material was destroyed is a key the next boot would
    // activate into an issuer that cannot sign. An unreferenced version costs
    // nothing; this is an operator-run path, and the operator sees the error.
    return err(fromStore("publish signing key", inserted.error));
  };
  return new ResultAsync(run());
}

/**
 * Rotates to a new signing key with the overlap the doc requires, in three
 * durable steps. It is an ops action, not something a loop runs, and it may be
 * re-invoked after a crash: every step is a fenced write, and re-running the
 * sequence resumes from wherever it stopped.
 *
 * 1. **Publish.** Generate, store the private half, insert the row as
 *    `pending`. JWKS now serves the old active key *and* the new one, so a
 *    verifier can refresh its cache before any token is signed with the new
 *    key. Nothing signs with it yet.
 * 2. **Retire the old key.** CAS `active` → `retired`. It keeps being
 *    published for the overlap window, so tokens it already signed keep
 *    verifying.
 * 3. **Activate the new key.** CAS `pending` → `active`.
 *
 * Steps 2 and 3 cannot be one write: the schema permits exactly one active key,
 * so the old one has to leave before the new one arrives. That leaves a window
 * in which no key is active. A crash inside it is not a lost issuer: minting
 * fails closed with a retryable error until either this call is repeated or
 * `ensureActiveSigningKey` — which any minting instance runs at boot — finds
 * the published key and activates it. A crash after step 1 leaves the old key
 * signing and one extra published key, which is also safe, and re-running
 * rotation adopts that key instead of generating another.
 *
 * Two rotations racing is the only messy case: both publish, one wins the
 * activation, and the loser's key stays published but unused until some later
 * rotation or recovery adopts it. It is a valid, fully backed key; nothing
 * signs with it in the meantime.
 */
export function rotateSigningKey(
  task: SimulationTask,
  deps: SigningKeyDeps,
  options: { readonly now: number },
): ResultAsync<SigningKeyRow, SignerError> {
  const run = async (): Promise<Result<SigningKeyRow, SignerError>> => {
    const published = await publishPendingKey(task, deps, options.now);
    if (published.isErr()) return err(published.error);
    const targetKid = published.value.kid;

    let lastFailure = unavailable(`signing key ${targetKid} could not be activated`);
    for (let attempt = 0; attempt < MAX_CONVERGENCE_ATTEMPTS; attempt++) {
      const rows = await listKeys(task, deps.keys);
      if (rows.isErr()) return err(rows.error);

      const active = activeRow(rows.value);
      // Our key is live — either we activated it or a concurrent recovery did.
      if (active !== undefined && active.kid === targetKid) return ok(active);
      if (active !== undefined) {
        const retired = await deps.keys.casSigningKeyState(task, {
          kid: active.kid,
          expectedRowVersion: active.rowVersion,
          state: "retired",
          retiredAt: options.now,
        });
        if (retired.isErr()) {
          lastFailure = fromStore("retire previous signing key", retired.error);
          continue;
        }
        logEvent(task, "issuer-key-retired", { kid: active.kid, successor: targetKid });
      }

      const target = rows.value.find((row) => row.kid === targetKid);
      if (target === undefined) {
        return err(unavailable(`published signing key ${targetKid} disappeared before activation`));
      }
      const activated = await deps.keys.casSigningKeyState(task, {
        kid: targetKid,
        expectedRowVersion: target.rowVersion,
        state: "active",
        activatedAt: options.now,
      });
      if (activated.isOk()) {
        logEvent(task, "issuer-key-activated", { kid: activated.value.kid, reason: "rotation" });
        return ok(activated.value);
      }
      lastFailure = fromStore("activate signing key", activated.error);
    }
    return err(lastFailure);
  };
  return new ResultAsync(run());
}

/** What JWKS serves: public JWKs only, and never anything else. */
export interface Jwks {
  readonly keys: readonly unknown[];
}

/**
 * The public key set, as the discovery/JWKS endpoint serves it: the active key
 * first, then keys published but not yet signing, then keys retired inside the
 * overlap window. Contains no secret and needs no secret-store access, which
 * is what lets the issuer role run without one.
 *
 * A retired key leaves the set only once `retiredAt + jwksOverlapMs` has
 * passed — long enough to cover the longest token it could have signed plus
 * verifier cache staleness and clock skew. Rows are not deleted here: removing
 * the row and destroying its secret version is separate work
 * (docs/workload-identity.md), and publishing an extra public key is harmless
 * where dropping one too early breaks live tokens. A retired row with no
 * timestamp is therefore kept rather than guessed about.
 */
export function assembleJwks(
  task: SimulationTask,
  deps: JwksDeps,
  options: { readonly now: number },
): ResultAsync<Jwks, StoreError> {
  return deps.keys.listSigningKeys(task).map((rows) => {
    const inOverlap = (row: SigningKeyRow): boolean =>
      row.retiredAt === null || options.now - row.retiredAt <= deps.constants.jwksOverlapMs;
    const published = [
      ...rows.filter((row) => row.state === "active"),
      ...rows.filter((row) => row.state === "pending"),
      ...rows.filter((row) => row.state === "retired" && inOverlap(row)),
    ];
    return { keys: published.map((row) => row.publicJwk) };
  });
}

/** The private half of the key the issuer signs with right now. */
export interface ActiveSigningKeyMaterial {
  readonly kid: string;
  /** The exact secret version the material came from; part of the cache key. */
  readonly secretVersion: string;
  readonly privateKeyPem: string;
}

/** The row the issuer signs with, or a typed refusal to sign at all. */
export function activeSigningKeyRow(
  task: SimulationTask,
  deps: SigningKeyMaterialDeps,
): ResultAsync<SigningKeyRow, SignerError> {
  return listKeys(task, deps.keys).andThen((rows) => {
    const active = activeRow(rows);
    return active === undefined
      ? err(unavailable("no active signing key"))
      : ok<SigningKeyRow, SignerError>(active);
  });
}

function readKeyMaterial(
  task: SimulationTask,
  deps: SigningKeyMaterialDeps,
  row: SigningKeyRow,
): ResultAsync<ActiveSigningKeyMaterial, SignerError> {
  return deps.secrets
    .readSecret<StoredSigningKey>(task, SIGNING_KEY_SECRET_PROVIDER, row.secretVersion)
    .mapErr((error) => fromStore(`read signing key material for ${row.kid}`, error))
    .andThen((stored) => {
      // A destroyed or absent version, or a payload that is not a key, is an
      // issuer that cannot sign — never a reason to reach for another key.
      if (stored === null || typeof stored.privateKeyPem !== "string") {
        return err(unavailable(`signing key material for ${row.kid} is unusable`));
      }
      return ok<ActiveSigningKeyMaterial, SignerError>({
        kid: row.kid,
        secretVersion: row.secretVersion,
        privateKeyPem: stored.privateKeyPem,
      });
    });
}

/**
 * Reads the current signing material: one row read plus one exact-version
 * secret read. Fails closed at every step.
 */
export function loadActiveSigningKeyMaterial(
  task: SimulationTask,
  deps: SigningKeyMaterialDeps,
): ResultAsync<ActiveSigningKeyMaterial, SignerError> {
  return activeSigningKeyRow(task, deps).andThen((row) => readKeyMaterial(task, deps, row));
}

/**
 * Steady-state signing without a secret read per token. The active row is
 * still read every time — it is the authority on which key signs, and a
 * rotation has to take effect immediately — but the private material is
 * reused while the row still points at the same `kid` *and* the same secret
 * version. Any change to either is a cache miss, so material never survives a
 * rotation and a re-keyed row can never be signed with the old PEM.
 */
export class SigningKeyMaterialCache {
  private cached: ActiveSigningKeyMaterial | null = null;

  load(
    task: SimulationTask,
    deps: SigningKeyMaterialDeps,
  ): ResultAsync<ActiveSigningKeyMaterial, SignerError> {
    return activeSigningKeyRow(task, deps).andThen((row) => {
      const cached = this.cached;
      if (cached !== null && cached.kid === row.kid && cached.secretVersion === row.secretVersion) {
        return ok<ActiveSigningKeyMaterial, SignerError>(cached);
      }
      return readKeyMaterial(task, deps, row).map((material) => {
        this.cached = material;
        return material;
      });
    });
  }
}
