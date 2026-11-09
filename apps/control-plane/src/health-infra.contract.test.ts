import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("control-plane liveness deployment contract", () => {
  it("restarts an unresponsive HTTP server after consecutive probe failures", () => {
    const run = readFileSync(resolve("infra/run.tf"), "utf8");

    expect(run).toMatch(
      /liveness_probe\s*\{\s*failure_threshold\s*=\s*3\s*period_seconds\s*=\s*10\s*timeout_seconds\s*=\s*2\s*http_get\s*\{\s*path\s*=\s*"\/health"\s*port\s*=\s*8080\s*http_headers\s*\{\s*name\s*=\s*"Host"\s*value\s*=\s*trimprefix\(local.app_origin, "https:\/\/"\)\s*\}\s*\}\s*\}/u,
    );
  });
});
