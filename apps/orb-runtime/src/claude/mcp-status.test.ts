import { randomUUID } from "node:crypto";
import type { McpServerStatus, SDKSystemMessage } from "@anthropic-ai/claude-agent-sdk";
import { expect, it } from "vitest";
import { createMcpStateReporter, type OrbMcpState } from "../mcp/transport.ts";
import { ComposedClaudeFixture } from "../testkit/claude-composed.ts";
import { createClaudeMcpStatusReporter } from "./mcp-status.ts";

it("captures repository startup failures and native recovery with source, never raw SDK fields", () => {
  const events: OrbMcpState[] = [];
  const report = createClaudeMcpStatusReporter((event) => events.push(event));
  const failed: McpServerStatus = {
    name: "datadog",
    status: "failed",
    source: "project",
    scope: "project",
    error: "private-helper-output",
    config: {
      type: "http",
      url: "https://private-config.test",
      headers: { Authorization: "private-token" },
    },
    serverInfo: { name: "private-server-info", version: "private-version" },
    tools: [{ name: "private-tool", description: "private-description" }],
  };
  report([{ name: "healthy", status: "connected", source: "sdk" }]);
  report([{ name: "healthy", status: "connected", source: "project" }]);
  report([failed]);
  report([failed]);
  report([{ ...failed, status: "pending" }]);
  report([failed]);
  report([{ ...failed, status: "connected" }]);
  report([{ ...failed, status: "connected" }]);
  expect(events).toEqual([
    {
      server: "datadog",
      state: "failed",
      message: "MCP datadog (project): native failed",
      diagnostic: { code: "connection_failed" },
      source: "project",
      observation: "native",
    },
    {
      server: "datadog",
      state: "connected",
      message: "MCP datadog (project): native connected",
      source: "project",
      observation: "native",
    },
  ]);
  expect(JSON.stringify(events)).not.toContain("private");
});

it("uses explicit native auth status without inferring authentication from error prose or catalog names", () => {
  const events: OrbMcpState[] = [];
  const report = createClaudeMcpStatusReporter((event) => events.push(event));
  report([
    { name: "datadog", status: "failed", source: "project" },
    { name: "cloudflare", status: "needs-auth", source: "sdk" },
    { name: "legacy", status: "failed" },
    { name: "future", status: "failed", source: "private-source" },
    { name: "private-token\nhelper-output", status: "failed", source: "project" },
    { name: "private-token\n", status: "failed", source: "project" },
    { name: "x".repeat(129), status: "failed", source: "project" },
    { name: "https://private.test/token", status: "failed", source: "project" },
    { name: "future-status", status: "private-status", source: "project" },
  ]);
  expect(events).toMatchObject([
    {
      server: "datadog",
      state: "failed",
      source: "project",
      diagnostic: { code: "connection_failed" },
    },
    {
      server: "cloudflare",
      state: "needs-auth",
      source: "sdk",
      diagnostic: { code: "auth_required" },
    },
    { server: "legacy", state: "failed", source: "unknown" },
    { server: "future", state: "failed", source: "unknown" },
  ]);
  expect(events).toHaveLength(4);
  expect(JSON.stringify(events)).not.toContain("private");
});

it.each(["disabled", "disconnected"])(
  "normalizes native %s, coalesces repeats and reports recovery",
  (status) => {
    const events: OrbMcpState[] = [];
    const report = createClaudeMcpStatusReporter((event) => events.push(event));
    const server = { name: "datadog", status, source: "project" };
    report([server]);
    report([server]);
    report([{ ...server, status: status === "disabled" ? "disconnected" : "disabled" }]);
    report([{ ...server, status: "connected" }]);
    report([{ ...server, status: "connected" }]);
    expect(events).toEqual([
      {
        server: "datadog",
        state: "disconnected",
        message: `MCP datadog (project): native ${status}`,
        source: "project",
        observation: "native",
      },
      {
        server: "datadog",
        state: "connected",
        message: "MCP datadog (project): native connected",
        source: "project",
        observation: "native",
      },
    ]);
  },
);

it("does not let bridge HTTP success clear a native failure or repeat native edges", () => {
  const events: OrbMcpState[] = [];
  const publish = (event: OrbMcpState) => events.push(event);
  const native = createClaudeMcpStatusReporter(publish);
  const bridge = createMcpStateReporter((event) =>
    publish({ ...event, source: "sdk", observation: "bridge" }),
  );
  const failed = { name: "datadog", status: "failed", source: "sdk" };
  native([failed]);
  bridge("datadog", "connected");
  native([failed]);
  bridge("datadog", "connected");
  bridge("datadog", "failed");
  native([{ ...failed, status: "connected" }]);
  bridge("datadog", "failed");
  bridge("datadog", "connected");
  expect(events.map(({ state, observation }) => [state, observation])).toEqual([
    ["failed", "native"],
    ["failed", "bridge"],
    ["connected", "native"],
    ["connected", "bridge"],
  ]);
});

it("retains changes in effective source while coalescing unchanged native failure levels", () => {
  const events: OrbMcpState[] = [];
  const report = createClaudeMcpStatusReporter((event) => events.push(event));
  report([{ name: "datadog", status: "failed", source: "sdk" }]);
  report([{ name: "datadog", status: "failed", source: "project" }]);
  report([{ name: "datadog", status: "failed", source: "project" }]);
  expect(events.map(({ source }) => source)).toEqual(["sdk", "project"]);
});

it("publishes per-turn init failure and recovery to durable root history, independent of project catalog", async () => {
  const f = new ComposedClaudeFixture();
  try {
    expect((await f.attach()).isOk()).toBe(true);
    expect((await f.agent.submitMessage([{ type: "text", text: "fixture" }], "op")).isOk()).toBe(
      true,
    );
    const init = (status: string): SDKSystemMessage => ({
      type: "system",
      subtype: "init",
      uuid: randomUUID(),
      session_id: f.state.id,
      apiKeySource: "none",
      claude_code_version: "2.1.318",
      cwd: f.dir,
      tools: [],
      model: "opus",
      permissionMode: "bypassPermissions",
      slash_commands: [],
      output_style: "default",
      skills: [],
      plugins: [],
      mcp_servers: [{ name: "repository-only", status, source: "project" }],
    });
    await f.query.emitUnscheduled(init("failed"));
    await f.query.emitUnscheduled(init("failed"));
    await f.query.emitUnscheduled(init("connected"));
    const events = f.history.view.filter(
      (record) => record.type === "event" && record.eventType === "claude.mcp",
    );
    expect(events).toMatchObject([
      {
        custom: { display: true },
        overflow: {
          server: "repository-only",
          state: "failed",
          source: "project",
          observation: "native",
          code: "connection_failed",
        },
      },
      {
        custom: { display: true },
        overflow: {
          server: "repository-only",
          state: "connected",
          source: "project",
          observation: "native",
        },
      },
    ]);
    expect(events).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain("/mcp");
    expect(JSON.stringify(events)).not.toContain("reconnect");
    expect(f.query.options.strictMcpConfig).toBeUndefined();
    expect(f.query.options.settingSources).toEqual(["user", "project", "local"]);
  } finally {
    f.query.exit();
    f.query.endOutput();
    await f.agent.waitForStream();
    f.dispose();
  }
});
