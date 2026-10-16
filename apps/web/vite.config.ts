import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { mockBackendPlugin } from "./dev/mock-backend.ts";

export default defineConfig(({ mode }) => ({
  build: { target: ["chrome107", "edge107", "firefox104", "safari16"] },
  plugins: [
    react(),
    ...(mode === "frontend"
      ? [
          mockBackendPlugin({
            timestampChurn: process.env["PI_ORB_FIXTURE_TIMESTAMP_CHURN"] === "1",
            orbNesting: process.env["PI_ORB_FIXTURE_ORB_NESTING"] === "1",
          }),
        ]
      : []),
  ],
  server: {
    // Binds all interfaces for tailnet access. The dev server is unauthenticated:
    // never expose it publicly.
    host: true,
    allowedHosts: ["vibestation", ".ts.net"],
    proxy:
      mode === "frontend"
        ? {}
        : {
            "/api": {
              target: "http://127.0.0.1:7100",
              // WebSocket upgrade for /api/v1/orbs/:id/live.
              ws: true,
            },
          },
  },
}));
