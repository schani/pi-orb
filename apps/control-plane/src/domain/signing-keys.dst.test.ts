import type { SimulationTask } from "determined";
import { describe, expect, it } from "vitest";
import { FakeSecretStore } from "../testkit/broker.ts";
import { FAILPOINTS } from "../testkit/failpoints.ts";
import {
  makeMintHarness,
  makeSigningKeyHarness,
  type SigningKeyHarness,
  seedOrbWithBearer,
} from "../testkit/fixtures.ts";
import { LogCapture, runDst } from "../testkit/sim.ts";
import {
  decodeFakeIdTokenKid,
  decodeFakeSignatureMaterial,
  FakeSigningKeyStore,
  KeyStoreBackedTokenSigner,
} from "../testkit/workload-identity.ts";
import type { MintDeps, SigningKeyRow } from "./ports.ts";
import {
  assembleJwks,
  ensureActiveSigningKey,
  rotateSigningKey,
  SIGNING_KEY_SECRET_PROVIDER,
} from "./signing-keys.ts";
import { mintIdToken } from "./workload-identity.ts";

const ORB = "orb-a";
const AUDIENCE = "urn:example:service";

/** A fresh durable substrate: one key table and one secret store per scenario. */
function makeSubstrate(): { keys: FakeSigningKeyStore; secrets: FakeSecretStore } {
  return {
    keys: new FakeSigningKeyStore(),
    secrets: new FakeSecretStore({
      read: FAILPOINTS.issuerSecretRead,
      write: FAILPOINTS.issuerSecretWrite,
    }),
  };
}

/** The one key the deployment signs with, or a failure naming what it found. */
function theActiveKey(keys: FakeSigningKeyStore): SigningKeyRow {
  const active = keys.activeRows();
  expect(
    active.length,
    `expected exactly one active key, found ${JSON.stringify(
      keys.allRows().map((row) => `${row.kid}:${row.state}`),
    )}`,
  ).toBe(1);
  const row = active[0];
  if (row === undefined) throw new Error("unreachable");
  return row;
}

/**
 * No durable row may point at material that is gone: that is the one
 * corruption the orphan cleanup could cause, and it would make the issuer
 * unable to sign with a key it advertises as active.
 */
function expectNoDanglingMaterial(harness: {
  keys: FakeSigningKeyStore;
  secrets: FakeSecretStore;
}): void {
  const live = new Set(harness.secrets.liveVersions(SIGNING_KEY_SECRET_PROVIDER));
  for (const row of harness.keys.allRows()) {
    expect(live.has(row.secretVersion), `row ${row.kid} lost its material`).toBe(true);
  }
}

/**
 * Live private-key versions no row names. Harmless to the issuer — nothing can
 * reach them — but they are private key material nobody will ever clean up, so
 * the number of them a converging boot may leave behind is a property worth
 * bounding rather than ignoring.
 */
function orphanedVersions(harness: {
  keys: FakeSigningKeyStore;
  secrets: FakeSecretStore;
}): string[] {
  const referenced = new Set(harness.keys.allRows().map((row) => row.secretVersion));
  return harness.secrets
    .liveVersions(SIGNING_KEY_SECRET_PROVIDER)
    .filter((version) => !referenced.has(version));
}

/** The strict form, for scenarios with no injected failures: rows and material match exactly. */
function expectMaterialMatchesRows(harness: {
  keys: FakeSigningKeyStore;
  secrets: FakeSecretStore;
}): void {
  expectNoDanglingMaterial(harness);
  expect(orphanedVersions(harness), "private key material no row references").toEqual([]);
}

/** Every write the schema refused, as messages, for the "never attempted" assertions. */
const refusalMessages = (keys: FakeSigningKeyStore): string[] =>
  keys.refusals.map((error) => error.message);

/**
 * Every published key id, as a relying party would read the served JWKS, or
 * null when the read itself failed — which under an injected store outage is
 * a legitimate answer rather than a defect.
 */
async function tryPublishedKids(
  task: SimulationTask,
  harness: SigningKeyHarness,
): Promise<string[] | null> {
  const jwks = await assembleJwks(task, harness.deps, { now: task.wallNow() });
  if (jwks.isErr()) return null;
  return jwks.value.keys.map((key) => String((key as { kid: string }).kid));
}

/** The same, where the store is healthy and a failed read is a real failure. */
async function publishedKids(task: SimulationTask, harness: SigningKeyHarness): Promise<string[]> {
  const kids = await tryPublishedKids(task, harness);
  expect(kids, "JWKS read failed with no injected failure").not.toBeNull();
  return kids ?? [];
}

describe("establishing the issuer's signing key (DST)", () => {
  it("two instances booting together converge on exactly one active key", async () => {
    const log = new LogCapture();
    await runDst(
      { name: "signing-key-boot-race", iterations: 60, logCapture: log },
      async (sim) => {
        const substrate = makeSubstrate();
        const instances = ["a", "b"].map((suffix) =>
          makeSigningKeyHarness({ ...substrate, kidPrefix: `kid-${suffix}` }),
        );
        const booted: string[] = [];

        const result = await sim.runTasks(
          instances.map((harness, index) => ({
            name: `boot-${index}`,
            f: async (task: SimulationTask) => {
              await task.sleep(1 + task.random(`boot stagger ${index}`) * 20, "boot stagger");
              const active = await ensureActiveSigningKey(task, harness.deps, {
                now: task.wallNow(),
              });
              expect(active.isOk(), JSON.stringify(active.isErr() ? active.error : null)).toBe(
                true,
              );
              if (active.isOk()) booted.push(active.value.kid);
            },
          })),
        );
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);

        // Both instances sign with the same key, whichever of them created it.
        expect(booted.length).toBe(2);
        expect(new Set(booted).size).toBe(1);
        expect(theActiveKey(substrate.keys).kid).toBe(booted[0]);

        // The loser left nothing behind: every live secret version is referenced
        // by a row and every row's version is live. A generated-but-unused
        // private key outliving the boot that produced it is exactly the leak
        // this cleanup exists to prevent.
        const referenced = substrate.keys
          .allRows()
          .map((row) => row.secretVersion)
          .sort();
        expect(substrate.secrets.liveVersions(SIGNING_KEY_SECRET_PROVIDER).sort()).toEqual(
          referenced,
        );

        // The operator-visible record of which key the fleet signs with, written
        // exactly once however the two boots interleaved.
        const activated = log.matching("issuer-key-activated");
        expect(activated.length).toBe(1);
        expect(activated[0]).toContain(`kid=${booted[0]}`);
        expect(log.matching("issuer-key-race-lost").length).toBeLessThanOrEqual(1);
      },
    );
  });

  it("is a no-op once a key is active, whatever else is booting", async () => {
    const log = new LogCapture();
    await runDst(
      { name: "signing-key-boot-idempotent", iterations: 20, logCapture: log },
      async (sim) => {
        const substrate = makeSubstrate();
        const harness = makeSigningKeyHarness(substrate);
        const result = await sim.runTasks([
          {
            name: "boots",
            f: async (task) => {
              const first = await ensureActiveSigningKey(task, harness.deps, {
                now: task.wallNow(),
              });
              expect(first.isOk()).toBe(true);
              for (let boot = 0; boot < 3; boot++) {
                await task.sleep(100, "restart");
                const again = await ensureActiveSigningKey(task, harness.deps, {
                  now: task.wallNow(),
                });
                expect(again.isOk() && again.value.kid).toBe(first._unsafeUnwrap().kid);
              }
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        // Three restarts, one key: booting may never mint fresh key material.
        expect(harness.generator.generated).toBe(1);
        expect(substrate.keys.allRows().length).toBe(1);
        // Edges, not levels: the healthy restarts say nothing at all.
        expect(log.lines()).toEqual([log.matching("issuer-key-activated")[0]]);
      },
    );
  });

  it("keeps converging while the key store and secret store are failing", async () => {
    await runDst(
      {
        name: "signing-key-boot-failpoints",
        iterations: 50,
        failpointProbabilities: {
          [FAILPOINTS.signingKeyWrite]: 0.25,
          [FAILPOINTS.signingKeyRead]: 0.15,
          [FAILPOINTS.issuerSecretWrite]: 0.2,
        },
      },
      async (sim) => {
        const substrate = makeSubstrate();
        const instances = ["a", "b"].map((suffix) =>
          makeSigningKeyHarness({ ...substrate, kidPrefix: `kid-${suffix}` }),
        );
        let succeeded = 0;

        const result = await sim.runTasks(
          instances.map((harness, index) => ({
            name: `boot-${index}`,
            f: async (task: SimulationTask) => {
              // A booting instance retries; it may not start minting until it
              // has a key, and it never invents one another way.
              for (let attempt = 0; attempt < 12; attempt++) {
                await task.sleep(1 + task.random(`retry ${index}`) * 50, "boot retry");
                const active = await ensureActiveSigningKey(task, harness.deps, {
                  now: task.wallNow(),
                });
                if (active.isOk()) {
                  succeeded += 1;
                  expect(active.value.state).toBe("active");
                  return;
                }
                // Failing closed is the only permitted alternative.
                expect(active.error.type).toBe("signer_error");
                expect(active.error.retryable).toBe(true);
              }
            },
          })),
        );
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        expect(succeeded).toBeGreaterThan(0);
        theActiveKey(substrate.keys);
        expectNoDanglingMaterial(substrate);
        // Under injected failures a boot can write material and then be unable
        // to insert, read, or clean up — so orphans are possible. What must
        // not be possible is a *stream* of them: each instance generates its
        // key once and carries it across every convergence attempt, so the
        // ceiling is one unreferenced version per instance rather than one per
        // attempt per boot retry.
        expect(
          orphanedVersions(substrate).length,
          `orphaned private key material: ${JSON.stringify(orphanedVersions(substrate))}`,
        ).toBeLessThanOrEqual(instances.length);
      },
    );
  });

  it("refuses to declare a key established when its material cannot be read", async () => {
    const log = new LogCapture();
    await runDst(
      { name: "signing-key-boot-unreadable-material", iterations: 15, logCapture: log },
      async (sim) => {
        const substrate = makeSubstrate();
        const harness = makeSigningKeyHarness(substrate);
        const result = await sim.runTasks([
          {
            name: "boot",
            f: async (task: SimulationTask) => {
              const established = (
                await ensureActiveSigningKey(task, harness.deps, { now: task.wallNow() })
              )._unsafeUnwrap();
              // Whatever destroyed it — an operator killing a leaked key, a
              // secret-store lifecycle rule — the row survives and still says
              // `active`. A boot that trusted the row alone would report a
              // healthy issuer that cannot sign a single token, and the only
              // symptom would be a per-orb `signer_failure` much later.
              expect(
                (
                  await substrate.secrets.destroySecret(
                    task,
                    SIGNING_KEY_SECRET_PROVIDER,
                    established.secretVersion,
                  )
                ).isOk(),
              ).toBe(true);

              const rebooted = await ensureActiveSigningKey(task, harness.deps, {
                now: task.wallNow(),
              });
              expect(rebooted.isErr()).toBe(true);
              if (rebooted.isErr()) {
                expect(rebooted.error.code).toBe("unavailable");
                expect(rebooted.error.retryable).toBe(true);
                expect(rebooted.error.message).not.toContain("fake-private-key");
              }
              // Nothing was papered over: the row is untouched, so a rotation
              // still has the same predecessor to fence against.
              expect(theActiveKey(substrate.keys).kid).toBe(established.kid);
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        // The durable operator-visible edge for "the issuer cannot sign", on
        // the boot that noticed rather than on the first workload that asked.
        const unusable = log.matching("issuer-key-unusable");
        expect(unusable.length).toBe(1);
        expect(unusable[0]).toContain(`kid=${theActiveKey(substrate.keys).kid}`);
      },
    );
  });
});

describe("rotating the issuer's signing key (DST)", () => {
  it("publishes before signing and keeps the retired key verifiable", async () => {
    const log = new LogCapture();
    await runDst({ name: "signing-key-rotation", iterations: 20, logCapture: log }, async (sim) => {
      const substrate = makeSubstrate();
      const harness = makeSigningKeyHarness(substrate);
      const result = await sim.runTasks([
        {
          name: "ops",
          f: async (task) => {
            const first = (
              await ensureActiveSigningKey(task, harness.deps, { now: task.wallNow() })
            )._unsafeUnwrap();
            expect(await publishedKids(task, harness)).toEqual([first.kid]);

            await task.sleep(1_000, "some time passes");
            const rotated = await rotateSigningKey(task, harness.deps, { now: task.wallNow() });
            expect(rotated.isOk(), JSON.stringify(rotated.isErr() ? rotated.error : null)).toBe(
              true,
            );
            const second = rotated._unsafeUnwrap();
            expect(second.kid).not.toBe(first.kid);

            // The new key signs, the old one keeps verifying, and the active
            // key is served first.
            const kids = await publishedKids(task, harness);
            expect(kids[0]).toBe(second.kid);
            expect(kids).toContain(first.kid);
            expect(theActiveKey(substrate.keys).kid).toBe(second.kid);
            expect(substrate.keys.snapshot(first.kid)?.state).toBe("retired");
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expectNoDanglingMaterial(substrate);
      // The forensic trail a "when did this key start signing?" question needs,
      // in the order the sequence guarantees.
      const events = log
        .lines()
        .map((line) => /lifecycle:\s+(\S+)/.exec(line)?.[1])
        .filter((event) => event !== undefined);
      expect(events).toEqual([
        "issuer-key-activated",
        "issuer-key-published",
        "issuer-key-retired",
        "issuer-key-activated",
      ]);
    });
  });

  it("drops a retired key from JWKS only after the overlap window", async () => {
    await runDst({ name: "signing-key-overlap", iterations: 10 }, async (sim) => {
      const substrate = makeSubstrate();
      const harness = makeSigningKeyHarness(substrate);
      const overlapMs = harness.deps.constants.jwksOverlapMs;
      const result = await sim.runTasks([
        {
          name: "ops",
          f: async (task) => {
            const first = (
              await ensureActiveSigningKey(task, harness.deps, { now: task.wallNow() })
            )._unsafeUnwrap();
            const retiredAt = task.wallNow();
            const second = (
              await rotateSigningKey(task, harness.deps, { now: retiredAt })
            )._unsafeUnwrap();

            const kidsAt = async (now: number): Promise<string[]> => {
              const jwks = await assembleJwks(task, harness.deps, { now });
              return jwks._unsafeUnwrap().keys.map((key) => String((key as { kid: string }).kid));
            };
            // The whole point of the window: a token minted just before
            // retirement outlives it, so the key that signed it must too.
            expect(await kidsAt(retiredAt + overlapMs - 1)).toContain(first.kid);
            expect(await kidsAt(retiredAt + overlapMs)).toContain(first.kid);
            expect(await kidsAt(retiredAt + overlapMs + 1)).toEqual([second.kid]);
            // The row and its material stay: dropping it from the served set
            // is all this stage does.
            expect(substrate.keys.snapshot(first.kid)).not.toBeNull();
            expectNoDanglingMaterial(substrate);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });

  it("recovers from a crash after publishing, before the old key is retired", async () => {
    await runDst({ name: "signing-key-crash-after-publish", iterations: 15 }, async (sim) => {
      const substrate = makeSubstrate();
      const harness = makeSigningKeyHarness(substrate);
      const result = await sim.runTasks([
        {
          name: "recovery",
          f: async (task) => {
            const old = (
              await ensureActiveSigningKey(task, harness.deps, { now: task.wallNow() })
            )._unsafeUnwrap();
            // Exactly the state a crash between rotation step 1 and step 2
            // leaves behind: the new key published, the old one still signing.
            substrate.keys.seedKey({
              kid: "kid-published",
              secretVersion: substrate.secrets.seedSecret(SIGNING_KEY_SECRET_PROVIDER, {
                privateKeyPem: "fake-private-key:kid-published",
              }),
              publicJwk: { kty: "RSA", alg: "RS256", use: "sig", kid: "kid-published" },
              state: "pending",
              createdAt: task.wallNow(),
              activatedAt: null,
              retiredAt: null,
              rowVersion: 0,
            });

            const booted = await ensureActiveSigningKey(task, harness.deps, {
              now: task.wallNow(),
            });
            // A restart must not hijack the rotation: the old key is still
            // active and still valid, so booting leaves it alone.
            expect(booted.isOk() && booted.value.kid).toBe(old.kid);
            expect(await publishedKids(task, harness)).toEqual([old.kid, "kid-published"]);

            // Re-running rotation adopts the published key rather than
            // generating a third one.
            const rotated = await rotateSigningKey(task, harness.deps, { now: task.wallNow() });
            expect(rotated.isOk() && rotated.value.kid).toBe("kid-published");
            expect(harness.generator.generated).toBe(1);
            expect(theActiveKey(substrate.keys).kid).toBe("kid-published");
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expectNoDanglingMaterial(substrate);
    });
  });

  it("recovers from a crash between retiring the old key and activating the new one", async () => {
    await runDst({ name: "signing-key-crash-between-cas", iterations: 15 }, async (sim) => {
      const substrate = makeSubstrate();
      const harness = makeSigningKeyHarness(substrate);
      const result = await sim.runTasks([
        {
          name: "recovery",
          f: async (task) => {
            // The one window in which nothing can sign: the old key is retired
            // and the new one is published but not yet active.
            const secretVersion = substrate.secrets.seedSecret(SIGNING_KEY_SECRET_PROVIDER, {
              privateKeyPem: "fake-private-key:kid-published",
            });
            substrate.keys.seedKey({
              kid: "kid-retired",
              secretVersion: substrate.secrets.seedSecret(SIGNING_KEY_SECRET_PROVIDER, {
                privateKeyPem: "fake-private-key:kid-retired",
              }),
              publicJwk: { kty: "RSA", alg: "RS256", use: "sig", kid: "kid-retired" },
              state: "retired",
              createdAt: task.wallNow(),
              activatedAt: task.wallNow(),
              retiredAt: task.wallNow(),
              rowVersion: 2,
            });
            substrate.keys.seedKey({
              kid: "kid-published",
              secretVersion,
              publicJwk: { kty: "RSA", alg: "RS256", use: "sig", kid: "kid-published" },
              state: "pending",
              createdAt: task.wallNow() + 1,
              activatedAt: null,
              retiredAt: null,
              rowVersion: 0,
            });

            const booted = await ensureActiveSigningKey(task, harness.deps, {
              now: task.wallNow(),
            });
            // Booting finishes the interrupted rotation with the key that is
            // already published, instead of generating an unpublished one.
            expect(booted.isOk() && booted.value.kid).toBe("kid-published");
            expect(harness.generator.generated).toBe(0);
            expect(theActiveKey(substrate.keys).kid).toBe("kid-published");
            expect(await publishedKids(task, harness)).toContain("kid-retired");
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expectNoDanglingMaterial(substrate);
    });
  });

  it("never retires the key a concurrent rotation just activated", async () => {
    const log = new LogCapture();
    await runDst(
      { name: "signing-key-rotation-race", iterations: 60, logCapture: log },
      async (sim) => {
        const substrate = makeSubstrate();
        // Two operators rotating at once over one database and one secret
        // store, each with its own key generator.
        const alpha = makeSigningKeyHarness({ ...substrate, kidPrefix: "kid-a" });
        const beta = makeSigningKeyHarness({ ...substrate, kidPrefix: "kid-b" });
        const operators = [alpha, beta];

        const seed = await sim.runTasks([
          {
            name: "seed",
            f: async (task: SimulationTask) => {
              const first = await ensureActiveSigningKey(task, alpha.deps, {
                now: task.wallNow(),
              });
              expect(first.isOk()).toBe(true);
            },
          },
        ]);
        expect(seed.isOk(), seed.isErr() ? seed.error.message : "").toBe(true);
        const original = theActiveKey(substrate.keys).kid;

        const race = await sim.runTasks(
          operators.map((harness, index) => ({
            name: `rotate-${index}`,
            f: async (task: SimulationTask) => {
              // Deliberately no stagger. Both rotations must read the active
              // key before either finishes, or the scenario degenerates into
              // two *serial* rotations — which legitimately retire two keys and
              // would prove nothing about the fence.
              const rotated = await rotateSigningKey(task, harness.deps, { now: task.wallNow() });
              expect(rotated.isOk(), JSON.stringify(rotated.isErr() ? rotated.error : null)).toBe(
                true,
              );
            },
          })),
        );
        expect(race.isOk(), race.isErr() ? race.error.message : "").toBe(true);

        // Exactly one key signs, and it is not the one the rotations replaced.
        const winner = theActiveKey(substrate.keys);
        expect(winner.kid).not.toBe(original);
        expect(substrate.keys.snapshot(original)?.state).toBe("retired");

        // The whole point of the fence: the *original* key is the only thing
        // either rotation may retire. A key a rotation just activated is fresh,
        // published, and signing; retiring it would open a no-active-key window
        // for nothing, and the escalation out of that window is the one write
        // the schema forbids.
        const retired = substrate.keys.allRows().filter((row) => row.state === "retired");
        expect(retired.map((row) => row.kid)).toEqual([original]);
        expect(log.matching("issuer-key-retired").length).toBe(1);

        // Where two keys were published, the loser's stays published-but-unused
        // exactly as the doc promises — never retired, never resurrected.
        for (const row of substrate.keys.allRows()) {
          if (row.kid === original || row.kid === winner.kid) continue;
          expect(row.state, `${row.kid} should still be awaiting adoption`).toBe("pending");
        }

        // Nothing ever *attempted* a row shape the schema forbids outright —
        // above all `retired` → `active`, the escalation the old convergence
        // loop could reach after retiring a fresh key. Recovering from your own
        // impossible write is not the same as never making it.
        //
        // A "would be a second active key" refusal is deliberately *not*
        // forbidden here: two rotations that each read no active key and then
        // race to activate are exactly what the unique-active index exists to
        // arbitrate, the same way two booting instances race their inserts. The
        // loser re-reads and adopts.
        expect(
          refusalMessages(substrate.keys).filter((message) => /must be (set|null)/.test(message)),
        ).toEqual([]);
        expectMaterialMatchesRows(substrate);
      },
    );
  });

  it("survives arbitrary write failures during rotation with one active key", async () => {
    await runDst(
      {
        name: "signing-key-rotation-failpoints",
        iterations: 50,
        failpointProbabilities: {
          [FAILPOINTS.signingKeyWrite]: 0.3,
          [FAILPOINTS.signingKeyRead]: 0.1,
        },
      },
      async (sim) => {
        const substrate = makeSubstrate();
        const harness = makeSigningKeyHarness(substrate);
        const result = await sim.runTasks([
          {
            name: "ops",
            f: async (task: SimulationTask) => {
              // Establish a key first; a rotation with nothing to rotate from
              // is the boot case, covered above.
              let established = false;
              for (let attempt = 0; attempt < 12 && !established; attempt++) {
                await task.sleep(10, "boot retry");
                established = (
                  await ensureActiveSigningKey(task, harness.deps, { now: task.wallNow() })
                ).isOk();
              }
              if (!established) return;

              // A rotation that dies anywhere: the operator sees an error and
              // the deployment is left in one of the windows above.
              await rotateSigningKey(task, harness.deps, { now: task.wallNow() });

              // Whatever it left behind, the next boot restores an issuer that
              // can sign, and it signs with a published key.
              for (let attempt = 0; attempt < 12; attempt++) {
                await task.sleep(10, "recovery retry");
                const recovered = await ensureActiveSigningKey(task, harness.deps, {
                  now: task.wallNow(),
                });
                if (recovered.isErr()) continue;
                const kids = await tryPublishedKids(task, harness);
                if (kids === null) continue;
                expect(kids).toContain(recovered.value.kid);
                expect(theActiveKey(substrate.keys).kid).toBe(recovered.value.kid);
                expectNoDanglingMaterial(substrate);
                return;
              }
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        // Never two active keys, whatever failed and whenever it failed.
        expect(substrate.keys.activeRows().length).toBeLessThanOrEqual(1);
      },
    );
  });
});

describe("minting across a key rotation (DST)", () => {
  it("keeps signing with a published key before, during, and after rotation", async () => {
    await runDst({ name: "signing-key-mint-rotation", iterations: 40 }, async (sim) => {
      const substrate = makeSubstrate();
      const keyHarness = makeSigningKeyHarness(substrate);
      const mintHarness = makeMintHarness({ issuerConstants: { minMintIntervalMs: 50 } });
      const signer = new KeyStoreBackedTokenSigner(keyHarness.deps);
      const mintDeps: MintDeps = { ...mintHarness.mintDeps, signer };
      const signedKids = new Set<string>();
      let bearer = "";
      // The simulation's virtual clock restarts with each `runTasks` phase,
      // so a later phase has to wait out the rate-limit floor measured from
      // the last mint's wall time rather than from its own start.
      let lastMintWallNow = 0;

      const seed = await sim.runTasks([
        {
          name: "seed",
          f: async (task) => {
            bearer = seedOrbWithBearer(task, mintHarness, ORB, "running");
            const active = await ensureActiveSigningKey(task, keyHarness.deps, {
              now: task.wallNow(),
            });
            expect(active.isOk()).toBe(true);
          },
        },
      ]);
      expect(seed.isOk(), seed.isErr() ? seed.error.message : "").toBe(true);
      const firstKid = theActiveKey(substrate.keys).kid;

      const race = await sim.runTasks([
        {
          name: "rotator",
          f: async (task) => {
            await task.sleep(100 + task.random("rotation delay") * 400, "let mints start");
            const rotated = await rotateSigningKey(task, keyHarness.deps, { now: task.wallNow() });
            expect(rotated.isOk(), JSON.stringify(rotated.isErr() ? rotated.error : null)).toBe(
              true,
            );
          },
        },
        ...Array.from({ length: 4 }, (_, index) => ({
          name: `minter-${index}`,
          f: async (task: SimulationTask) => {
            for (let attempt = 0; attempt < 6; attempt++) {
              await task.sleep(1 + task.random(`mint stagger ${index}`) * 150, "mint stagger");
              const outcome = await mintIdToken(task, mintDeps, {
                tokenHash: bearer,
                audience: AUDIENCE,
              });
              lastMintWallNow = Math.max(lastMintWallNow, task.wallNow());
              if (outcome.isErr()) {
                // The no-active-key window of a rotation is a retryable
                // refusal, never a token signed with something else.
                expect(["rate_limited", "retryable"]).toContain(outcome.error.type);
                continue;
              }
              const kid = decodeFakeIdTokenKid(outcome.value.token);
              signedKids.add(kid);
              // The published-before-signing property, checked at the moment a
              // token exists: whatever signed it is in the served key set, so
              // a relying party fetching JWKS now can verify it.
              expect(await publishedKids(task, keyHarness)).toContain(kid);
              // And the header is not merely labelled: the signature carries
              // the material that key's row points at.
              expect(decodeFakeSignatureMaterial(outcome.value.token)).toBe(
                `fake-private-key:${kid}`,
              );
            }
          },
        })),
      ]);
      expect(race.isOk(), race.isErr() ? race.error.message : "").toBe(true);

      const secondKid = theActiveKey(substrate.keys).kid;
      expect(secondKid).not.toBe(firstKid);
      // Tokens signed before the rotation stay verifiable throughout it.
      const after = await sim.runTasks([
        {
          name: "post-rotation",
          f: async (task) => {
            const floor = mintDeps.constants.minMintIntervalMs;
            const wait = lastMintWallNow + floor + 1 - task.wallNow();
            if (wait > 0) await task.sleep(wait, "past the rate-limit floor");
            const outcome = await mintIdToken(task, mintDeps, {
              tokenHash: bearer,
              audience: AUDIENCE,
            });
            expect(outcome.isOk(), JSON.stringify(outcome.isErr() ? outcome.error : null)).toBe(
              true,
            );
            if (outcome.isOk()) {
              // The cache followed the rotation rather than pinning the old key.
              expect(decodeFakeIdTokenKid(outcome.value.token)).toBe(secondKid);
            }
            const kids = await publishedKids(task, keyHarness);
            for (const kid of signedKids) expect(kids).toContain(kid);
          },
        },
      ]);
      expect(after.isOk(), after.isErr() ? after.error.message : "").toBe(true);
      expect(signedKids.size).toBeGreaterThan(0);
    });
  });

  it("fails closed while no key is active and recovers once one is", async () => {
    await runDst({ name: "signing-key-mint-without-key", iterations: 20 }, async (sim) => {
      const substrate = makeSubstrate();
      const keyHarness = makeSigningKeyHarness(substrate);
      const mintHarness = makeMintHarness({ issuerConstants: { minMintIntervalMs: 50 } });
      const signer = new KeyStoreBackedTokenSigner(keyHarness.deps);
      const mintDeps: MintDeps = { ...mintHarness.mintDeps, signer };

      const result = await sim.runTasks([
        {
          name: "workload",
          f: async (task) => {
            const bearer = seedOrbWithBearer(task, mintHarness, ORB, "running");
            // No key has been established yet: identity is unavailable, and
            // the answer says so in a way the caller can retry on.
            const refused = await mintIdToken(task, mintDeps, {
              tokenHash: bearer,
              audience: AUDIENCE,
            });
            expect(refused.isErr() && refused.error.type).toBe("retryable");
            expect(mintHarness.store.orbSnapshot(ORB)?.mintFailureCode).toBe("signer_failure");
            expect(signer.calls).toBe(0);

            await task.sleep(1_000, "past the rate-limit floor");
            const established = await ensureActiveSigningKey(task, keyHarness.deps, {
              now: task.wallNow(),
            });
            expect(established.isOk()).toBe(true);

            const minted = await mintIdToken(task, mintDeps, {
              tokenHash: bearer,
              audience: AUDIENCE,
            });
            expect(minted.isOk(), JSON.stringify(minted.isErr() ? minted.error : null)).toBe(true);
            if (minted.isOk()) {
              expect(decodeFakeIdTokenKid(minted.value.token)).toBe(
                theActiveKey(substrate.keys).kid,
              );
            }
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });

  it("stops a warm signer within the material TTL once its version is destroyed", async () => {
    await runDst({ name: "signing-key-material-revoked-warm", iterations: 20 }, async (sim) => {
      const substrate = makeSubstrate();
      const ttlMs = 5_000;
      const keyHarness = makeSigningKeyHarness({
        ...substrate,
        issuerConstants: { signingKeyMaterialTtlMs: ttlMs },
      });
      const mintHarness = makeMintHarness({ issuerConstants: { minMintIntervalMs: 0 } });
      const signer = new KeyStoreBackedTokenSigner(keyHarness.deps);
      const mintDeps: MintDeps = { ...mintHarness.mintDeps, signer };

      const result = await sim.runTasks([
        {
          name: "workload",
          f: async (task) => {
            const bearer = seedOrbWithBearer(task, mintHarness, ORB, "running");
            const active = (
              await ensureActiveSigningKey(task, keyHarness.deps, { now: task.wallNow() })
            )._unsafeUnwrap();

            // Warm the cache first. This is the case the cold-start scenario
            // above cannot reach: destroying the version leaves the row
            // untouched, so a signer that already holds the material has
            // nothing to notice unless it revalidates.
            const warm = await mintIdToken(task, mintDeps, {
              tokenHash: bearer,
              audience: AUDIENCE,
            });
            expect(warm.isOk(), JSON.stringify(warm.isErr() ? warm.error : null)).toBe(true);
            expect(signer.calls).toBe(1);

            expect(
              (
                await substrate.secrets.destroySecret(
                  task,
                  SIGNING_KEY_SECRET_PROVIDER,
                  active.secretVersion,
                )
              ).isOk(),
            ).toBe(true);

            // The accepted staleness: inside the window the material is still
            // reused, which is the price of not reading a secret per token.
            // The 100 ms margins keep the assertions about the TTL rather than
            // about how many bounded store latencies the schedule chose to put
            // on either side of it.
            await task.sleep(ttlMs - 100, "inside the material TTL");
            const stale = await mintIdToken(task, mintDeps, {
              tokenHash: bearer,
              audience: AUDIENCE,
            });
            expect(stale.isOk()).toBe(true);

            // Past it, revocation takes effect and stays in effect.
            await task.sleep(200, "past the material TTL");
            for (let attempt = 0; attempt < 3; attempt++) {
              const refused = await mintIdToken(task, mintDeps, {
                tokenHash: bearer,
                audience: AUDIENCE,
              });
              expect(refused.isErr() && refused.error.type).toBe("retryable");
              await task.sleep(1, "again");
            }
            expect(signer.calls).toBe(2);
            expect(mintHarness.store.orbSnapshot(ORB)?.mintFailureCode).toBe("signer_failure");
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });

  it("refuses to sign when the active key's material is gone", async () => {
    await runDst({ name: "signing-key-material-destroyed", iterations: 15 }, async (sim) => {
      const substrate = makeSubstrate();
      const keyHarness = makeSigningKeyHarness(substrate);
      const mintHarness = makeMintHarness({ issuerConstants: { minMintIntervalMs: 50 } });
      const signer = new KeyStoreBackedTokenSigner(keyHarness.deps);
      const mintDeps: MintDeps = { ...mintHarness.mintDeps, signer };

      const result = await sim.runTasks([
        {
          name: "workload",
          f: async (task) => {
            const bearer = seedOrbWithBearer(task, mintHarness, ORB, "running");
            const active = (
              await ensureActiveSigningKey(task, keyHarness.deps, { now: task.wallNow() })
            )._unsafeUnwrap();
            // An operator destroys the version the active row points at: the
            // issuer must fail closed rather than fall back to anything.
            const destroyed = await substrate.secrets.destroySecret(
              task,
              SIGNING_KEY_SECRET_PROVIDER,
              active.secretVersion,
            );
            expect(destroyed.isOk()).toBe(true);

            const refused = await mintIdToken(task, mintDeps, {
              tokenHash: bearer,
              audience: AUDIENCE,
            });
            expect(refused.isErr() && refused.error.type).toBe("retryable");
            expect(signer.calls).toBe(0);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });
});
