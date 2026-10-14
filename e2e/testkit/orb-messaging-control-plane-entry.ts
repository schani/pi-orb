import { ResultAsync } from "neverthrow";
import { PostgreSQLControlPlaneStore } from "../../apps/control-plane/src/adapters/pg/store.ts";
import { main } from "../../apps/control-plane/src/main.ts";
import { localResourceSource } from "./resource-source-fixture.ts";

const repository = process.env["PI_ORB_E2E_RESOURCE_REPOSITORY"];
const gateUrl = process.env["PI_ORB_E2E_MESSAGE_CLAIM_GATE"];
const receiverId = process.env["PI_ORB_E2E_MESSAGE_RECEIVER"];
if (!repository || !gateUrl || !receiverId) throw new Error("Messaging fixture environment required");

/** Gate the shared real FIFO claim before native admission, independently of execution readiness. */
const claim = PostgreSQLControlPlaneStore.prototype.claimNextOrbMessageBatch;
PostgreSQLControlPlaneStore.prototype.claimNextOrbMessageBatch = function (...args) {
  if (args[1] !== receiverId) return claim.apply(this, args);
  return ResultAsync.fromPromise(
    fetch(gateUrl).then(async (response) => {
      if (!response.ok) throw new Error("Message claim gate rejected");
      await response.text();
    }),
    () => ({ type: "store_error" as const, code: "unavailable" as const, message: "Message claim gate failed", retryable: false }),
  ).andThen(() => claim.apply(this, args));
};
void main({ resourceSource: localResourceSource(repository) });
