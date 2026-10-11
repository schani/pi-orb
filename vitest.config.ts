import { defineConfig } from "vitest/config";

// Real-fsync DST runs alone after the parallel suite; contention exceeded its timeout.
const exclusive = ["apps/control-plane/src/domain/claude-composed-lifecycle.dst.test.ts"];

export default defineConfig({
  test: {
    testTimeout: 30_000,
    maxWorkers: "50%",
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: [
            "packages/*/src/**/*.test.ts",
            "apps/*/src/**/*.test.{ts,tsx}",
            // Harness helpers that are pure logic; `*.e2e.test.ts` stays out.
            "e2e/**/*.unit.test.ts",
          ],
          exclude: exclusive,
        },
      },
      {
        extends: true,
        test: { name: "exclusive", include: exclusive, sequence: { groupOrder: 1 } },
      },
    ],
  },
});
