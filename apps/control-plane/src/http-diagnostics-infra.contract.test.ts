import { readFileSync } from "node:fs";
import { ok } from "neverthrow";
import { expect, it } from "vitest";
import { HttpDiagnostics } from "./adapters/http-diagnostics.ts";
import { RuntimeDiagnostics } from "./adapters/runtime-diagnostics.ts";

it("exports every numeric HTTP sample field as a revision-scoped Monitoring distribution", () => {
  const source = readFileSync("infra/http-diagnostics.tf", "utf8");
  let sample: Record<string, unknown> = {};
  let now = 0;
  let tick = () => {};
  const runtime = new RuntimeDiagnostics({
    now: () => now,
    readCpu: () => ok({ processMicros: now * 100, mainThreadMicros: now * 50 }),
    readLoop: () => ({ active: now / 2, idle: now / 2 }),
    createDelay: () => ({
      read: () => ({ p99Ms: 100, maxMs: 120 }),
      reset: () => {},
      stop: () => {},
    }),
    schedule: (callback) => {
      tick = callback;
      return () => {};
    },
    observeGc: () => () => {},
  });
  using diagnostics = new HttpDiagnostics({
    createRuntime: () => runtime,
    emit: (value) => {
      sample = value;
    },
    schedule: () => () => {},
  });
  now = 1_000;
  tick();
  diagnostics.sample();
  for (const [field, value] of Object.entries(sample)) {
    if (typeof value !== "number" || field === "pid") continue;
    expect(source, field).toMatch(new RegExp(`\\b${field}\\s*=`));
  }
  expect(source).toContain('resource.type="cloud_run_revision"');
  expect(source).toContain(
    `resource.labels.service_name="\${google_cloud_run_v2_service.issuer.name}"`,
  );
  expect(source).toContain('jsonPayload.message="control-plane.http"');
  expect(source).toContain(`jsonPayload.\${each.key}>=0`);
  expect(source).toContain(`value_extractor = "EXTRACT(jsonPayload.\${each.key})"`);
  expect(source).toMatch(/metric_kind\s*=\s*"DELTA"/u);
  expect(source).toMatch(/value_type\s*=\s*"DISTRIBUTION"/u);
});
