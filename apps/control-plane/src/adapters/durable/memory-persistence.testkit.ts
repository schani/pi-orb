import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage, type Storage, StorageRejected } from "@earendil-works/pi-durable";
import type { SimulationTask } from "determined";
import { err, errAsync, ok, okAsync, type Result, ResultAsync } from "neverthrow";
import type { AgentSnapshot } from "../../domain/agent-ports.ts";
import type { RuntimeClientError } from "../../domain/errors.ts";
import type { OrbRow } from "../../domain/orb.ts";
import type { OperationContext } from "../../domain/ports.ts";
import { durableError } from "./manager.ts";
import type { AgentPersistence, AgentStorageLease } from "./persistence.ts";
import { projectHistory } from "./projection.ts";

/** Test-only retained memory backend. Harness close closes a view, never its backend.
 * Does not implement atomic public publication: publication tests must use PostgreSQL.
 */
export class MemoryAgentPersistence implements AgentPersistence {
  private readonly backends = new Map<string, MemoryStorage>();
  private readonly owners = new Map<
    string,
    { version: number; abort: AbortController; expires: number }
  >();
  private readonly clock: () => number;
  private readonly ttl: number;
  private readonly admissions = new Map<string, number>();
  constructor(clock: () => number = () => 0, ttl = 100) {
    this.clock = clock;
    this.ttl = ttl;
  }

  openOrb(orbId: string, existing: boolean) {
    let storage = this.backends.get(orbId);
    if (!storage) {
      if (existing) return errAsync(durableError("missing private agent authority"));
      storage = new MemoryStorage();
      this.backends.set(orbId, storage);
    }
    return okAsync({ storage: this.view(storage) });
  }

  private view(storage: MemoryStorage, check?: () => boolean): Storage {
    return new Proxy(storage, {
      get(target, key) {
        if (key === "close") return async () => undefined;
        const value = Reflect.get(target, key);
        if (typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          if (check && !check()) {
            // biome-ignore lint/plugin/no-throw: Durable Storage methods reject on fenced writes.
            throw new StorageRejected("test storage owner revoked");
          }
          return Reflect.apply(value, target, args);
        };
      },
    });
  }

  open(_task: SimulationTask, orb: OrbRow, context: OperationContext) {
    if (context.signal.aborted) return errAsync(durableError("open cancelled"));
    if (orb.agentAdmissionVersion < (this.admissions.get(orb.id) ?? 0))
      return errAsync(durableError("stale admission"));
    const previous = this.owners.get(orb.id);
    if (previous && !previous.abort.signal.aborted && previous.expires > this.clock())
      return errAsync(durableError("agent owner already held"));
    previous?.abort.abort();
    const owner = {
      version: orb.agentAdmissionVersion,
      abort: new AbortController(),
      expires: this.clock() + this.ttl,
    };
    this.admissions.set(orb.id, orb.agentAdmissionVersion);
    this.owners.set(orb.id, owner);
    const valid = () => {
      if (this.owners.get(orb.id) !== owner || owner.expires <= this.clock()) owner.abort.abort();
      return !owner.abort.signal.aborted;
    };
    return this.openOrb(orb.id, false).map(
      ({ storage }) =>
        ({
          storage: this.view(storage as MemoryStorage, valid),
          signal: owner.abort.signal,
          check: () => {
            if (!valid()) return errAsync(durableError("agent lease revoked"));
            owner.expires = this.clock() + this.ttl;
            return okAsync(undefined);
          },
          beginDrain: () => okAsync(undefined),
          release: () => {
            owner.abort.abort();
            if (this.owners.get(orb.id) === owner) this.owners.delete(orb.id);
            return okAsync(undefined);
          },
        }) satisfies AgentStorageLease,
    );
  }

  revoke(orbId: string) {
    this.owners.get(orbId)?.abort.abort();
  }

  snapshot(_task: SimulationTask, orb: OrbRow) {
    return ResultAsync.fromPromise(this.readSnapshot(orb), (error) =>
      durableError(String(error)),
    ).andThen((result) => result);
  }
  private async readSnapshot(orb: OrbRow): Promise<Result<AgentSnapshot, RuntimeClientError>> {
    const storage = this.backends.get(orb.id);
    if (!storage) return err(durableError("missing private agent authority"));
    const roots = await storage.scanConversations({}, 1000, undefined, BACKGROUND_CONTEXT);
    const root = roots.items.find((value) => !value.owner);
    if (!root) return err(durableError("missing root"));
    const identity = await storage.findDocument(
      { kind: "orb.identity", scope: { kind: "conversation", conversationId: root.id } },
      "current",
      BACKGROUND_CONTEXT,
    );
    if (!identity) return err(durableError("missing identity"));
    const document = await storage.document(identity.id, "current", BACKGROUND_CONTEXT);
    if (!document) return err(durableError("missing identity document"));
    const value = document.value;
    const entries = await storage.scanEntries(
      { conversationId: root.id },
      10000,
      undefined,
      BACKGROUND_CONTEXT,
    );
    const records = projectHistory([...entries.items].reverse(), String(value["sessionId"]));
    if (records.isErr()) return err(durableError(records.error.message));
    return ok({
      orbId: orb.id,
      runtimeInstanceId: "passive-memory",
      activity: "idle",
      session: {
        id: String(value["sessionId"]),
        timestamp: new Date(Number(value["timestamp"])).toISOString(),
        overflow: {},
      },
      records: records.value,
      headId: records.value.at(-1)?.id ?? null,
      settings: null,
    });
  }
  dispose(_task: SimulationTask, orbId: string, deleteAuthority: boolean) {
    this.revoke(orbId);
    if (deleteAuthority) this.backends.delete(orbId);
    return okAsync(undefined);
  }
  close() {
    for (const owner of this.owners.values()) owner.abort.abort();
    this.owners.clear();
    return okAsync(undefined);
  }
}
