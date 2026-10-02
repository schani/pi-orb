import assert from "node:assert/strict";
import { test } from "node:test";
import { ok } from "neverthrow";
import {
  main,
  OWNED_BINDINGS,
  qualifyOwnedRefresh,
  qualifyOwnedRefreshPreflight,
  runOwnedMode,
} from "./owned-refresh.ts";

const binding = OWNED_BINDINGS.CF;
const credential = {
  projectId: binding.projectId,
  connectionId: binding.id,
  expiresAt: Date.now() - 1000,
  refresh: "sensitive-refresh",
  oauth: { metadata: { token_endpoint: "https://mcp.cloudflare.com/token" } },
};
const pointer = { generation: 2, rowVersion: 3, secretVersion: "18", attempt: null };
function fixture(changes = {}) {
  const calls = [];
  const store = {
    readReadonly: async () => {
      calls.push("domain-read");
      return {
        isErr: () => false,
        value: calls.includes("domain-token")
          ? { ...pointer, generation: 3, rowVersion: 5, secretVersion: "19" }
          : pointer,
      };
    },
  };
  const secrets = {
    readSecret: async () => {
      calls.push("secret-read");
      return { isErr: () => false, value: credential };
    },
  };
  return {
    calls,
    deps: {
      store,
      secrets,
      now: () => Date.now(),
      makeOAuth: (endpoint, emit) => {
        calls.push("oauth-constructed");
        assert.equal(endpoint, "https://mcp.cloudflare.com/token");
        emit({ kind: "refresh_token", outcome: "present", knownScopes: [], unknownCount: 1 });
        return ok({});
      },
      makeDomain: () => ({
        token: async (_task, b, request) => {
          calls.push("domain-token");
          assert.deepEqual(b, { projectId: binding.projectId, id: binding.id, url: binding.url });
          assert.deepEqual(request, { reason: "startup" });
          return {
            isErr: () => false,
            value: { generation: 3, expiresAt: Date.now() + 3600_000, accessToken: "SECRET" },
          };
        },
      }),
      ...changes,
    },
  };
}
test("expired owned grant uses domain broker once; output excludes bearer and unknown scope names", async () => {
  const { calls, deps } = fixture();
  const result = await qualifyOwnedRefresh("CF", deps);
  assert.deepEqual(calls, [
    "domain-read",
    "secret-read",
    "domain-read",
    "oauth-constructed",
    "domain-token",
    "domain-read",
  ]);
  assert.deepEqual(result, {
    status: "refreshed",
    service: "CF",
    generationBefore: 2,
    generationAfter: 3,
    durableGeneration: 3,
    durableRowVersion: 5,
    published: true,
    scopeUnverified: false,
    observer: [{ kind: "refresh_token", outcome: "present", knownScopes: [], unknownCount: 1 }],
  });
  assert.doesNotMatch(JSON.stringify(result), /SECRET|sensitive-refresh/);
});
test("bounded public count above 2048 survives owned refresh output", async () => {
  const { deps } = fixture({
    makeOAuth: (_endpoint, emit) => {
      emit({
        kind: "refresh_token",
        outcome: "present",
        knownScopes: ["mcp_all", "PRIVATE_SCOPE"],
        unknownCount: 2101,
        secret: "PRIVATE_SENTINEL",
      });
      return ok({});
    },
  });
  const result = await qualifyOwnedRefresh("CF", deps);
  assert.equal(result.scopeUnverified, false);
  assert.deepEqual(result.observer, [
    { kind: "refresh_token", outcome: "present", knownScopes: ["mcp_all"], unknownCount: 2101 },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});
test("invalid scope diagnostics retain only fixed sanitized shape", async () => {
  const { deps } = fixture({
    makeOAuth: (_endpoint, emit) => {
      emit({
        kind: "refresh_token",
        outcome: "invalid",
        invalidReason: "invalid_syntax",
        boundaryWhitespace: true,
        nonSpaceWhitespace: false,
        disallowedCharacter: false,
        secret: "PRIVATE",
      });
      return ok({});
    },
  });
  const result = await qualifyOwnedRefresh("CF", deps);
  assert.equal(result.scopeUnverified, true);
  assert.deepEqual(result.observer, [
    {
      kind: "refresh_token",
      outcome: "invalid",
      invalidReason: "invalid_syntax",
      boundaryWhitespace: true,
      nonSpaceWhitespace: false,
      disallowedCharacter: false,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});
test("oversize scope observation does not misclassify durable publication", async () => {
  const { deps } = fixture({
    makeOAuth: (_endpoint, emit) => {
      emit({ kind: "refresh_token", outcome: "oversize" });
      return ok({});
    },
  });
  const result = await qualifyOwnedRefresh("CF", deps);
  assert.equal(result.status, "refreshed");
  assert.equal(result.published, true);
  assert.equal(result.scopeUnverified, true);
  assert.deepEqual(result.observer, [{ kind: "refresh_token", outcome: "oversize" }]);
});
test("nonexpired grant and active lease never initiate refresh", async () => {
  for (const row of [{ ...pointer, refreshLeaseUntil: Date.now() + 10000 }, pointer]) {
    const { calls, deps } = fixture({
      store: { readReadonly: async () => ({ isErr: () => false, value: row }) },
      secrets: {
        readSecret: async () => ({
          isErr: () => false,
          value: {
            ...credential,
            expiresAt: row === pointer ? Date.now() + 3600_000 : credential.expiresAt,
          },
        }),
      },
    });
    const result = await qualifyOwnedRefresh("CF", deps);
    assert.equal(result.status, "skipped");
    assert.deepEqual(calls, []);
  }
});
test("read-only preflight cannot construct OAuth or call token", async () => {
  const { calls, deps } = fixture();
  assert.deepEqual(await qualifyOwnedRefreshPreflight("CF", deps.store, deps.secrets, () => 42), {
    status: "ready",
    service: "CF",
    generation: 2,
    expiresAt: credential.expiresAt,
    observedAt: 42,
  });
  assert.deepEqual(calls, ["domain-read", "secret-read", "domain-read"]);
});
test("inspection uses only read-only dependencies and cannot open mutable domain", async () => {
  const { calls, deps } = fixture();
  const observedAt = 123456789;
  const result = await runOwnedMode(
    "CF",
    "--inspect",
    deps.store,
    deps.secrets,
    () => observedAt,
    () => {
      throw new Error("mutable domain must not be constructed");
    },
  );
  assert.deepEqual(result, {
    status: "ready",
    service: "CF",
    generation: 2,
    expiresAt: credential.expiresAt,
    observedAt,
  });
  assert.deepEqual(calls, ["domain-read", "secret-read", "domain-read"]);
  assert.doesNotMatch(JSON.stringify(result), /sensitive-refresh|secretVersion|oauth|token/);
});
test("provider error and service input cannot leak into output", async () => {
  const malicious = "secret-bearer";
  assert.deepEqual(await qualifyOwnedRefresh(malicious, fixture().deps), {
    status: "rejected",
    reason: "unknown_binding",
  });
  const { deps } = fixture({
    makeDomain: () => ({ token: async () => ({ isErr: () => true, error: { code: malicious } }) }),
  });
  assert.deepEqual((await qualifyOwnedRefresh("CF", deps)).reason, "token_failed");
  assert.doesNotMatch(JSON.stringify(await qualifyOwnedRefresh("CF", deps)), /secret-bearer/);
});
test("unchanged durable pointer does not assert publication", async () => {
  const { deps } = fixture({
    store: { readReadonly: async () => ({ isErr: () => false, value: pointer }) },
  });
  assert.equal((await qualifyOwnedRefresh("CF", deps)).reason, "publication_unverified");
});
test("DD exact stored endpoint is accepted without using Cloudflare binding", async () => {
  const dd = OWNED_BINDINGS.DD;
  let reads = 0;
  let tokens = 0;
  const store = {
    readReadonly: async () =>
      ok(
        ++reads === 3 ? { ...pointer, generation: 3, rowVersion: 5, secretVersion: "19" } : pointer,
      ),
  };
  const secrets = {
    readSecret: async () =>
      ok({
        ...credential,
        connectionId: dd.id,
        oauth: { metadata: { token_endpoint: dd.endpoint } },
      }),
  };
  const result = await qualifyOwnedRefresh("DD", {
    store,
    secrets,
    now: () => Date.now(),
    makeOAuth: (endpoint, emit) => {
      assert.equal(endpoint, dd.endpoint);
      emit({ kind: "refresh_token", outcome: "omitted" });
      return ok({});
    },
    makeDomain: () => ({
      token: async (_task, binding, request) => {
        tokens++;
        assert.deepEqual(binding, { projectId: dd.projectId, id: dd.id, url: dd.url });
        assert.deepEqual(request, { reason: "startup" });
        return ok({ generation: 3 });
      },
    }),
  });
  assert.equal(result.status, "refreshed");
  assert.equal(tokens, 1);
});
test("observer construction failure prevents the broker call", async () => {
  const { calls, deps } = fixture({ makeOAuth: () => ({ isErr: () => true }) });
  assert.equal((await qualifyOwnedRefresh("CF", deps)).reason, "observer_unavailable");
  assert.ok(!calls.includes("domain-token"));
});
test("CLI rejects every mismatched target before accessing cloud", async () => {
  const approved = [
    "CF",
    "playground-dev-6ae7",
    "pi-orb-database-url",
    "2",
    "pi-orb-credential",
    "https://pi-orb-1077475695242.us-central1.run.app/api/v1/mcp/oauth/callback",
    "--execute",
  ];
  for (let i = 0; i < approved.length; i++) {
    const input = [...approved];
    input[i] = "other";
    assert.deepEqual(await main(input), { status: "invalid_input" });
  }
  assert.deepEqual(await main(approved.slice(0, -1)), { status: "invalid_input" });
  assert.deepEqual(await main([...approved.slice(0, -1), "--unknown"]), {
    status: "invalid_input",
  });
});
test("wrong binding, missing pointer, changed pointer or token endpoint fail closed", async () => {
  assert.equal((await qualifyOwnedRefresh("GlideOS", fixture().deps)).status, "rejected");
  const missing = fixture({
    store: { readReadonly: async () => ({ isErr: () => false, value: null }) },
  });
  assert.equal((await qualifyOwnedRefresh("CF", missing.deps)).status, "rejected");
  const wrongEndpoint = fixture({
    secrets: {
      readSecret: async () => ({
        isErr: () => false,
        value: {
          ...credential,
          oauth: { metadata: { token_endpoint: "https://evil.example/token" } },
        },
      }),
    },
  });
  assert.equal((await qualifyOwnedRefresh("CF", wrongEndpoint.deps)).status, "rejected");
  const changed = fixture({
    store: {
      readReadonly: (() => {
        let reads = 0;
        return async () => ({
          isErr: () => false,
          value: ++reads === 1 ? pointer : { ...pointer, generation: 4 },
        });
      })(),
    },
  });
  assert.equal((await qualifyOwnedRefresh("CF", changed.deps)).status, "rejected");
  assert.ok(!changed.calls.includes("domain-token"));
});
