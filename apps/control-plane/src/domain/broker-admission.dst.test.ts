import type { SimulationTask } from "determined";
import { ok } from "neverthrow";
import { describe, expect, it } from "vitest";
import {
  FakePointerStore,
  FakeSecretStore,
  FakeUpstream,
  makeCredential,
} from "../testkit/broker.ts";
import { runDst } from "../testkit/sim.ts";
import { getToken } from "./broker.ts";
import { DEFAULT_BROKER_CONSTANTS } from "./constants.ts";
import type { StoredCredential, StoredSecret } from "./ports.ts";

const provider = "openai-codex";
describe("broker request admission DST", () => {
  it.each(["pointer", "secret", "lease", "rotation"] as const)(
    "stops caller admission after %s without losing issued rotation",
    async (phase) => {
      for (const mode of ["cancel", "expiry"] as const) {
        await runDst(
          { name: `broker-admission-${phase}-${mode}`, iterations: 20, lateTimerProbability: 0 },
          async (sim) => {
            const pointers = new FakePointerStore();
            const secrets = new FakeSecretStore();
            const upstream = new FakeUpstream("unseeded");
            const outcomes = await sim.runTasks([
              {
                name: "request",
                f: async (task) => {
                  const controller = new AbortController();
                  let offset = 0;
                  const logs: string[] = [];
                  const delayed = new Proxy(task, {
                    get(target, key) {
                      if (key === "log") return (...parts: unknown[]) => logs.push(parts.join(" "));
                      if (key === "monotonicNow") return () => target.monotonicNow() + offset;
                      const value = Reflect.get(target, key);
                      return typeof value === "function" ? value.bind(target) : value;
                    },
                  });
                  const credential = makeCredential(task, {
                    expiresInMs: phase === "secret" ? 3_600_000 : 1,
                  });
                  const version = secrets.seedSecret(provider, credential);
                  pointers.seedRow({
                    provider,
                    rowVersion: 1,
                    generation: 1,
                    secretVersion: version,
                    refreshLeaseUntil: 0,
                    lastRefreshAt: 0,
                  });
                  upstream.adoptLogin(credential);
                  const stop = () => {
                    if (mode === "cancel") controller.abort();
                    else offset = 30_001;
                  };
                  const readPointer = pointers.readPointer.bind(pointers);
                  pointers.readPointer = (...args) =>
                    readPointer(...args).map((value) => {
                      if (phase === "pointer") stop();
                      return value;
                    });
                  let secretReads = 0;
                  const readSecret = secrets.readSecret.bind(secrets);
                  secrets.readSecret = <T extends StoredSecret = StoredCredential>(
                    task: SimulationTask,
                    provider: string,
                    version: string,
                  ) => {
                    secretReads++;
                    return readSecret<T>(task, provider, version).map((value) => {
                      if (phase === "secret") stop();
                      return value;
                    });
                  };
                  const cas = pointers.casWritePointer.bind(pointers);
                  pointers.casWritePointer = (...args) =>
                    cas(...args).map((value) => {
                      if (phase === "lease" && value.refreshLeaseUntil !== 0) stop();
                      return value;
                    });
                  const refresh = upstream.refresh.bind(upstream);
                  upstream.refresh = (...args) =>
                    refresh(...args).map((value) => {
                      if (phase === "rotation") stop();
                      return value;
                    });
                  const context = {
                    signal: controller.signal,
                    deadlineAt: delayed.monotonicNow() + 30_000,
                  };
                  const result = await getToken(
                    delayed,
                    {
                      pointers,
                      secrets,
                      upstreams: { [provider]: upstream },
                      constants: DEFAULT_BROKER_CONSTANTS,
                    },
                    provider,
                    { reason: "startup" },
                    context,
                  );
                  expect(result.isErr()).toBe(true);
                  expect(upstream.calls).toBe(phase === "rotation" ? 1 : 0);
                  expect(secretReads).toBe(phase === "pointer" ? 0 : 1);
                  const pointer = pointers.snapshot(provider);
                  if (phase === "rotation") {
                    expect(pointer?.generation).toBe(2);
                    expect(pointer?.secretVersion).not.toBe(version);
                    expect(secrets.destroyedVersions()).toContain(`${provider}/${version}`);
                    expect(
                      logs.filter((line) => line.includes("credential.rotation_settled")),
                    ).toHaveLength(1);
                    expect(logs.join("\n")).not.toContain(credential.refresh);
                  } else {
                    expect(pointer?.generation).toBe(1);
                    expect(logs).toHaveLength(0);
                  }
                  expect(pointer?.refreshLeaseUntil).toBe(0);
                  return ok(undefined);
                },
              },
            ]);
            expect(outcomes.isOk(), outcomes.isErr() ? outcomes.error.message : "").toBe(true);
          },
        );
      }
    },
  );
});
