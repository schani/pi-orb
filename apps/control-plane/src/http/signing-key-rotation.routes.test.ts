import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { errAsync } from "neverthrow";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_ISSUER_CONSTANTS } from "../domain/constants.ts";
import type { StoreError } from "../domain/errors.ts";
import type { SigningKeyDeps } from "../domain/ports.ts";
import { ensureActiveSigningKey } from "../domain/signing-keys.ts";
import { makeHarness, makeSigningKeyHarness, TEST_SYSTEM_VIEW } from "../testkit/fixtures.ts";
import type { FakeSigningKeyStore } from "../testkit/workload-identity.ts";
import { registerRoutes } from "./routes.ts";

/**
 * The operator's rotation surface (docs/workload-identity.md). Two stages, on
 * purpose: a key published and activated in the same request is published in
 * name only, because no verifier has re-fetched JWKS in between. The soak
 * window is what makes the wait a rule rather than a habit, and `force` is the
 * escape hatch for the one case the rule is wrong for.
 */

/** A task whose wall clock the test moves, so the soak window is not a race against CI. */
class OperatorClock extends NoSimulationTask {
  private wall = 1_700_000_000_000;

  constructor() {
    super("signing key rotation routes", false);
  }

  override wallNow(): number {
    return this.wall;
  }

  advance(ms: number): void {
    this.wall += ms;
  }
}

const soakMs = DEFAULT_ISSUER_CONSTANTS.rotationSoakMs;

describe("staged signing-key rotation routes", () => {
  let task: OperatorClock;
  let keys: FakeSigningKeyStore;
  let signingKeys: SigningKeyDeps;
  let app: ReturnType<typeof Fastify>;

  const publish = () => app.inject({ method: "POST", url: "/api/v1/issuer/signing-keys/publish" });
  const activate = (payload?: unknown) =>
    app.inject({
      method: "POST",
      url: "/api/v1/issuer/signing-keys/activate",
      ...(payload === undefined ? {} : { payload }),
    });

  beforeEach(async () => {
    task = new OperatorClock();
    const keyHarness = makeSigningKeyHarness();
    keys = keyHarness.keys;
    signingKeys = keyHarness.deps;
    app = Fastify();
    registerRoutes(app, task, makeHarness().deps, {}, TEST_SYSTEM_VIEW, signingKeys);
    await app.ready();
    // The steady state an operator rotates *from*.
    expect((await ensureActiveSigningKey(task, signingKeys, { now: task.wallNow() })).isOk()).toBe(
      true,
    );
  });

  afterEach(async () => {
    await app.close();
  });

  const activeKid = (): string | undefined => keys.activeRows()[0]?.kid;

  it("publishes a key that does not sign yet, and adopts it on a repeated publish", async () => {
    const original = activeKid();
    const first = await publish();
    expect(first.statusCode).toBe(200);
    expect(first.json().state).toBe("pending");
    expect(first.json().activatedAt).toBeUndefined();
    // Publishing changes nothing about who signs.
    expect(activeKid()).toBe(original);

    // Re-running the stage resumes the rotation instead of stacking a second
    // pending key — an operator who is unsure whether the first call landed
    // must be able to simply run it again.
    const again = await publish();
    expect(again.statusCode).toBe(200);
    expect(again.json().kid).toBe(first.json().kid);
    expect(keys.allRows().filter((row) => row.state === "pending")).toHaveLength(1);
  });

  it("refuses to activate a key that verifier caches have not had time to see", async () => {
    const original = activeKid();
    const published = await publish();

    const tooSoon = await activate();
    expect(tooSoon.statusCode).toBe(409);
    expect(tooSoon.json().error.code).toBe("conflict");
    // Not retryable: waiting is the operator's job, and telling a script this
    // will clear itself invites it to spin for the whole window.
    expect(tooSoon.json().error.retryable).toBe(false);
    expect(tooSoon.json().error.message).toContain(published.json().kid);
    expect(activeKid()).toBe(original);
    expect(keys.snapshot(published.json().kid)?.state).toBe("pending");

    // One millisecond short is still short.
    task.advance(soakMs - 1);
    expect((await activate()).statusCode).toBe(409);
    expect(activeKid()).toBe(original);
  });

  it("activates once the soak window has passed, retiring the key it replaces", async () => {
    const original = activeKid();
    const published = await publish();
    task.advance(soakMs);

    const activated = await activate();
    expect(activated.statusCode).toBe(200);
    expect(activated.json()).toMatchObject({ kid: published.json().kid, state: "active" });
    expect(activated.json().activatedAt).toBeDefined();
    expect(activeKid()).toBe(published.json().kid);
    // The old key stays published for the overlap window, so tokens it already
    // signed keep verifying.
    expect(original).toBeDefined();
    expect(keys.snapshot(original as string)?.state).toBe("retired");
  });

  it("activates immediately when forced, for the leaked-key emergency", async () => {
    const original = activeKid();
    const published = await publish();

    const forced = await activate({ force: true });
    expect(forced.statusCode).toBe(200);
    expect(activeKid()).toBe(published.json().kid);
    expect(keys.snapshot(original as string)?.state).toBe("retired");
  });

  it("refuses to activate when nothing has been published", async () => {
    const original = activeKid();
    const nothing = await activate({ force: true });
    expect(nothing.statusCode).toBe(409);
    expect(nothing.json().error.message).toContain("no published signing key");
    expect(activeKid()).toBe(original);
  });

  it("rejects a body that is not the declared shape without writing", async () => {
    await publish();
    const bad = await activate({ force: "yes" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("invalid_request");
    const unknownField = await activate({ soak: false });
    expect(unknownField.statusCode).toBe(400);
    expect(keys.activeRows()).toHaveLength(1);
  });

  it("reports a store outage as retryable rather than as a refusal", async () => {
    const outage: StoreError = {
      type: "store_error",
      code: "unavailable",
      message: "signing key table unreachable",
      retryable: true,
    };
    const broken = Fastify();
    registerRoutes(broken, task, makeHarness().deps, {}, TEST_SYSTEM_VIEW, {
      ...signingKeys,
      keys: {
        listSigningKeys: () => errAsync(outage),
        insertSigningKey: () => errAsync(outage),
        casSigningKeyState: () => errAsync(outage),
      },
    });
    await broken.ready();
    // Any failure to read the key table is "the issuer's state is unknown",
    // which is the one rotation outcome a caller may retry unchanged.
    const response = await broken.inject({
      method: "POST",
      url: "/api/v1/issuer/signing-keys/activate",
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.retryable).toBe(true);
    await broken.close();
  });

  it("does not exist on a role that was not given key management", async () => {
    const withoutKeys = Fastify();
    registerRoutes(withoutKeys, task, makeHarness().deps, {}, TEST_SYSTEM_VIEW);
    await withoutKeys.ready();
    // The public issuer role serves JWKS; it must not be able to change what
    // it publishes, and a route it never registers cannot be reached at all.
    for (const url of [
      "/api/v1/issuer/signing-keys/publish",
      "/api/v1/issuer/signing-keys/activate",
    ]) {
      expect((await withoutKeys.inject({ method: "POST", url })).statusCode).toBe(404);
    }
    await withoutKeys.close();
  });
});
