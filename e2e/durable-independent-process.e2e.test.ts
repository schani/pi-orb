import { registerIndependentCase } from "./durable-independent-fixture.ts";

for (const cancellation of [
  "abort",
  "stop",
  "host-failure",
  "ready",
  "git-stop",
  "hook-policy",
] as const) {
  registerIndependentCase(cancellation);
}
