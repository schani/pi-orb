import type { Context } from "@earendil-works/chord";
import type { StorageWrite, ToolExecutionApi } from "@earendil-works/pi-durable";
import { err, ok, okAsync, ResultAsync } from "neverthrow";
import type { RuntimeClientError } from "../../domain/errors.ts";
import type { OrbAgentError } from "../../domain/orb-agent-operations.ts";
import type { Query } from "../durable-pg/executor.ts";
import type { AuthorityError } from "../durable-pg/index.ts";
import { ChildAnchor, ChildReceipts } from "./tools/subagents.ts";

export const NOTIFICATION_REQUEST_PREFIX = "subagent-notify:";
export type ParentNotification = (
  message: string,
  api: ToolExecutionApi,
  context: Context,
) => ResultAsync<{ accepted: true }, OrbAgentError>;

const rejected = (invalid = false): RuntimeClientError => ({
  type: "runtime_client_error",
  code: invalid ? "invalid_response" : "cancelled",
  message: invalid ? "Invalid notification target" : "Notification submission unavailable",
  answered: true,
  retryable: false,
});

/** Retains the native invocation fence; no Harness handle may replace the tool's handle. */
export function submitParentNotification(
  message: string,
  api: ToolExecutionApi,
  context: Context,
  admit: () => ResultAsync<void, RuntimeClientError>,
): ResultAsync<{ accepted: true }, RuntimeClientError> {
  return ResultAsync.fromPromise(
    api.commit(async (tx) => {
      const admitted = await admit();
      if (admitted.isErr()) return err(admitted.error);
      if (!message.trim()) return err(rejected(true));
      const child = await tx.conversation(api.conversationId);
      const owner = child?.owner;
      const anchor = owner && (await tx.task(owner.taskId));
      const sender = await tx.task(api.taskId);
      if (
        !owner ||
        !anchor ||
        anchor.kind !== ChildAnchor.definition.name ||
        anchor.conversationId !== owner.conversationId ||
        anchor.owner !== undefined ||
        anchor.state.status === "terminal" ||
        anchor.abortRequested ||
        !sender ||
        sender.conversationId !== child.id ||
        sender.state.status === "terminal" ||
        sender.abortRequested
      )
        return err(rejected(true));
      const parent = await tx.conversation(anchor.conversationId);
      const children = (await tx.doc(ChildReceipts, anchor.conversationId)).children;
      const receipt = Object.entries(children).find(([, row]) => row.anchor === anchor.id);
      if (!parent || !receipt) return err(rejected(true));
      return ok({
        parentId: parent.id,
        content: JSON.stringify({
          agent_id: receipt[0],
          description: receipt[1].description,
          message,
        }),
      });
    }, context),
    () => rejected(),
  )
    .andThen((result) => result)
    .andThen(({ parentId, content }) =>
      ResultAsync.fromPromise(
        (async () => {
          const admitted = await admit();
          if (admitted.isErr()) return err(admitted.error);
          const parent = await api.conversation(parentId, context);
          if (!parent) return err(rejected(true));
          const current = await admit();
          if (current.isErr()) return err(current.error);
          await parent.submit(
            {
              type: "input",
              content,
              whenBusy: "steer",
              requestId: `${NOTIFICATION_REQUEST_PREFIX}${api.taskId}:${api.callId}`,
            },
            context,
          );
          return ok({ accepted: true as const });
        })(),
        () => rejected(),
      ).andThen((result) => result),
    );
}

/** Owned-drain permits cleanup, not new or queued notification input. The caller holds the orb lock. */
export function projectNotificationAdmission(
  query: Query,
  orbId: string,
  writes: readonly StorageWrite[],
) {
  if (
    !writes.some(
      (write) =>
        write.type === "submission" &&
        write.value.type === "input" &&
        (write.value.status === "queued" || write.value.status === "placed") &&
        write.value.requestId?.startsWith(NOTIFICATION_REQUEST_PREFIX),
    )
  )
    return okAsync(undefined);
  return query(
    "SELECT o.state,o.stop_reason,o.agent_admission_version,p.admission_version FROM orbs o JOIN durable_pg_owners p ON p.orb_id=o.id WHERE o.id=$1",
    [orbId],
  ).andThen((result) => {
    const row = result.rows[0];
    return row &&
      row.stop_reason !== "manual" &&
      row.stop_reason !== "sleep" &&
      row.state !== "archived" &&
      row.state !== "deleting" &&
      Number(row.agent_admission_version) === Number(row.admission_version)
      ? ok(undefined)
      : err<never, AuthorityError>({
          type: "authority_error",
          code: "projection",
          message: "Notification admission changed",
        });
  });
}
