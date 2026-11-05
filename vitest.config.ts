import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: "e2e/testkit/repository-fixture-setup.ts",
    include: [
      "packages/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.{ts,tsx}",
      // Harness helpers that are pure logic; `*.e2e.test.ts` stays out.
      "e2e/**/*.unit.test.ts",
    ],
    testTimeout: 30_000,
    maxWorkers: "50%",
  },
});
