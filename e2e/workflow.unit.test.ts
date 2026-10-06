import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const workflow = readFileSync(new URL("../.github/workflows/e2e.yml", import.meta.url), "utf8");

it("reserves setup and serial-suite headroom in the E2E job budget", () => {
  expect(workflow).toMatch(/^ {4}timeout-minutes: 60$/m);
});

it("stops after the first failure so Vitest reports it before job cancellation", () => {
  expect(workflow).toMatch(
    /- name: Run end-to-end test\n\s+if: env.LIFECYCLE_DIAGNOSTIC != 'true'\n\s+run: npm run test:e2e -- --bail 1\n/,
  );
});
