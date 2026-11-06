import { randomUUID } from "node:crypto";
import type { SDKSystemMessage } from "@anthropic-ai/claude-agent-sdk";
import { expect, it } from "vitest";
import { createMcpStateReporter } from "../mcp/transport.ts";
import { ComposedClaudeFixture } from "../testkit/claude-composed.ts";
import { type ClaudeMcpState, createClaudeMcpStatusReporter } from "./mcp-status.ts";

it("coalesces safe native status/source edges independently of bridge HTTP health", () => {
  const events: ClaudeMcpState[] = [];
  const report = createClaudeMcpStatusReporter((event) => events.push(event));
  const failed = {
    name: "datadog",
    status: "failed",
    source: "project",
    error: "private-helper-output",
    config: { url: "https://private.test", headers: { Authorization: "private-token" } },
  };
  report([{ name: "healthy", status: "connected", source: "sdk" }]);
  report([{ name: "healthy", status: "connected", source: "project" }]);
  report([failed]);
  const bridgeEvents: unknown[] = [];
  const bridge = createMcpStateReporter((event) => bridgeEvents.push(event));
  bridge("datadog", "connected");
  report([
    failed,
    { ...failed, status: "pending" },
    { ...failed, status: "private-status" },
    failed,
  ]);
  const sdkFailure = { ...failed, source: "sdk" };
  report([sdkFailure, sdkFailure]);
  bridge("datadog", "failed");
  const connected = { ...failed, status: "connected" };
  report([connected, connected]);
  bridge("datadog", "failed");
  bridge("datadog", "connected");
  report([
    { name: "auth", status: "needs-auth", source: "project" },
    { name: "legacy", status: "failed" },
    { name: "future", status: "failed", source: "private-source" },
    { name: "private-token\nhelper-output", status: "failed" },
    { name: "private-token\n", status: "failed" },
    { name: "x".repeat(129), status: "failed" },
    { name: "https://private.test/token", status: "failed" },
    { name: "future-status", status: "private-status" },
  ]);
  for (const status of ["disabled", "disconnected"]) {
    const server = { name: status, source: "project" };
    const disconnected = { ...server, status };
    report([disconnected, disconnected]);
    report([{ ...server, status: status === "disabled" ? "disconnected" : "disabled" }]);
    report([{ ...server, status: "connected" }]);
  }
  expect(
    events.map((event) => [event.server, event.state, event.source, event.diagnostic?.code]),
  ).toEqual([
    ["datadog", "failed", "project", "connection_failed"],
    ["datadog", "failed", "sdk", "connection_failed"],
    ["datadog", "connected", "project", undefined],
    ["auth", "needs-auth", "project", "auth_required"],
    ["legacy", "failed", "unknown", "connection_failed"],
    ["future", "failed", "unknown", "connection_failed"],
    ["disabled", "disconnected", "project", undefined],
    ["disabled", "connected", "project", undefined],
    ["disconnected", "disconnected", "project", undefined],
    ["disconnected", "connected", "project", undefined],
  ]);
  expect(bridgeEvents).toEqual([
    { server: "datadog", state: "failed" },
    { server: "datadog", state: "connected" },
  ]);
  expect(
    events.filter((event) => event.state === "disconnected").map((event) => event.message),
  ).toEqual([
    "MCP disabled (project): native disabled",
    "MCP disconnected (project): native disconnected",
  ]);
  expect(events.every((event) => event.observation === "native")).toBe(true);
  expect(JSON.stringify(events)).not.toContain("private");
});

it("publishes repository-only per-turn init failures and recovery to durable root history", async () => {
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
    for (const status of ["connected", "failed", "failed", "pending", "failed", "connected"])
      await f.query.emitUnscheduled(init(status));
    const events = f.history.view.flatMap((record) =>
      record.type === "event" && record.eventType === "claude.mcp" ? [record] : [],
    );
    expect(events.map((event) => event.overflow)).toEqual([
      {
        server: "repository-only",
        state: "failed",
        source: "project",
        observation: "native",
        code: "connection_failed",
      },
      { server: "repository-only", state: "connected", source: "project", observation: "native" },
    ]);
    expect(events.every((event) => event.custom?.display === true)).toBe(true);
    expect(events.map((event) => event.content)).toEqual([
      [{ type: "text", text: "MCP repository-only (project): native failed" }],
      [{ type: "text", text: "MCP repository-only (project): native connected" }],
    ]);
  } finally {
    f.query.exit();
    f.query.endOutput();
    await f.agent.waitForStream();
    f.dispose();
  }
});
