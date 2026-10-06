import { randomUUID } from "node:crypto";
import { err, errAsync, ok, okAsync } from "neverthrow";
import type { RuntimeClientError } from "../../domain/errors.ts";
import type { Ownership, PgDurableAuthority } from "../durable-pg/index.ts";
import type { AgentArtifacts } from "./persistence.ts";

const failure = (): RuntimeClientError => ({
  type: "runtime_client_error",
  code: "history_unavailable",
  answered: true,
  retryable: false,
  message: "Private artifact unavailable",
});
const prefix = "/orb-artifacts/";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** Bytes never expose a control-plane path and every access validates the current owner. */
export class PgAgentArtifacts implements AgentArtifacts {
  private readonly authority: PgDurableAuthority;
  private readonly owner: Ownership;
  constructor(authority: PgDurableAuthority, owner: Ownership) {
    this.authority = authority;
    this.owner = owner;
  }
  write(bytes: Uint8Array) {
    if (bytes.byteLength > 16 * 1024 * 1024) return errAsync(failure());
    const id = randomUUID();
    return this.authority
      .ownedTransaction(this.owner, async (query) => {
        const inserted = await query(
          "INSERT INTO orb_agent_artifacts(orb_id,id,bytes) VALUES($1,$2,$3)",
          [this.owner.orbId, id, Buffer.from(bytes)],
        );
        return inserted.isErr() ? err(inserted.error) : ok(`${prefix}${id}`);
      })
      .mapErr(failure);
  }
  read(path: string) {
    if (!path.startsWith(prefix)) return okAsync<Uint8Array | null, RuntimeClientError>(null);
    const id = path.slice(prefix.length);
    if (!uuid.test(id)) return errAsync(failure());
    return this.authority
      .ownedTransaction<Uint8Array | null>(this.owner, async (query) => {
        const result = await query(
          "SELECT bytes FROM orb_agent_artifacts WHERE orb_id=$1 AND id=$2",
          [this.owner.orbId, id],
        );
        if (result.isErr()) return err(result.error);
        const bytes = result.value.rows[0]?.bytes;
        return bytes instanceof Uint8Array
          ? ok(Uint8Array.from(bytes))
          : err({
              type: "authority_error" as const,
              code: "missing" as const,
              message: "Private artifact missing",
            });
      })
      .mapErr(failure);
  }
}
