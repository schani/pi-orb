import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    // Reachable over the tailnet (a private, trusted network — the
    // unauthenticated first slice must never be exposed publicly).
    host: true,
    allowedHosts: ["vibestation", ".ts.net"],
    proxy: {
      "/api": {
        target: "http://127.0.0.1:7100",
        // WebSocket upgrade for /api/v1/orbs/:id/live.
        ws: true,
      },
    },
  },
});
