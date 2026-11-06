import type { McpCatalog } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import { err, errAsync, ok, okAsync } from "neverthrow";
import { expect, it, vi } from "vitest";
import { makeHarness, makeProjectRow, TEST_USER_ID } from "../testkit/fixtures.ts";
import { makeProjectSecretsHarness } from "../testkit/project-secrets.ts";
import { type McpHealthDeps, readProjectMcpStatus } from "./mcp.ts";
import { oauthError } from "./mcp-oauth.ts";
import { putProjectSecret } from "./project-secrets.ts";

const task = new NoSimulationTask("MCP health", false);
const server = {
  name: "fixture",
  url: "https://mcp.example/mcp",
  description: "Fixture",
  headers: {},
};
function fixture(servers: McpCatalog["servers"] = [server]) {
  const h = makeHarness();
  h.store.seedProject(makeProjectRow("project"));
  const catalog = { read: vi.fn(() => okAsync({ revision: 4, servers })) };
  const probe = vi.fn<McpHealthDeps["probe"]>(async () => ok(undefined));
  const token = vi.fn<McpHealthDeps["oauth"]["token"]>(async () =>
    ok({ accessToken: "PRIVATE_ACCESS", accountId: "", expiresAt: 999999, generation: 1 }),
  );
  const deps: McpHealthDeps = {
    store: h.store,
    catalog,
    projectSecrets: h.deps.projectSecrets,
    oauth: { token },
    probe,
  };
  const read = (owner = TEST_USER_ID, project = "project") =>
    readProjectMcpStatus(task, deps, project, owner);
  return { h, deps, catalog, probe, token, read };
}

it("checks ownership before reading configuration, credentials or probing", async () => {
  const f = fixture();
  for (const [owner, project] of [
    ["other", "project"],
    [TEST_USER_ID, "missing"],
  ]) {
    expect((await f.read(owner, project))._unsafeUnwrapErr().code).toBe("not_found");
  }
  expect(f.catalog.read).not.toHaveBeenCalled();
  expect(f.token).not.toHaveBeenCalled();
  expect(f.probe).not.toHaveBeenCalled();
});

it("uses saved headers/secrets and the existing OAuth authority without exposing credentials", async () => {
  const configured = {
    ...server,
    headers: { "X-Key": { secret: "KEY" }, "X-Project": { literal: "fixture" } },
    oauth: { id: "00000000-0000-4000-8000-000000000001" },
  };
  const f = fixture([configured]);
  const secrets = makeProjectSecretsHarness("project");
  (await putProjectSecret(task, secrets.deps, "project", "KEY", "PRIVATE_KEY"))._unsafeUnwrap();
  f.deps.projectSecrets = secrets.deps;
  expect((await f.read())._unsafeUnwrap()).toEqual({
    revision: 4,
    servers: [{ name: "fixture", status: "available" }],
  });
  expect(f.token).toHaveBeenCalledWith(
    task,
    {
      projectId: "project",
      id: configured.oauth.id,
      url: configured.url,
    },
    { reason: "startup" },
  );
  expect(f.probe).toHaveBeenCalledWith(configured, { KEY: "PRIVATE_KEY" }, "PRIVATE_ACCESS");
});

it("keeps grant availability independent of failed discovery and never replays or invalidates", async () => {
  const f = fixture([{ ...server, oauth: { id: "connection" } }]);
  f.probe.mockResolvedValue(err({ type: "mcp_probe_error", diagnostic: "auth_required" }));
  expect((await f.read())._unsafeUnwrap().servers).toEqual([
    { name: "fixture", status: "needs-auth", diagnostic: "auth_required" },
  ]);
  expect(f.token).toHaveBeenCalledTimes(1);
  expect(f.probe).toHaveBeenCalledTimes(1);
  expect(f.token.mock.calls[0]?.[2]).toEqual({ reason: "startup" });
});

it.each(["auth_required", "unavailable"] as const)(
  "maps broker %s without probing",
  async (code) => {
    const f = fixture([{ ...server, oauth: { id: "connection" } }]);
    f.token.mockResolvedValue(err(oauthError(code)));
    expect((await f.read())._unsafeUnwrap().servers).toEqual([
      {
        name: "fixture",
        status: code === "auth_required" ? "needs-auth" : "unknown",
        diagnostic: code === "auth_required" ? "auth_required" : "credentials_unavailable",
      },
    ]);
    expect(f.probe).not.toHaveBeenCalled();
  },
);

it("isolates unavailable secrets to bound servers and probes public servers", async () => {
  const f = fixture([
    server,
    { ...server, name: "bound", headers: { "X-Key": { secret: "KEY" } } },
  ]);
  vi.spyOn(f.deps.projectSecrets.pointers, "readSecretPointer").mockReturnValue(
    errAsync({
      type: "store_error",
      code: "unavailable",
      retryable: true,
      message: "PRIVATE_ERROR",
    }),
  );
  expect((await f.read())._unsafeUnwrap()).toEqual({
    revision: 4,
    servers: [
      { name: "fixture", status: "available" },
      { name: "bound", status: "unknown", diagnostic: "credentials_unavailable" },
    ],
  });
  expect(f.probe).toHaveBeenCalledTimes(1);
});

it("checks all servers concurrently while preserving configured order and typed failures", async () => {
  const f = fixture([server, { ...server, name: "second" }]);
  let firstDone: ((value: Awaited<ReturnType<McpHealthDeps["probe"]>>) => void) | undefined;
  f.probe.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        firstDone = resolve;
      }),
  );
  f.probe.mockImplementationOnce(async () => {
    firstDone?.(err({ type: "mcp_probe_error", diagnostic: "connection_failed" }));
    return err({ type: "mcp_probe_error", diagnostic: "invalid_binding" });
  });
  expect((await f.read())._unsafeUnwrap().servers).toEqual([
    { name: "fixture", status: "unavailable", diagnostic: "connection_failed" },
    { name: "second", status: "unknown", diagnostic: "invalid_binding" },
  ]);
});
