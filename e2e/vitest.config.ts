import { defineConfig } from "vitest/config";

const frontendFiles = [
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
    poolOptions: { forks: { minForks: 1, maxForks: 1 } },
    projects: [
      {
        test: {
          ...shared,
          name: "frontend",
          include: frontendFiles,
          pool: "threads",
          poolOptions: { threads: { singleThread: true } },
          sequence: { groupOrder: 0 },
        },
      },
      {
        test: {
          ...shared,
          name: "lifecycle",
          include: ["e2e/**/*.e2e.test.ts"],
          globalSetup: ["e2e/global-setup.ts"],
          exclude: frontendFiles,
          pool: "forks",
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
