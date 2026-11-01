import { ok } from "neverthrow";
import { expect, it } from "vitest";
import type { OrbAgent } from "./orb-agent.ts";
import { RuntimePreviewService } from "./preview.ts";
import { PreviewActivity } from "./preview-activity.ts";

it("bounds HTTP and silent WS ownership, releases once, and intentional Stop closes admission", () => {
  const agent = {
    runtimeInstanceId: "runtime",
    previewActivity: new PreviewActivity(),
    getHealth: () => ({ status: "ready", executionId: "execution", incarnation: 0 }),
    gateView: () => ({ acceptingWork: true }),
  } as unknown as OrbAgent;
  const service = new RuntimePreviewService({
    agent,
    orbId: "orb",
    reservedPorts: () => [],
    verifier: {
      verify: () =>
        ok({
          v: 1,
          origin: "https://preview.example",
          expiresAt: 10000,
          target: {
            orbId: "orb",
            port: 3000,
            registrationId: "registration",
            executionId: "execution",
            incarnation: 0,
            runtimeInstanceId: "runtime",
          },
        }),
    },
  });
  const leases = Array.from({ length: 64 }, () =>
    service.admit("grant", 3000, "websocket")._unsafeUnwrap(),
  );
  expect(service.admit("grant", 3000, "http")._unsafeUnwrapErr().code).toBe("capacity_exceeded");
  leases[0]?.release();
  leases[0]?.release();
  const lease = service.admit("grant", 3000, "http")._unsafeUnwrap();
  let closes = 0;
  service.open(lease, {
    open: (owned) => () => {
      closes++;
      owned.release();
    },
  });
  service.closeAll();
  service.closeAll();
  expect(closes).toBe(1);
  expect(service.admit("grant", 3000, "http")._unsafeUnwrapErr().code).toBe("orb_unavailable");
  for (const owned of leases) owned.release();
});
