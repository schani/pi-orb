import { registerIndependentCase } from "./durable-independent-fixture.ts";

for (const cancellation of ["abort", "stop", "host-failure", "ready", "git-stop"] as const) {
  registerIndependentCase(cancellation);
}
