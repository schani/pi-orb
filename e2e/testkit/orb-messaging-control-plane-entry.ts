import { ResultAsync } from "neverthrow";
import { PostgreSQLControlPlaneStore } from "../../apps/control-plane/src/adapters/pg/store.ts";
import { ProcessOrbHostProvider } from "../../apps/control-plane/src/adapters/process/provider.ts";
import { main } from "../../apps/control-plane/src/main.ts";
import { localResourceSource } from "./resource-source-fixture.ts";

const repository = process.env["PI_ORB_E2E_RESOURCE_REPOSITORY"];
const gateUrl = process.env["PI_ORB_E2E_MESSAGE_DELIVERY_GATE"];
const receiverId = process.env["PI_ORB_E2E_MESSAGE_RECEIVER"];
if (!repository || !gateUrl || !receiverId)
  throw new Error("Messaging fixture environment required");

const waitForSender = () =>
  ResultAsync.fromPromise(
    fetch(gateUrl).then(async (response) => {
      if (!response.ok) throw new Error("Receiver delivery gate rejected");
      await response.text();
    }),
    () => ({
      code: "unavailable" as const,
      message: "Receiver delivery gate failed",
      retryable: false,
    }),
  );

if (process.env["PI_ORB_AGENT_BACKEND"] === "host-pi") {
  // Native boot can infer before inbox admission.
  const start = ProcessOrbHostProvider.prototype.start;
  ProcessOrbHostProvider.prototype.start = function (task, request, context) {
    if (request.ref.resourceId !== `${receiverId}-i${request.expectedIncarnation}`)
      return start.call(this, task, request, context);
    return waitForSender()
      .mapErr((error) => ({
        ...error,
        type: "orb_host_provider_error" as const,
        provider: "process" as const,
        operation: "start" as const,
      }))
      .andThen(() => start.call(this, task, request, context));
  };
} else {
  // Central text inference does not require a running execution host.
  const claim = PostgreSQLControlPlaneStore.prototype.claimNextOrbMessageBatch;
  PostgreSQLControlPlaneStore.prototype.claimNextOrbMessageBatch = function (task, params) {
    if (params.orbId !== receiverId) return claim.call(this, task, params);
    return waitForSender()
      .mapErr((error) => ({ ...error, type: "store_error" as const }))
      .andThen(() => claim.call(this, task, params));
  };
}
void main({ resourceSource: localResourceSource(repository) });
