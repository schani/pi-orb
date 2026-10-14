import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { errAsync, okAsync } from "neverthrow";
import { assert, expect, it, vi } from "vitest";
import type { OrbAgentOperations } from "../../../domain/orb-agent-operations.ts";
import { CallableCatalog } from "./catalog.ts";
import { createOrbTools } from "./orb-tools.ts";

const childApi = {
  taskId: 42,
  conversationId: 7,
  callId: "outer:nested:0",
} as ToolExecutionApi;

it("routes the inherited child's alert to private notification without invoking public alert", async () => {
  const invoke = vi.fn<OrbAgentOperations["invoke"]>(() => okAsync({ recordId: "public" }));
  const notifyParent = vi.fn(() => okAsync({ accepted: true as const }));
  const tools = createOrbTools({ invoke }, notifyParent);
  // Children inherit these registrations; only spawning/subagent callables are excluded.
  const childCatalog = new CallableCatalog(tools).without(["orb_spawn"]);
  const result = (
    await childCatalog.invoke("orb_alert", { message: "PRIVATE child report" }, childApi, context)
  )._unsafeUnwrap();
  expect(notifyParent).toHaveBeenCalledWith("PRIVATE child report", childApi, context);
  expect(invoke).toHaveBeenCalledExactlyOnceWith(
    { kind: "notification_admission" },
    '[42,"outer:nested:0"]',
  );
  expect(result).toMatchObject({ content: [{ type: "text", text: '{"accepted":true}' }] });
  expect(JSON.stringify(result)).not.toContain("PRIVATE child report");
});

it("preserves normal root alert routing and replay identity", async () => {
  const invoke = vi.fn<OrbAgentOperations["invoke"]>(() => okAsync({ recordId: "public" }));
  const notifyParent = vi.fn(() => okAsync({ accepted: true as const }));
  const alert = createOrbTools({ invoke }, notifyParent).find((tool) => tool.name === "orb_alert");
  assert.isDefined(alert);
  await alert.execute(
    { message: "root alert" },
    { ...childApi, conversationId: ROOT_CONVERSATION_ID },
    context,
  );
  expect(invoke).toHaveBeenCalledExactlyOnceWith(
    { kind: "alert", message: "root alert" },
    '[42,"outer:nested:0"]',
  );
  expect(notifyParent).not.toHaveBeenCalled();
  expect(alert.replay).toBe("unsafe");
});

it("does not fall back to a user alert when private admission is denied", async () => {
  const invoke = vi.fn<OrbAgentOperations["invoke"]>(() => okAsync({ recordId: "public" }));
  const denied = { code: "unauthorized" as const, message: "Notification admission revoked" };
  const notifyParent = vi.fn(() => errAsync(denied));
  const alert = createOrbTools({ invoke }, notifyParent).find((tool) => tool.name === "orb_alert");
  assert.isDefined(alert);
  const result = await alert.execute({ message: "PRIVATE" }, childApi, context);
  expect(result).toMatchObject({ isError: true });
  expect(JSON.stringify(result.content)).toContain("unauthorized");
  expect(invoke).toHaveBeenCalledExactlyOnceWith(
    { kind: "notification_admission" },
    '[42,"outer:nested:0"]',
  );
});

it("fails closed for child alerts without a private notification binding", async () => {
  const invoke = vi.fn<OrbAgentOperations["invoke"]>(() => okAsync({ recordId: "public" }));
  const alert = createOrbTools({ invoke }).find((tool) => tool.name === "orb_alert");
  assert.isDefined(alert);
  const result = await alert.execute({ message: "PRIVATE" }, childApi, context);
  expect(result).toMatchObject({ isError: true });
  expect(invoke).not.toHaveBeenCalled();
});
