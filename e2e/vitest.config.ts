import { defineConfig } from "vitest/config";

const frontendFiles = [
  "e2e/application-auth.e2e.test.ts",
  "e2e/activity-headlines-lifecycle.e2e.test.ts",
  "e2e/fake-approval.e2e.test.ts",
  "e2e/harness-startup.e2e.test.ts",
  "e2e/*-frontend.e2e.test.ts",
  "e2e/frontend-*.e2e.test.ts",
  "e2e/transcript-cache-*.e2e.test.ts",
  "e2e/hosting-security.e2e.test.ts",
];

const shared = {
  testTimeout: 720_000,
  hookTimeout: 720_000,
} as const;

export default defineConfig({
  test: {
    maxWorkers: 1,
    projects: [
      {
        test: {
          ...shared,
          name: "frontend",
          include: frontendFiles,
          pool: "threads",
          maxWorkers: 1,
          sequence: { groupOrder: 1 },
        },
      },
      {
        test: {
          ...shared,
          name: "process",
          include: [
            "e2e/durable-independent-process.e2e.test.ts",
            "e2e/durable-process.e2e.test.ts",
            "e2e/durable-resource-followup.e2e.test.ts",
            "e2e/durable-resource-warnings.e2e.test.ts",
            "e2e/full-main-auth.e2e.test.ts",
            "e2e/idle-stop-view.e2e.test.ts",
            "e2e/mcp-oauth.e2e.test.ts",
            "e2e/multi-user-credentials.e2e.test.ts",
            "e2e/orb-alerts.e2e.test.ts",
            "e2e/orb-sleep.e2e.test.ts",
          ],
          pool: "forks",
          maxWorkers: 1,
          sequence: { groupOrder: 2 },
        },
      },
      {
        test: {
          ...shared,
          name: "provider",
          include: ["e2e/full-slice.e2e.test.ts", "e2e/cross-axis.e2e.test.ts"],
          globalSetup: ["e2e/global-setup.ts"],
          pool: "forks",
          maxWorkers: 1,
          sequence: { groupOrder: 3 },
        },
      },
      {
        test: {
          ...shared,
          name: "postgres",
          include: ["e2e/postgres-store.e2e.test.ts"],
          pool: "forks",
          maxWorkers: 1,
          sequence: { groupOrder: 4 },
        },
      },
    ],
  },
});
