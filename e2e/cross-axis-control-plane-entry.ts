import { okAsync, ResultAsync } from "neverthrow";
import { GitResourceSource } from "../apps/control-plane/src/adapters/git-resources/git.ts";
import { resourceError } from "../apps/control-plane/src/domain/resources.ts";
import { main } from "../apps/control-plane/src/main.ts";
import { afterAcquireGate, localGitEnvironment } from "./testkit/cross-axis.ts";

const repository = process.env["PI_ORB_E2E_RESOURCE_REPOSITORY"];
const gate = process.env["PI_ORB_E2E_RESOLVED_GATE"];
if (repository && !gate) throw new Error("cross-axis resolved gate required for local repository");
const source = new GitResourceSource({
  environment: (url) => okAsync(repository ? localGitEnvironment(repository, url) : {}),
});
void main({
  resourceSource: gate
    ? afterAcquireGate(source, (snapshot, signal) =>
        ResultAsync.fromPromise(
          fetch(`${gate}?commitSha=${snapshot.commitSha}`, { signal }).then(async (response) => {
            if (!response.ok) throw new Error("resolved gate rejected");
            await response.text();
          }),
          () =>
            resourceError(signal.aborted ? "cancelled" : "fetch", "Resolved fixture gate failed"),
        ),
      )
    : source,
});
