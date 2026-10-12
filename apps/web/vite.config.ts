import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { mockBackendPlugin } from "./dev/mock-backend.ts";

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    ...(mode === "frontend"
      ? [
          mockBackendPlugin({
            timestampChurn: process.env["PI_ORB_FIXTURE_TIMESTAMP_CHURN"] === "1",
          }),
        ]
      : []),
  ],
  server: {
    host: true,
    allowedHosts: ["vibestation"],
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
