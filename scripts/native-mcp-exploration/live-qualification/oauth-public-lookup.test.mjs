import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { PgClient } from "../../../apps/control-plane/src/adapters/pg/client.ts";
import { PostgreSQLMcpOAuthStore } from "../../../apps/control-plane/src/adapters/pg/mcp-oauth.ts";
import { lookup, validateManifest } from "./oauth-public-lookup.mjs";

const projectId = "4661f85f-e70f-4ccd-b50d-2524496cb02a";
const connectionId = "c25b1857-1896-45cf-a427-a90cee36d125";
const binding = {
  projectId,
  connectionId,
  service: "DD",
  url: "https://mcp.us5.datadoghq.com/v1/mcp",
};
const manifest = [
  binding,
  {
    ...binding,
    projectId: "35f581fb-7bbf-4542-a1e8-0d047657a71d",
    connectionId: "e2c2ee5c-0fc9-4133-8f41-d333ed5e46c9",
  },
];
const row = { generation: 3, rowVersion: 8, secretVersion: "123" };
const secret = {
  projectId,
  connectionId,
  oauth: {
    issuer: "https://mcp.us5.datadoghq.com",
    client: { client_id: "public-client", client_secret: "SECRET_SENTINEL" },
    tokens: { accessToken: "TOKEN_SENTINEL" },
    verifier: "VERIFIER_SENTINEL",
  },
};
const good = (value) => ({ isErr: () => false, value });
const stores = (first = row, second = row, payload = secret) => {
  let reads = 0;
  let secretReads = 0;
  return {
    store: { readReadonly: async () => good(reads++ ? second : first) },
    secrets: {
      readSecret: async () => {
        secretReads++;
        return good(payload);
      },
    },
    get secretReads() {
      return secretReads;
    },
  };
};

// These tests deliberately assert the client session and SQL sequence, not just the returned row.
test("readonly session and transaction precede all SELECTs, including catalog gate", async () => {
  const original = pg.Pool.prototype.connect;
  const statements = [];
  pg.Pool.prototype.connect = async function () {
    assert.match(this.options.options, /default_transaction_read_only=on/);
    return {
      query: async (sql) => {
        statements.push(sql);
        return {
          rows: sql.includes("FROM projects")
            ? [{ state: "active" }]
            : sql.includes("FROM project_mcp")
              ? [{ "?column?": 1 }]
              : [{ project_id: projectId, url: binding.url, state: row }],
          rowCount: 1,
        };
      },
      release() {},
    };
  };
  try {
    const db = new PgClient("postgresql://example.invalid/db", true);
    const store = new PostgreSQLMcpOAuthStore(db);
    const result = await store.readReadonly(undefined, {
      projectId,
      id: connectionId,
      url: binding.url,
    });
    assert.equal(result.isOk(), true);
    assert.equal(statements[0], "BEGIN READ ONLY");
    assert.equal(statements[1].includes("FOR UPDATE"), false);
    assert.equal(statements.at(-1), "COMMIT");
  } finally {
    pg.Pool.prototype.connect = original;
  }
});

test("normal client and OAuth read retain locking transaction", async () => {
  const original = pg.Pool.prototype.connect;
  const statements = [];
  pg.Pool.prototype.connect = async function () {
    assert.equal(this.options.options, undefined);
    assert.equal(this.options.max, 10);
    return {
      query: async (sql) => {
        statements.push(sql);
        return {
          rows: sql.includes("FROM projects")
            ? [{ state: "active" }]
            : sql.includes("FROM project_mcp")
              ? [{ "?column?": 1 }]
              : [{ project_id: projectId, url: binding.url, state: row }],
          rowCount: 1,
        };
      },
      release() {},
    };
  };
  try {
    const store = new PostgreSQLMcpOAuthStore(new PgClient("postgresql://example.invalid/db"));
    const result = await store.read(undefined, { projectId, id: connectionId, url: binding.url });
    assert.equal(result.isOk(), true);
    assert.equal(statements[0], "BEGIN");
    assert.match(statements[1], /FOR UPDATE$/);
    assert.equal(statements.at(-1), "COMMIT");
  } finally {
    pg.Pool.prototype.connect = original;
  }
});

test("manifest permits only an exact provider pair across both projects", () => {
  assert.equal(validateManifest(manifest), true);
  assert.equal(validateManifest([binding]), false);
  assert.equal(validateManifest([...manifest, binding]), false);
  assert.equal(validateManifest(manifest.map((b, i) => (i ? { ...b, service: "CF" } : b))), false);
  assert.equal(
    validateManifest(
      manifest.map((b, i) =>
        i ? { ...b, connectionId: "406a3aeb-7e46-492e-b56a-07364453d511" } : b,
      ),
    ),
    false,
  );
  assert.equal(
    validateManifest(manifest.map((b, i) => (i ? { ...b, url: "https://example.com" } : b))),
    false,
  );
  const cf = [
    {
      projectId,
      connectionId: "1cfa006b-da21-4c11-9b5b-95cd28a9bf1b",
      service: "CF",
      url: "https://mcp.cloudflare.com/mcp",
    },
    {
      projectId: manifest[1].projectId,
      connectionId: "406a3aeb-7e46-492e-b56a-07364453d511",
      service: "CF",
      url: "https://mcp.cloudflare.com/mcp",
    },
  ];
  assert.equal(validateManifest(cf), true);
  assert.equal(validateManifest([{ ...binding, url: "https://example.com" }, manifest[1]]), false);
});

test("unknown binding cannot read a credential", async () => {
  const fake = stores();
  assert.equal(
    (await lookup({ ...binding, url: "https://example.com" }, fake.store, fake.secrets)).status,
    "rejected",
  );
  assert.equal(fake.secretReads, 0);
});

test("only bounded public fields escape; ownership and generation fence fail closed", async () => {
  const { store, secrets } = stores();
  const publicResult = await lookup(binding, store, secrets);
  assert.equal(JSON.stringify(publicResult).includes("SENTINEL"), false);
  assert.deepEqual(publicResult, {
    status: "ok",
    projectId,
    connectionId,
    issuer: secret.oauth.issuer,
    client_id: "public-client",
    authMethod: null,
    generation: 3,
  });
  assert.equal(
    (
      await lookup(
        binding,
        ...Object.values(stores(row, row, { ...secret, connectionId: "wrong" })).slice(0, 2),
      )
    ).status,
    "rejected",
  );
  assert.equal(
    (await lookup(binding, ...Object.values(stores(row, { ...row, generation: 4 })).slice(0, 2)))
      .status,
    "rejected",
  );
  assert.equal(
    (
      await lookup(
        binding,
        ...Object.values(stores(row, { ...row, secretVersion: "124" })).slice(0, 2),
      )
    ).status,
    "rejected",
  );
});

test("public fields cannot leak stored secrets or unbounded registration IDs", async () => {
  for (const value of [
    "TOKEN_SENTINEL",
    "VERIFIER_SENTINEL",
    "SECRET_SENTINEL",
    "TOPLEVEL_ACCESS_SENTINEL",
    "TOPLEVEL_REFRESH_SENTINEL",
    "x".repeat(2049),
  ]) {
    const payload = {
      ...secret,
      access: "TOPLEVEL_ACCESS_SENTINEL",
      refresh: "TOPLEVEL_REFRESH_SENTINEL",
      oauth: { ...secret.oauth, client: { ...secret.oauth.client, client_id: value } },
    };
    const fake = stores(row, row, payload);
    const output = JSON.stringify(await lookup(binding, fake.store, fake.secrets));
    assert.equal(output.includes(value), false);
    assert.match(output, /"status":"rejected"/);
  }
  for (const issuer of [
    "https://mcp.us5.datadoghq.com/?q=1",
    "https://mcp.us5.datadoghq.com/#hash",
    "https://user@mcp.us5.datadoghq.com/",
  ]) {
    const fake = stores(row, row, { ...secret, oauth: { ...secret.oauth, issuer } });
    assert.equal((await lookup(binding, fake.store, fake.secrets)).status, "rejected");
  }
});

test("errors contain only fixed stage and reason codes, never raw messages", async () => {
  const fake = stores();
  fake.store.readReadonly = async () => {
    throw new Error("SECRET_SENTINEL TOKEN_SENTINEL");
  };
  const result = await lookup(binding, fake.store, fake.secrets);
  assert.deepEqual(result, {
    status: "unavailable",
    stage: "binding_before",
    reason: "read_failed",
  });
  assert.equal(JSON.stringify(result).includes("SENTINEL"), false);
  const failed = stores();
  failed.secrets.readSecret = async () => ({
    isErr: () => true,
    error: { message: "TOKEN_SENTINEL" },
  });
  assert.deepEqual(await lookup(binding, failed.store, failed.secrets), {
    status: "unavailable",
    stage: "credential",
    reason: "read_failed",
  });
});
