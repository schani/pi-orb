import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface Fixture {
  childGates: Map<string, { promise: Promise<void> }>;
  note(event: string): void;
}

// Test-only tool loaded by the real child ResourceLoader. The process-local
// fixture owns every gate; no sleep, network, shell command or private SDK API.
export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "probe_gate",
    label: "Probe gate",
    description: "Wait for the deterministic test driver.",
    parameters: Type.Object({ label: Type.String() }),
    async execute(_id, { label }, signal) {
      const fixture = (globalThis as unknown as Record<symbol, Fixture>)[
        Symbol.for("pi-orb:liveness-fixture")
      ];
      const gate = fixture.childGates.get(label);
      // A missing gate is a test-fixture assertion failure, not a recoverable tool error.
      assert.ok(gate, `Unknown test gate: ${label}`);
      fixture.note(`tool:${label}:entered`);
      const onAbort = () => fixture.note(`tool:${label}:abort-observed`);
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        await gate.promise;
        fixture.note(`tool:${label}:exited`);
        return { content: [{ type: "text" as const, text: "gate released" }], details: {} };
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    },
  });
}
