import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { ResultAsync } from "neverthrow";
import { PgClient } from "../../../apps/control-plane/src/adapters/pg/client.ts";
import { PostgreSQLMcpOAuthStore } from "../../../apps/control-plane/src/adapters/pg/mcp-oauth.ts";
import { GsmSecretStore } from "../../../apps/control-plane/src/adapters/secrets/gsm-store.ts";
import { MCP_OAUTH_SECRETS } from "../../../apps/control-plane/src/domain/mcp-oauth.ts";

const dedicated = "4661f85f-e70f-4ccd-b50d-2524496cb02a";
const glide = "35f581fb-7bbf-4542-a1e8-0d047657a71d";
const numeric = /^[1-9][0-9]*$/;
const bindings = {
  CF: {
    url: "https://mcp.cloudflare.com/mcp",
    ids: {
      [dedicated]: "1cfa006b-da21-4c11-9b5b-95cd28a9bf1b",
      [glide]: "406a3aeb-7e46-492e-b56a-07364453d511",
    },
  },
  DD: {
    url: "https://mcp.us5.datadoghq.com/v1/mcp",
    ids: {
      [dedicated]: "c25b1857-1896-45cf-a427-a90cee36d125",
      [glide]: "e2c2ee5c-0fc9-4133-8f41-d333ed5e46c9",
    },
  },
};

function knownBinding(b) {
  return (
    b &&
    typeof b === "object" &&
    Object.keys(b).sort().join(",") === "connectionId,projectId,service,url" &&
    Object.hasOwn(bindings, b.service) &&
    Object.hasOwn(bindings[b.service].ids, b.projectId) &&
    b.connectionId === bindings[b.service].ids[b.projectId] &&
    b.url === bindings[b.service].url
  );
}

export function validateManifest(manifest) {
  return (
    Array.isArray(manifest) &&
    manifest.length === 2 &&
    manifest.every(knownBinding) &&
    manifest[0].service === manifest[1].service &&
    manifest[0].projectId !== manifest[1].projectId
  );
}

function failure(status, stage, reason) {
  return { status, stage, reason };
}

function storedSensitiveStrings(secret) {
  const oauth = secret.oauth;
  const found = [];
  function visit(value) {
    if (typeof value === "string") {
      if (value) found.push(value);
      return;
    }
    if (value && typeof value === "object") for (const child of Object.values(value)) visit(child);
  }
  visit(secret.access);
  visit(secret.refresh);
  for (const [key, value] of Object.entries(oauth)) {
    if (/token|verifier|secret/i.test(key)) visit(value);
  }
  if (oauth.client && typeof oauth.client === "object") visit(oauth.client.client_secret);
  return found;
}

// The two reads recheck the active project and exact catalog ID/URL; no credential escapes this function.
export async function lookup(b, store, secrets) {
  if (!knownBinding(b)) return failure("rejected", "manifest", "unknown_binding");
  const binding = { projectId: b.projectId, id: b.connectionId, url: b.url };
  let stage = "binding_before";
  try {
    const first = await store.readReadonly(undefined, binding);
    if (first.isErr()) return failure("unavailable", stage, "read_failed");
    if (!first.value) return failure("rejected", stage, "missing");
    const { secretVersion, generation, rowVersion } = first.value;
    if (
      !numeric.test(secretVersion ?? "") ||
      !Number.isSafeInteger(generation) ||
      generation < 1 ||
      !Number.isSafeInteger(rowVersion)
    )
      return failure("rejected", stage, "invalid_pointer");
    stage = "credential";
    const loaded = await secrets.readSecret(undefined, MCP_OAUTH_SECRETS, secretVersion);
    if (loaded.isErr() || !loaded.value) return failure("unavailable", stage, "read_failed");
    const secret = loaded.value;
    if (secret.projectId !== b.projectId || secret.connectionId !== b.connectionId)
      return failure("rejected", stage, "owner_mismatch");
    stage = "binding_after";
    const second = await store.readReadonly(undefined, binding);
    if (second.isErr()) return failure("unavailable", stage, "read_failed");
    if (
      !second.value ||
      second.value.secretVersion !== secretVersion ||
      second.value.generation !== generation ||
      second.value.rowVersion !== rowVersion
    )
      return failure("rejected", stage, "changed");
    stage = "public_fields";
    const issuer = secret.oauth?.issuer;
    const client_id = secret.oauth?.client?.client_id;
    const method = secret.oauth?.client?.token_endpoint_auth_method;
    const authMethod = method === undefined ? null : method;
    if (
      typeof issuer !== "string" ||
      issuer.length > 2048 ||
      typeof client_id !== "string" ||
      !client_id ||
      client_id.length > 2048 ||
      ![null, "none", "client_secret_basic", "client_secret_post"].includes(authMethod)
    )
      return failure("rejected", stage, "invalid");
    let parsed;
    try {
      parsed = new URL(issuer);
    } catch {
      return failure("rejected", stage, "invalid");
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      (parsed.href !== issuer && !(parsed.pathname === "/" && parsed.href === `${issuer}/`))
    )
      return failure("rejected", stage, "invalid");
    if (
      storedSensitiveStrings(secret).some(
        (value) =>
          issuer.includes(value) || client_id.includes(value) || authMethod?.includes(value),
      )
    )
      return failure("rejected", stage, "secret_in_public_field");
    return {
      status: "ok",
      projectId: b.projectId,
      connectionId: b.connectionId,
      issuer,
      client_id,
      authMethod,
      generation,
    };
  } catch {
    return failure("unavailable", stage, "read_failed");
  }
}

async function databaseUrl(project, secret, version) {
  if (!/^[a-zA-Z0-9_-]+$/.test(secret) || !numeric.test(version)) return null;
  const client = new SecretManagerServiceClient();
  const read = await ResultAsync.fromPromise(
    client.accessSecretVersion(
      { name: `projects/${project}/secrets/${secret}/versions/${version}` },
      { timeout: 5000 },
    ),
    () => ({ code: "unavailable" }),
  );
  if (read.isErr()) return null;
  const data = read.value[0]?.payload?.data;
  return data ? Buffer.from(data).toString("utf8") : null;
}

export async function main(argv) {
  // argv contains only nonsecret metadata; DB URL stays in memory, never env/argv/stdout.
  if (
    argv.length !== 5 ||
    !/^[a-z][a-z0-9-]+$/.test(argv[1]) ||
    !/^[a-zA-Z0-9_-]+$/.test(argv[2]) ||
    !numeric.test(argv[3]) ||
    !/^[a-zA-Z0-9_-]+$/.test(argv[4])
  )
    return { status: "invalid_input" };
  let manifest;
  try {
    manifest = JSON.parse(await readFile(argv[0], "utf8"));
  } catch {
    return { status: "invalid_input" };
  }
  if (!validateManifest(manifest)) return { status: "invalid_input" };
  const url = await databaseUrl(argv[1], argv[2], argv[3]);
  if (!url) return { status: "unavailable" };
  const db = new PgClient(url, true);
  const store = new PostgreSQLMcpOAuthStore(db);
  const secrets = new GsmSecretStore({ projectId: argv[1], secretPrefix: argv[4] });
  const results = [];
  try {
    for (const b of manifest) results.push(await lookup(b, store, secrets));
  } finally {
    await db.end();
  }
  return { status: "complete", results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (result.status !== "complete" || result.results.some((r) => r.status !== "ok"))
        process.exitCode = 1;
    },
    () => {
      process.stdout.write('{"status":"unavailable"}\n');
      process.exitCode = 1;
    },
  );
}
