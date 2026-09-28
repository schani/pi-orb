import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["scripts/mcp-stream-investigation/*.unit.test.ts"] },
});
