import { describe, expect, it } from "vitest";
import { DeterministicGceApiModel } from "./gce-model.ts";

// Name reservation is a cloud invariant, independent of the provider's timing.
describe("GCE model insert acceptance", () => {
  for (const collection of ["instances", "disks"] as const) {
    it(`reserves ${collection} before operation completion and retains the winning body`, async () => {
      const model = new DeterministicGceApiModel({ operationWaitPolls: 2 });
      const signal = new AbortController().signal;
      const path = `projects/p/zones/z/${collection}`;
      const first = await model.request({
        method: "POST",
        path,
        body: { name: "orb", marker: "winner" },
        signal,
      });
      expect(first.status).toBe(200);
      expect(model.pendingOperationCount()).toBe(1);
      const loser = await model.request({
        method: "POST",
        path,
        body: { name: "orb", marker: "loser" },
        signal,
      });
      expect(loser.status).toBe(409);
      expect(
        (await model.request({ method: "GET", path: `${path}/orb`, signal })).body["marker"],
      ).toBe("winner");
      model.completeAllOperations();
      expect(model.pendingOperationCount()).toBe(0);
      expect(
        (await model.request({ method: "GET", path: `${path}/orb`, signal })).body,
      ).toMatchObject({
        marker: "winner",
        status: collection === "instances" ? "RUNNING" : "READY",
      });
    });
  }
});
