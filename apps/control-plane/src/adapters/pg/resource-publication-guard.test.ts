import { okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { resourcePublicationGuard } from "./resource-publication-guard.ts";

it("rejects stopped admission and archive phases inside the locked transaction", async () => {
  for (const row of [
    { state: "archived", stop_reason: null, agent_admission_version: 3 },
    { state: "archiving", stop_reason: null, agent_admission_version: 3 },
    { state: "deleting", stop_reason: null, agent_admission_version: 3 },
    { state: "stopped", stop_reason: "manual", agent_admission_version: 3 },
    { state: "running", stop_reason: null, agent_admission_version: 4 },
  ]) {
    const guard = resourcePublicationGuard({
      expectedAdmissionVersion: 3,
      signal: new AbortController().signal,
    });
    const queries: string[] = [];
    const result = await guard((sql) => {
      queries.push(sql);
      return okAsync({ rows: [row], rowCount: 1 });
    }, "orb");
    expect(result.isErr()).toBe(true);
    expect(queries[0]).toContain("FOR UPDATE");
  }
});
it("allows host-independent admission and rechecks abort after SQL", async () => {
  const abort = new AbortController();
  const guard = resourcePublicationGuard({ expectedAdmissionVersion: 3, signal: abort.signal });
  expect(
    (
      await guard(
        () =>
          okAsync({
            rows: [{ state: "stopped", stop_reason: "idle", agent_admission_version: "3" }],
            rowCount: 1,
          }),
        "orb",
      )
    ).isOk(),
  ).toBe(true);
  expect(
    (
      await guard(() => {
        abort.abort();
        return okAsync({
          rows: [{ state: "running", stop_reason: null, agent_admission_version: 3 }],
          rowCount: 1,
        });
      }, "orb")
    ).isErr(),
  ).toBe(true);
});
