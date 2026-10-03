import type { OrbMessageListView, OrbMessageView } from "@pi-orb/protocol";
import { err, ok, type Result } from "neverthrow";
import type { ApiError } from "./api.ts";
import { reuseQueuedMessages } from "./queued-messages.ts";

/** Authoritative inbox rows and insertion cursor, independent of React publication. */
export function createInboxPoller(
  read: (
    after: number,
    tracked: readonly string[],
  ) => Promise<Result<OrbMessageListView, ApiError>>,
) {
  let cursor = 0;
  let current: OrbMessageView[] = [];
  let pending = false;
  return {
    cursor: () => cursor,
    rows: () => current,
    update: (transform: (rows: OrbMessageView[]) => OrbMessageView[]) => {
      current = transform(current);
      return current;
    },
    async poll(
      accept: () => boolean,
      publish: (messages: OrbMessageView[]) => void = () => {},
    ): Promise<Result<OrbMessageView[] | null, ApiError>> {
      if (pending) return ok(null);
      pending = true;
      const result = await read(
        cursor,
        current.map((message) => message.id),
      );
      pending = false;
      if (!accept()) return ok(null);
      if (result.isErr()) return err(result.error);
      if (result.value.cursor < cursor)
        return err({ type: "invalid_response", message: "inbox cursor moved backwards" });
      const newIds = new Set(result.value.items.map((message) => message.id));
      const messages = new Map(
        current
          .filter((message) => !newIds.has(message.id))
          .map((message) => [message.id, message]),
      );
      for (const message of result.value.items) messages.set(message.id, message);
      for (const update of result.value.updates) {
        const existing = messages.get(update.id);
        if (existing !== undefined)
          messages.set(update.id, {
            ...update,
            content: existing.content,
            ...(existing.system === undefined ? {} : { system: existing.system }),
          });
      }
      const merged = [...messages.values()];
      cursor = result.value.cursor;
      current = reuseQueuedMessages(current, merged);
      publish(current);
      return ok(current);
    },
  };
}
