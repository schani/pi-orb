import type { SimulationTask } from "determined";
import { describe, expect, it } from "vitest";
import { logOrbEvent } from "../../domain/log.ts";
import { DeterministicGceApiModel } from "../../testkit/gce-model.ts";
import { LogCapture, runDst, waitUntil } from "../../testkit/sim.ts";
import { DeterministicTailscaleApiModel } from "../../testkit/tailscale-model.ts";
import { HttpTailscaleAuthKeyMinter } from "../tailscale/client.ts";
import type { GceApiTransport } from "./api.ts";
import { GceOrbHostProvider } from "./provider.ts";

const ORB = "enrollment-race";
const NAME = `pi-orb-${ORB}-i0`;
const instancePath = `projects/proj/zones/zone/instances/${NAME}`;
const context = () => ({ signal: new AbortController().signal });

function provider(gce: GceApiTransport, minter: HttpTailscaleAuthKeyMinter): GceOrbHostProvider {
  return new GceOrbHostProvider(gce, {
    projectId: "proj",
    zone: "zone",
    machineType: "n2d-highmem-4",
    subnetwork: "regions/region/subnetworks/orbs",
    serviceAccount: "orb@proj.iam.gserviceaccount.com",
    runtimeImage: "registry.example/runtime@sha256:abc",
    controlPlaneUrl: "https://runtime.example",
    tailscale: { minter, tailnetDnsName: "tail.test" },
  });
}

describe("GCE + Tailscale enrollment (DST)", () => {
  for (const ordering of ["forced-losing-mint", "entropy"] as const) {
    it(`winning VM can enroll after competing provisioners: ${ordering}`, async () => {
      const logs = new LogCapture();
      await runDst(
        { name: `gce-enrollment-${ordering}`, iterations: 50, logCapture: logs },
        async (sim) => {
          const gce = new DeterministicGceApiModel({ operationWaitPolls: 1 });
          gce.seedDisk(`pi-orb-data-${ORB}`, { "pi-orb-orb-id": ORB });
          const tailnet = new DeterministicTailscaleApiModel();
          const events: string[] = [];
          const absent = new Set<number>();
          let winnerFinished = false;
          const worker = async (task: SimulationTask, index: number): Promise<void> => {
            // Independent client instances share only the modeled remote services.
            const transport: GceApiTransport = {
              request: async (args) => {
                await task.checkpoint("gce request", index, args.method, args.path);
                const result = await gce.request(args);
                events.push(`${index} ${args.method} ${args.path} -> ${result.status}`);
                if (args.method === "GET" && args.path === instancePath && result.status === 404) {
                  absent.add(index);
                  if (ordering === "forced-losing-mint") {
                    await waitUntil(
                      task,
                      "both provisioners saw absence",
                      () => absent.size === 2,
                      { intervalMs: 1 },
                    );
                    if (index === 1)
                      await waitUntil(
                        task,
                        "winner committed before losing mint",
                        () => winnerFinished,
                        { intervalMs: 1 },
                      );
                  }
                }
                return result;
              },
            };
            const minter = new HttpTailscaleAuthKeyMinter(
              {
                request: async (args) => {
                  await task.checkpoint(
                    "tailscale request",
                    index,
                    args.method ?? "POST",
                    new URL(args.url).pathname,
                  );
                  return tailnet.request(args);
                },
              },
              {
                clientId: "model",
                clientSecret: "model",
                baseUrl: "https://tailscale.test",
                onKeyEvent: ({ orbId, action, incarnation, keyId }) => {
                  logOrbEvent(task, orbId, `tailscale-key-${action}`, {
                    incarnation,
                    key_id: keyId,
                  });
                },
              },
            );
            const host = provider(transport, minter);
            const request = {
              orbId: ORB,
              incarnation: 0,
              bootstrap: { repositoryUrl: "https://github.com/o/r" },
            };
            let result = await host.provision(task, request, context());
            // A conflict read-back may precede completion of the winner's operation.
            if (result.isErr() && result.error.retryable) {
              await waitUntil(
                task,
                "winner operation completed",
                () => gce.pendingOperationCount() === 0,
                { intervalMs: 1 },
              );
              result = await host.provision(task, request, context());
            }
            expect(result.isOk(), JSON.stringify(result)).toBe(true);
            if (index === 0) winnerFinished = true;
          };
          const result = await sim.runTasks([
            { name: "provisioner-a", f: (task) => worker(task, 0) },
            { name: "provisioner-b", f: (task) => worker(task, 1) },
          ]);
          expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
          const vm = await gce.request({ method: "GET", path: instancePath, ...context() });
          const metadata = vm.body["metadata"] as { items: Array<{ key: string; value: string }> };
          const key = metadata.items.find(
            (item) => item.key === "pi-orb-tailscale-auth-key",
          )?.value;
          expect(key).toBeDefined();
          const enrolled = tailnet.enroll(`pi-orb-${ORB}`, key ?? "");
          expect(
            enrolled.isOk(),
            JSON.stringify({ events, tailnet: tailnet.events }, null, 2),
          ).toBe(true);
          if (enrolled.isErr()) return;
          expect(tailnet.enroll(`pi-orb-${ORB}`, key ?? "").isErr()).toBe(true);
          expect(tailnet.resume(enrolled.value).isOk()).toBe(true);
          expect(logs.lines().join("\n")).not.toContain("model-secret-");
          if (ordering === "forced-losing-mint") {
            expect(
              events.some((event) =>
                event.includes("POST projects/proj/zones/zone/instances -> 409"),
              ),
            ).toBe(true);
            expect(logs.matching("tailscale-key-preserved")).toHaveLength(1);
          }
          // Surplus attempt keys are consciously retained, never used to enroll
          // another device. Deletion-grade cleanup still revokes all of them.
          const cleaner = new HttpTailscaleAuthKeyMinter(tailnet, {
            clientId: "model",
            clientSecret: "model",
          });
          expect((await cleaner.cleanupOrb(ORB, context().signal)).isOk()).toBe(true);
          expect(tailnet.keyDescriptions()).toEqual([]);
          expect(tailnet.resume(enrolled.value).isErr()).toBe(true);
        },
      );
    });
  }
});
