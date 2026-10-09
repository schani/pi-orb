import {
  type CommittedDisplayDetail,
  type LiveDisplayDetail,
  projectRecordDetail,
  projectRecordImage,
} from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, ok, type Result } from "neverthrow";
import { withDeadline } from "./dst.ts";
import { agentPlacement } from "./harness-agent-plane.ts";
import type { ControlPlaneDeps } from "./ports.ts";

type DetailError = {
  readonly type: "orb_missing" | "detail_missing" | "unavailable" | "invalid_session";
  readonly source: "replica" | "runtime" | "orb" | "agent";
};
type DetailRef = { orbId: string; sessionId: string; recordId: string; detailKey: string };

async function runtimeAddress(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  hostRef: string,
): Promise<Result<string, DetailError>> {
  const observed = await withDeadline(
    task,
    deps.constants.providerOperationTimeoutMs,
    "observe host for detail",
    (context) =>
      deps.hostProvider.observe(
        task,
        { provider: deps.hostProvider.kind, resourceId: hostRef },
        context,
      ),
  );
  return observed.isErr() ||
    observed.value?.state !== "running" ||
    observed.value.runtimeAddress === undefined
    ? err({ type: "unavailable", source: "runtime" })
    : ok(observed.value.runtimeAddress.baseUrl);
}

/** Read committed history first; only an already-running host can answer a replica gap. */
export async function readDisplayDetail(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  ref: DetailRef,
): Promise<import("neverthrow").Result<CommittedDisplayDetail, DetailError>> {
  const orb = await deps.store.getOrb(task, ref.orbId);
  if (orb.isErr()) return err({ type: "unavailable", source: "orb" });
  if (orb.value === null || orb.value.state === "deleting")
    return err({ type: "orb_missing", source: "orb" });
  const record = await deps.store.readHistoryRecord(task, ref.orbId, ref.sessionId, ref.recordId);
  if (record.isErr()) return err({ type: "unavailable", source: "replica" });
  if (record.value !== null) {
    const current = await deps.store.getOrb(task, ref.orbId);
    if (current.isErr()) return err({ type: "unavailable", source: "orb" });
    if (current.value === null || current.value.state === "deleting")
      return err({ type: "orb_missing", source: "orb" });
    if (current.value.harnessSessionId !== ref.sessionId)
      return err({ type: "invalid_session", source: "replica" });
    const body = projectRecordDetail(record.value, ref.detailKey);
    return body === null
      ? err({ type: "detail_missing", source: "replica" })
      : ok({
          v: 1,
          sessionId: ref.sessionId,
          recordId: ref.recordId,
          detailKey: ref.detailKey,
          state: "committed",
          body,
        });
  }
  if (
    agentPlacement(deps.agentPlane, orb.value) === "central" ||
    (orb.value.state !== "running" &&
      orb.value.state !== "stopping" &&
      orb.value.state !== "archiving")
  )
    return err({
      type: orb.value.harnessSessionId === ref.sessionId ? "detail_missing" : "invalid_session",
      source: "replica",
    });
  if (orb.value.hostRef === null) return err({ type: "unavailable", source: "runtime" });
  const address = await runtimeAddress(task, deps, orb.value.hostRef);
  if (address.isErr()) return err(address.error);
  const response = await withDeadline(
    task,
    deps.constants.runtimeRequestTimeoutMs,
    "read runtime detail",
    (context) =>
      deps.runtimeClient.readDisplayDetail(
        task,
        address.value,
        ref.sessionId,
        ref.recordId,
        ref.detailKey,
        context,
      ),
  );
  if (response.isErr())
    return err({
      type: response.error.code === "cursor_not_found" ? "invalid_session" : "unavailable",
      source: "runtime",
    });
  const current = await deps.store.getOrb(task, ref.orbId);
  if (
    current.isErr() ||
    current.value === null ||
    current.value.state === "deleting" ||
    current.value.hostRef !== orb.value.hostRef ||
    (current.value.harnessSessionId !== null && current.value.harnessSessionId !== ref.sessionId) ||
    (current.value.state !== "running" &&
      current.value.state !== "stopping" &&
      current.value.state !== "archiving")
  )
    return err({ type: "unavailable", source: "runtime" });
  if (
    response.value.sessionId !== ref.sessionId ||
    response.value.recordId !== ref.recordId ||
    response.value.detailKey !== ref.detailKey
  )
    return err({ type: "invalid_session", source: "runtime" });
  return ok(response.value);
}

export async function readLiveDisplayDetail(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  ref: { orbId: string; sessionId: string; operationId: string; blockId: string },
): Promise<import("neverthrow").Result<LiveDisplayDetail, DetailError>> {
  const orb = await deps.store.getOrb(task, ref.orbId);
  if (orb.isErr()) return err({ type: "unavailable", source: "orb" });
  if (orb.value === null || orb.value.state === "deleting")
    return err({ type: "orb_missing", source: "orb" });
  if (agentPlacement(deps.agentPlane, orb.value) === "central") {
    const session = deps.agentPlane?.session(ref.orbId) ?? null;
    if (session === null) return err({ type: "unavailable", source: "agent" });
    const snapshot = session.snapshot();
    if (snapshot.isErr()) return err({ type: "unavailable", source: "agent" });
    if (snapshot.value.session.id !== ref.sessionId)
      return err({ type: "invalid_session", source: "agent" });
    const live = session.liveView();
    const block = live?.blocks.find((block) => block.blockId === ref.blockId);
    if (live?.operationId !== ref.operationId || block?.blockType !== "reasoning")
      return err({ type: "detail_missing", source: "agent" });
    return ok({
      v: 1,
      sessionId: ref.sessionId,
      operationId: ref.operationId,
      blockId: ref.blockId,
      state: "running",
      body: { type: "reasoning", text: block.text },
    });
  }
  if (orb.value.state !== "running" || orb.value.hostRef === null)
    return err({ type: "unavailable", source: "runtime" });
  const address = await runtimeAddress(task, deps, orb.value.hostRef);
  if (address.isErr()) return err(address.error);
  const result = await withDeadline(
    task,
    deps.constants.runtimeRequestTimeoutMs,
    "read live detail",
    (context) =>
      deps.runtimeClient.readLiveDisplayDetail(
        task,
        address.value,
        ref.operationId,
        ref.blockId,
        context,
      ),
  );
  if (result.isErr()) return err({ type: "unavailable", source: "runtime" });
  const current = await deps.store.getOrb(task, ref.orbId);
  if (
    current.isErr() ||
    current.value === null ||
    current.value.state !== "running" ||
    current.value.hostRef !== orb.value.hostRef ||
    (current.value.harnessSessionId !== null && current.value.harnessSessionId !== ref.sessionId)
  )
    return err({ type: "unavailable", source: "runtime" });
  if (
    result.value.sessionId !== ref.sessionId ||
    result.value.operationId !== ref.operationId ||
    result.value.blockId !== ref.blockId
  )
    return err({ type: "invalid_session", source: "runtime" });
  return ok(result.value);
}

export async function readDisplayImage(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  ref: DetailRef & { imageIndex: number },
): Promise<import("neverthrow").Result<{ mediaType: string; data: Buffer }, DetailError>> {
  const orb = await deps.store.getOrb(task, ref.orbId);
  if (orb.isErr()) return err({ type: "unavailable", source: "orb" });
  if (orb.value === null || orb.value.state === "deleting")
    return err({ type: "orb_missing", source: "orb" });
  const record = await deps.store.readHistoryRecord(task, ref.orbId, ref.sessionId, ref.recordId);
  if (record.isErr()) return err({ type: "unavailable", source: "replica" });
  if (record.value !== null) {
    const current = await deps.store.getOrb(task, ref.orbId);
    if (current.isErr()) return err({ type: "unavailable", source: "orb" });
    if (current.value === null || current.value.state === "deleting")
      return err({ type: "orb_missing", source: "orb" });
    if (current.value.harnessSessionId !== ref.sessionId)
      return err({ type: "invalid_session", source: "replica" });
    const image = projectRecordImage(record.value, ref.detailKey, ref.imageIndex);
    if (image === null) return err({ type: "detail_missing", source: "replica" });
    if (!/^image\/(png|jpeg|gif|webp)$/.test(image.mediaType))
      return err({ type: "unavailable", source: "replica" });
    return ok({ mediaType: image.mediaType, data: Buffer.from(image.data, "base64") });
  }
  if (
    agentPlacement(deps.agentPlane, orb.value) === "central" ||
    (orb.value.state !== "running" &&
      orb.value.state !== "stopping" &&
      orb.value.state !== "archiving")
  )
    return err({
      type: orb.value.harnessSessionId === ref.sessionId ? "detail_missing" : "invalid_session",
      source: "replica",
    });
  if (orb.value.hostRef === null) return err({ type: "unavailable", source: "runtime" });
  const address = await runtimeAddress(task, deps, orb.value.hostRef);
  if (address.isErr()) return err(address.error);
  const image = await withDeadline(
    task,
    deps.constants.runtimeRequestTimeoutMs,
    "read runtime image",
    (context) =>
      deps.runtimeClient.readDisplayImage(
        task,
        address.value,
        ref.sessionId,
        ref.recordId,
        ref.detailKey,
        ref.imageIndex,
        context,
      ),
  );
  if (image.isErr())
    return err({
      type: image.error.code === "cursor_not_found" ? "invalid_session" : "unavailable",
      source: "runtime",
    });
  const current = await deps.store.getOrb(task, ref.orbId);
  if (
    current.isErr() ||
    current.value === null ||
    current.value.state === "deleting" ||
    current.value.hostRef !== orb.value.hostRef ||
    (current.value.harnessSessionId !== null && current.value.harnessSessionId !== ref.sessionId) ||
    (current.value.state !== "running" &&
      current.value.state !== "stopping" &&
      current.value.state !== "archiving")
  )
    return err({ type: "unavailable", source: "runtime" });
  return ok(image.value);
}
