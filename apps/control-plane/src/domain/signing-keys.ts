import type { SimulationTask } from "determined";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import type { SignerError, SigningKeyConflict, StoreError } from "./errors.ts";
import { logEvent } from "./log.ts";
import type {
  GeneratedSigningKey,
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
 * The key it generates is generated *once* and carried across every
 * convergence attempt, so a store that keeps refusing costs one orphaned
 * private key at worst rather than one per attempt per boot retry.
 *
 * Success means the deployment can actually sign: the material behind the row
 * is read before the row is returned. Without that check an issuer whose
 * secret version was destroyed boots "healthy" and the only symptom is a
 * per-orb `signer_failure` on the first workload that asks for a token.
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
    /** Generated at most once, and reused by every later attempt. */
    let generated: GeneratedSigningKey | null = null;
    /** The one private-key version this call wrote, if it got that far. */
    let secretVersion: string | null = null;
    /** True once a durable row is known to name `secretVersion`. */
    let referenced = false;

    /**
     * Drops the material this call generated once nothing can ever reference
     * it: our row was absent from the read that produced `winner` *and* some
     * other key holds the active slot, so the unique-active index can no
     * longer admit the insert we asked for — even if the write whose answer we
     * lost is still in flight. Without that proof the version stays put: an
     * unreferenced version is inert, while destroying a referenced one would
     * break the issuer permanently. Failing to destroy it is likewise not
     * worth failing a boot over.
     */
    const dropOrphanedMaterial = async (winner: SigningKeyRow): Promise<void> => {
      if (generated === null || secretVersion === null || referenced) return;
      if (winner.kid === generated.kid) return;
      await deps.secrets.destroySecret(task, SIGNING_KEY_SECRET_PROVIDER, secretVersion);
      secretVersion = null;
      logEvent(task, "issuer-key-race-lost", { kid: generated.kid, active: winner.kid });
    };

    /** Every successful exit: clean up the race loss, then prove we can sign. */
    const settle = async (row: SigningKeyRow): Promise<Result<SigningKeyRow, SignerError>> => {
      await dropOrphanedMaterial(row);
      const material = await readKeyMaterial(task, deps, row);
      if (material.isOk()) return ok(row);
      // An issuer that cannot read its own key is not a healthy boot, and this
      // is the one moment where that is cheap to notice and durable to say.
      logEvent(task, "issuer-key-unusable", { kid: row.kid });
      return err(material.error);
    };

    for (let attempt = 0; attempt < MAX_CONVERGENCE_ATTEMPTS; attempt++) {
      const rows = await listKeys(task, deps.keys);
      if (rows.isErr()) return err(rows.error);
      // A refused insert does not prove the write did not commit — a dropped
      // response after a committed write looks exactly the same from here — so
      // the next read, not the failure, decides whether our version is live.
      const ourKid = generated?.kid;
      if (ourKid !== undefined && rows.value.some((row) => row.kid === ourKid)) referenced = true;

      const active = activeRow(rows.value);
      if (active !== undefined) return settle(active);

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
          return settle(activated.value);
        }
        lastFailure = fromStore("activate published signing key", activated.error);
        continue;
      }

      if (generated === null) {
        const made = await deps.generator.generate(task);
        if (made.isErr()) return err(made.error);
        generated = made.value;
      }
      if (secretVersion === null) {
        const written = await deps.secrets.writeSecret<StoredSigningKey>(
          task,
          SIGNING_KEY_SECRET_PROVIDER,
          { privateKeyPem: generated.privateKeyPem },
        );
        if (written.isErr()) return err(fromStore("write signing key material", written.error));
        secretVersion = written.value.version;
      }

      const inserted = await deps.keys.insertSigningKey(task, {
        kid: generated.kid,
        secretVersion,
        publicJwk: generated.publicJwk,
        state: "active",
        createdAt: options.now,
        activatedAt: options.now,
        retiredAt: null,
        rowVersion: 0,
      });
      if (inserted.isOk()) {
        referenced = true;
        logEvent(task, "issuer-key-activated", { kid: inserted.value.kid, reason: "created" });
        return settle(inserted.value);
      }
      lastFailure = fromStore("insert signing key", inserted.error);
    }

    // Out of attempts with material written that no row was ever seen to
    // claim. One last read is the only chance to apply the proof above before
    // this call forgets which version it wrote.
    const orphanKid = generated?.kid;
    if (orphanKid !== undefined && secretVersion !== null && !referenced) {
      const final = await listKeys(task, deps.keys);
      if (final.isOk() && !final.value.some((row) => row.kid === orphanKid)) {
        const winner = activeRow(final.value);
        if (winner !== undefined) await dropOrphanedMaterial(winner);
      }
    }
    return err(lastFailure);
  };
  return new ResultAsync(run());
}

/**
 * Rotation stage one, and an operator entry point in its own right
 * (`http/routes.ts`): publish a key without signing with it, resuming an
 * interrupted rotation rather than stacking a second pending key on top of it.
 *
 * Publishing alone changes nothing a verifier can observe except that JWKS
 * grows a key nothing has signed with. That is the whole point of the staged
 * flow: the operator publishes, waits for verifier caches to turn over, and
 * only then activates.
 */
export function publishSigningKey(
  task: SimulationTask,
  deps: SigningKeyDeps,
  options: { readonly now: number },
): ResultAsync<SigningKeyRow, SignerError> {
  return publishPendingKey(task, deps, options.now);
}

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
 * Why a rotation may refuse before it writes anything. Distinct from
 * `SignerError`, which is always retryable: these two are decisions, and the
 * operator — not a retry loop — is the one who acts on them.
 */
export interface RotationRefused {
  readonly type: "rotation_refused";
  /**
   * `nothing_published`: no `pending` key exists to activate, so publish
   * first. `soak`: the newest published key has not been in JWKS long enough
   * for verifier caches to have turned over.
   */
  readonly reason: "nothing_published" | "soak";
  readonly message: string;
  /** How much longer the soak window has to run. */
  readonly remainingMs?: number;
}

export type RotationError = SignerError | RotationRefused;

/**
 * Rotation stage two: retire the key that is signing now and activate the one
 * already published (`publishSigningKey`). It is an ops action, not something
 * a loop runs, and it may be re-invoked after a crash — every write is fenced,
 * and re-running resumes from wherever it stopped.
 *
 * The two writes cannot be one: the schema permits exactly one active key, so
 * the old one has to leave before the new one arrives. That leaves a window in
 * which none is active. A crash inside it is not a lost issuer: minting fails
 * closed with a retryable error until either this call is repeated or
 * `ensureActiveSigningKey` — which any minting instance runs at boot — finds
 * the published key and activates it.
 *
 * Retirement is fenced to the *exact* row that was active when this call
 * started, not to whatever is active when the loop gets around to it. Two
 * rotations converging at once would otherwise let the slower one retire the
 * key the faster one just activated — leaving the deployment with no active
 * key for no reason, and, before the fresh key could be re-activated,
 * attempting the one write nothing may ever make: `retired` → `active`. A key
 * that has left the signing set stays out of it; the schema refuses the
 * resurrection and, more importantly, so does the design, because a
 * resurrected key re-enters signing without the publish overlap that made it
 * safe. When the fence conflicts, this adopts the other rotation's outcome and
 * leaves its own key published-but-unused, which is exactly what the doc
 * promises the loser's key will be.
 *
 * The soak window is the reason the staged flow exists at all: a key published
 * and activated in the same breath is published in name only, since no
 * verifier has re-fetched JWKS in between. `force` skips it for the case the
 * window is wrong for — a leaked key, where a few rejected tokens are cheaper
 * than one more minute of signing.
 */
export function activatePublishedSigningKey(
  task: SimulationTask,
  deps: SigningKeyDeps,
  options: { readonly now: number; readonly force?: boolean },
): ResultAsync<SigningKeyRow, RotationError> {
  const run = async (): Promise<Result<SigningKeyRow, RotationError>> => {
    const rows = await listKeys(task, deps.keys);
    if (rows.isErr()) return err(rows.error);

    const target = newestPending(rows.value);
    if (target === undefined) {
      return err({
        type: "rotation_refused",
        reason: "nothing_published",
        message: "no published signing key is waiting to be activated",
      });
    }
    if (options.force !== true) {
      const soakedFor = options.now - target.createdAt;
      if (soakedFor < deps.constants.rotationSoakMs) {
        const remainingMs = deps.constants.rotationSoakMs - soakedFor;
        return err({
          type: "rotation_refused",
          reason: "soak",
          message: `signing key ${target.kid} was published ${Math.max(0, Math.floor(soakedFor / 1_000))}s ago; verifiers may still be serving a key set without it`,
          remainingMs,
        });
      }
    }

    // The key this rotation replaces, pinned before the first write.
    const predecessor = activeRow(rows.value);
    return converge(task, deps, target.kid, predecessor, options.now);
  };
  return new ResultAsync(run());
}

/**
 * Publish and activate in one call, with no soak in between. This is the
 * unstaged form: it is what the recovery scenarios and the composition tests
 * drive, and what a `force` rotation collapses to. Operators use the two
 * stages above, because publishing and signing in the same instant gives
 * verifier caches nothing to turn over in (docs/workload-identity.md).
 */
export function rotateSigningKey(
  task: SimulationTask,
  deps: SigningKeyDeps,
  options: { readonly now: number },
): ResultAsync<SigningKeyRow, SignerError> {
  const run = async (): Promise<Result<SigningKeyRow, SignerError>> => {
    // The predecessor is pinned *before* publishing, not after. Publishing
    // generates a key and writes a secret version, which is the slowest part of
    // the sequence and exactly the window in which another operator's rotation
    // can finish. Pinning afterwards would make this call adopt that fresh key
    // as the thing it is replacing and retire it — a second rotation nobody
    // asked for. Pinned first, two concurrent rotations produce one rotation:
    // the loser sees a key it never read as active, adopts it, and leaves its
    // own published but unused.
    const before = await listKeys(task, deps.keys);
    if (before.isErr()) return err(before.error);
    const predecessor = activeRow(before.value);

    const published = await publishPendingKey(task, deps, options.now);
    if (published.isErr()) return err(published.error);
    const converged = await converge(task, deps, published.value.kid, predecessor, options.now);
    if (converged.isOk()) return ok(converged.value);
    // Neither refusal is reachable here: this call published the key itself, so
    // there is always something to activate, and it asks for no soak. Folding
    // one into `unavailable` keeps this signature narrow rather than widening
    // every caller's error handling for a branch that cannot happen.
    return err(
      converged.error.type === "rotation_refused"
        ? unavailable(converged.error.message)
        : converged.error,
    );
  };
  return new ResultAsync(run());
}

/**
 * Retire `predecessor` and activate `targetKid`, re-reading after every lost
 * race. `predecessor` is the row that was active when the rotation started;
 * `undefined` means nothing was signing, which is the ordinary state after a
 * crash inside the window and needs no retirement at all.
 */
async function converge(
  task: SimulationTask,
  deps: SigningKeyDeps,
  targetKid: string,
  predecessor: SigningKeyRow | undefined,
  now: number,
): Promise<Result<SigningKeyRow, RotationError>> {
  let lastFailure: RotationError = unavailable(`signing key ${targetKid} could not be activated`);
  for (let attempt = 0; attempt < MAX_CONVERGENCE_ATTEMPTS; attempt++) {
    const rows = await listKeys(task, deps.keys);
    if (rows.isErr()) return err(rows.error);

    const active = activeRow(rows.value);
    // Our key is live — either we activated it or a concurrent recovery did.
    if (active !== undefined && active.kid === targetKid) return ok(active);
    if (active !== undefined) {
      if (predecessor === undefined || active.kid !== predecessor.kid) {
        // Somebody else's rotation landed while ours was converging. Its key is
        // fresh, published, and signing; retiring it would open a
        // no-active-key window for nothing. Adopt it.
        logEvent(task, "issuer-key-rotation-superseded", {
          kid: targetKid,
          active: active.kid,
        });
        return ok(active);
      }
      const retired = await deps.keys.casSigningKeyState(task, {
        kid: predecessor.kid,
        expectedRowVersion: predecessor.rowVersion,
        state: "retired",
        retiredAt: now,
      });
      if (retired.isErr()) {
        // The fence caught somebody moving that exact row. Re-read rather than
        // guess: the next pass finds our key active, finds a newer rotation's
        // key to adopt, or finds nothing active and activates ours.
        lastFailure = fromStore("retire previous signing key", retired.error);
        continue;
      }
      logEvent(task, "issuer-key-retired", { kid: predecessor.kid, successor: targetKid });
    }

    const target = rows.value.find((row) => row.kid === targetKid);
    if (target === undefined) {
      return err(unavailable(`published signing key ${targetKid} disappeared before activation`));
    }
    if (target.state === "retired") {
      // Adopted, used, and retired by other rotations while this one was
      // converging. There is nothing left to do that is not resurrection.
      return err(unavailable(`published signing key ${targetKid} was retired before activation`));
    }
    const activated = await deps.keys.casSigningKeyState(task, {
      kid: targetKid,
      expectedRowVersion: target.rowVersion,
      state: "active",
      activatedAt: now,
    });
    if (activated.isOk()) {
      logEvent(task, "issuer-key-activated", { kid: activated.value.kid, reason: "rotation" });
      return ok(activated.value);
    }
    lastFailure = fromStore("activate signing key", activated.error);
  }
  return err(lastFailure);
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
function activeSigningKeyRow(
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
 * Steady-state signing without a secret read per token. The active row is
 * still read every time — it is the authority on which key signs, and a
 * rotation has to take effect immediately — but the private material is
 * reused while the row still points at the same `kid` *and* the same secret
 * version. Any change to either is a cache miss, so material never survives a
 * rotation and a re-keyed row can never be signed with the old PEM.
 *
 * The row alone is not enough, though. Destroying the secret version under a
 * still-active key is the other revocation an operator has — it is how a
 * leaked key is killed without waiting for a rotation to converge — and it
 * changes nothing the row can express, so a warm signer would keep signing
 * with destroyed material for as long as the process lived. Cached material is
 * therefore revalidated after `signingKeyMaterialTtlMs` on the injected
 * monotonic clock, which is what bounds that revocation window.
 */
export class SigningKeyMaterialCache {
  private cached: ActiveSigningKeyMaterial | null = null;
  /** Monotonic reading at the last successful secret read. */
  private readAt = 0;

  load(
    task: SimulationTask,
    deps: SigningKeyMaterialDeps,
  ): ResultAsync<ActiveSigningKeyMaterial, SignerError> {
    return activeSigningKeyRow(task, deps).andThen((row) => {
      const cached = this.cached;
      const now = task.monotonicNow();
      if (
        cached !== null &&
        cached.kid === row.kid &&
        cached.secretVersion === row.secretVersion &&
        now - this.readAt < deps.constants.signingKeyMaterialTtlMs
      ) {
        return ok<ActiveSigningKeyMaterial, SignerError>(cached);
      }
      return readKeyMaterial(task, deps, row).map((material) => {
        this.cached = material;
        this.readAt = now;
        return material;
      });
    });
  }
}
