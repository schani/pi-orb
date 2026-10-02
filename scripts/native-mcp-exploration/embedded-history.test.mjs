import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { mapPiEntry } from "../../apps/orb-runtime/src/pi/mapping.ts";
import { openEmbeddedFixture } from "./embedded-fixture.mjs";

async function createFixture(options) {
  const created = await openEmbeddedFixture(options);
  assert.equal(created.isOk(), true, created.isErr() ? created.error.message : "");
  return created.value;
}

const result = (entry) => {
  const mapped = mapPiEntry(entry);
  assert.equal(mapped.isOk(), true, mapped.isErr() ? mapped.error.message : "");
  return mapped.value;
};

test("scripted session discovers MCP through codemode, stores values and preserves nested calls on reload", {
  timeout: 5000,
}, async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.close());
  try {
    await fixture.start();
    await fixture.promptCodemode();
    assert.ok(fixture.session.getActiveToolNames().includes("codemode"));
    assert.equal(
      fixture.session.getActiveToolNames().includes("mcp__fixture__echo"),
      false,
      "MCP callable is not directly declared",
    );
    const entries = fixture.manager.getEntries();
    const tool = entries.find(
      (e) =>
        e.type === "message" &&
        e.message.role === "toolResult" &&
        e.message.toolName === "codemode",
    );
    assert.ok(tool, "codemode result persisted");
    assert.equal(tool.message.isError, false, JSON.stringify(tool.message.content));
    assert.match(JSON.stringify(tool.message.content), /fixture-result/);
    assert.equal(tool.message.nestedCalls?.calls?.[0]?.name, "mcp__fixture__echo");
    const stored = entries.find((e) => e.type === "custom" && e.customType === "codemode-store");
    assert.ok(stored);
    assert.ok(stored.data?.set?.evidence?.matches > 0, JSON.stringify(stored.data));
    const mapped = entries.map(result);
    const projection = mapped.find((e) => e.id === tool.id);
    assert.equal(
      projection.overflow.native.message.nestedCalls.calls[0].name,
      "mcp__fixture__echo",
    );
    assert.equal(JSON.stringify(projection).includes("nestedCalls"), true);
    assert.equal(
      JSON.stringify({ ...projection, overflow: undefined }).includes("nestedCalls"),
      true,
      "typed projection carries nested summary",
    );
    assert.ok(
      fixture.events.some(
        (e) =>
          e.type === "tool_execution_start" &&
          e.parentToolCallId &&
          e.toolName === "mcp__fixture__echo",
      ),
    );
    const file = fixture.manager.getSessionFile();
    assert.ok(file);
    assert.match(await readFile(file, "utf8"), /codemode-store/);
    const reloaded = fixture.reload();
    assert.ok(
      reloaded.getEntries().some((e) => e.type === "custom" && e.customType === "codemode-store"),
    );
    assert.ok(reloaded.getEntries().some((e) => e.id === tool.id && e.message.nestedCalls));
  } catch (error) {
    await fixture.trace("history", error);
    throw error;
  }
});

test("accepted MCP call cancellation and awaited runtime shutdown close the connection", {
  timeout: 5000,
}, async (t) => {
  const fixture = await createFixture({ blockedCall: true });
  t.after(() => fixture.close());
  try {
    await fixture.start();
    const prompt = fixture.promptCodemode();
    await fixture.callAccepted;
    const abort = fixture.session.abort();
    const terminal = await fixture.callTerminated;
    assert.equal(terminal.isError, true, "nested MCP call ended with error before server reply");
    await abort;
    fixture.releaseCall();
    await prompt;
    assert.equal(fixture.requests.filter((r) => r.method === "tools/call").length, 1);
    assert.ok(
      fixture.events.some(
        (e) => e.type === "tool_execution_end" && e.toolName === "mcp__fixture__echo" && e.isError,
      ),
    );
    assert.ok(
      fixture.manager
        .getEntries()
        .some(
          (e) =>
            e.type === "message" &&
            e.message.role === "toolResult" &&
            e.message.toolName === "codemode" &&
            e.message.isError,
        ),
      "codemode persisted aborted tool result",
    );
    await fixture.close();
    assert.equal(fixture.connections, 0);
  } catch (error) {
    await fixture.trace("cancel", error);
    throw error;
  }
});

test("two native sessions own separate connections; child shutdown leaves root usable", {
  timeout: 5000,
}, async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.close());
  let child;
  try {
    await fixture.start();
    await fixture.promptCodemode();
    assert.equal(fixture.connections, 1);
    child = await fixture.openChild();
    fixture.scriptNext();
    await child.session.prompt("Call the MCP tool from child codemode");
    assert.equal(fixture.connections, 2, "native sessions do not share transport");
    const [rootId, childId] = fixture.requests
      .filter((r) => r.method === "notifications/initialized")
      .map((r) => r.sessionId);
    assert.ok(rootId && childId, "both sessions initialized");
    assert.notEqual(rootId, childId);
    const initializations = fixture.requests.filter((r) => r.method === "initialize").length;
    await child.dispose();
    child = undefined;
    assert.equal(fixture.connections, 1);
    assert.ok(fixture.requests.some((r) => r.method === "DELETE" && r.sessionId === childId));
    assert.equal(
      fixture.requests.some((r) => r.method === "DELETE" && r.sessionId === rootId),
      false,
    );
    fixture.scriptNext();
    await fixture.promptCodemode();
    assert.equal(fixture.requests.filter((r) => r.method === "tools/call").length, 3);
    assert.equal(
      fixture.requests.filter((r) => r.method === "tools/call").at(-1).sessionId,
      rootId,
    );
    assert.equal(
      fixture.requests.filter((r) => r.method === "initialize").length,
      initializations,
      "root did not reconnect",
    );
    assert.equal(
      fixture.manager
        .getEntries()
        .filter(
          (e) =>
            e.type === "message" &&
            e.message.role === "toolResult" &&
            e.message.toolName === "codemode" &&
            !e.message.isError,
        ).length,
      2,
      "root call still succeeds",
    );
  } catch (error) {
    await fixture.trace("child", error);
    throw error;
  } finally {
    await child?.dispose();
  }
});

test("shutdown during pending startup does not retain a late connection", {
  timeout: 5000,
}, async (t) => {
  const fixture = await createFixture({ blockedStartup: true });
  t.after(() => fixture.close());
  try {
    await fixture.start();
    await fixture.startupAccepted;
    const closing = fixture.close();
    fixture.releaseStartup();
    await closing;
    assert.equal(fixture.connections, 0);
  } catch (error) {
    fixture.releaseStartup();
    await fixture.trace("startup-race", error);
    throw error;
  }
});

test("failed startup attempts are observable on transport, but SDK history lacks the failure", {
  timeout: 5000,
}, async (t) => {
  const fixture = await createFixture({ failStartup: true });
  t.after(() => fixture.close());
  try {
    await fixture.start();
    await fixture.promptCodemode();
    assert.ok(
      fixture.requests.some((r) => r.method === "initialize"),
      "connection was attempted",
    );
    assert.equal(
      fixture.requests.some((r) => r.method === "tools/call"),
      false,
    );
    assert.equal(
      fixture.manager.getEntries().some((e) => /fixture startup refused/.test(JSON.stringify(e))),
      false,
      "SDK session does not persist MCP startup notifications",
    );
  } catch (error) {
    await fixture.trace("startup", error);
    throw error;
  }
});
