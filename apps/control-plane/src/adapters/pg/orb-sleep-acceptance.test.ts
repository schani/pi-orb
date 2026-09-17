import { NoSimulationTask } from "determined";
import { okAsync, ResultAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import type { StoreError } from "../../domain/errors.ts";
import type { PostgreSQLClient } from "./client.ts";
import { PostgreSQLControlPlaneStore } from "./store.ts";

class AdvancingLockClient implements PostgreSQLClient {
  now = 1_000;
  private readonly row: Record<string, unknown> = {
    id: "orb",
    project_id: "project",
    name: null,
    auto_name_lease_until: null,
    auto_name_attempts: 0,
    auto_name_next_attempt_at: null,
    state: "running",
    state_version: 0,
    host_kind: "fake",
    host_ref: "host",
    host_incarnation: 2,
    host_spec_fingerprint: null,
    host_spec_generation: null,
    host_discard_through_incarnation: null,
    host_discard_reason: null,
    host_discard_error: null,
    host_discard_evidence: null,
    host_discard_requested_at: null,
    checkout_commit: "ready",
    harness_session_id: null,
    harness_session_header: null,
    last_error: null,
    runtime_token_hash: "caller",
    replication_cursor: null,
    replicated_head_id: null,
    last_busy_at: null,
    upload_active_until: null,
    stop_reason: null,
    sleep_id: null,
    sleep_until: null,
    last_mint_at: null,
    state_changed_at: new Date(0),
    archived_at: null,
    created_at: new Date(0),
    updated_at: new Date(0),
  };

  query(text: string, values: unknown[] = []) {
    this.now = 5_000;
    if (text.startsWith("SELECT")) return okAsync({ rows: [this.row], rowCount: 1 });
    const sleepUntil = values[2];
    return okAsync({
      rows: [
        {
          ...this.row,
          sleep_id: values[1],
          sleep_until: sleepUntil,
          state_version: 1,
          updated_at: values[3],
        },
      ],
      rowCount: 1,
    });
  }

  transaction<T, E>(
    f: (
      query: (text: string, values?: unknown[]) => ReturnType<AdvancingLockClient["query"]>,
      execute: (text: string) => ResultAsync<void, StoreError>,
    ) => Promise<import("neverthrow").Result<T, E>>,
  ): ResultAsync<T, E | StoreError> {
    return new ResultAsync(
      f(this.query.bind(this), () => okAsync(undefined)) as Promise<
        import("neverthrow").Result<T, E | StoreError>
      >,
    );
  }

  end() {
    return okAsync(undefined);
  }
}

class InjectedClockTask extends NoSimulationTask {
  private readonly client: AdvancingLockClient;

  constructor(client: AdvancingLockClient) {
    super("sleep acceptance lock", false);
    this.client = client;
  }

  override wallNow(): number {
    return this.client.now;
  }
}

describe("PostgreSQL sleep acceptance", () => {
  it("samples the durable deadline after acquiring the orb row lock", async () => {
    const client = new AdvancingLockClient();
    const store = new PostgreSQLControlPlaneStore(client);
    const accepted = await store.scheduleOrbSleep(new InjectedClockTask(client), {
      orbId: "orb",
      caller: { runtimeTokenHash: "caller", hostIncarnation: 2 },
      sleepId: "00000000-0000-4000-8000-000000000091",
      durationSeconds: 1,
    });
    expect(accepted._unsafeUnwrap().sleepUntil).toBe(6_000);
  });
});
