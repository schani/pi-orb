// Test composition: stock control plane with a fixed host and driver-owned uptime.
import { registerHooks } from "node:module";
import { DEFAULT_LIFECYCLE_CONSTANTS } from "../../apps/control-plane/src/domain/constants.ts";

Object.assign(DEFAULT_LIFECYCLE_CONSTANTS, { idleStopAfterMs: Number.POSITIVE_INFINITY });

const productionProvider = new URL(
  "../../apps/control-plane/src/adapters/docker/provider.ts",
  import.meta.url,
).href;
const fixtureProvider = new URL("./fixed-host.ts", import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    return resolved.url === productionProvider ? { ...resolved, url: fixtureProvider } : resolved;
  },
});
await import("../../apps/control-plane/src/main.ts");
