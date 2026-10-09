import { main } from "../apps/control-plane/src/main.ts";
import { localResourceSource } from "./testkit/resource-source-fixture.ts";

const repository = process.env["PI_ORB_E2E_RESOURCE_REPOSITORY"];
if (!repository) throw new Error("resource fixture repository required");
void main({
  resourceSource: localResourceSource(repository, process.env["PI_ORB_E2E_RESOURCE_GATE_URL"]),
});
