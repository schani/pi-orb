import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSubagentsService } from "@gotgenes/pi-subagents";

// The package's public entry point is TypeScript. Load it through Pi's normal
// extension loader (jiti), not Node's unsupported node_modules type stripping.
export default function (pi: ExtensionAPI) {
  pi.on("session_start", () => {
    const fixture = (
      globalThis as unknown as Record<symbol, { getService?: typeof getSubagentsService }>
    )[Symbol.for("pi-orb:liveness-fixture")];
    fixture.getService = getSubagentsService;
  });
}
