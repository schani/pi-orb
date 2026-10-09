import { pathToFileURL } from "node:url";
import { err, errAsync, okAsync, ResultAsync } from "neverthrow";
import { GitResourceSource } from "../../apps/control-plane/src/adapters/git-resources/git.ts";
import {
  type ResourceSource,
  resourceError,
} from "../../apps/control-plane/src/domain/resources.ts";

export function gatedResourceSource(source: ResourceSource, gateUrl?: string): ResourceSource {
  return {
    acquire: (input) => {
      if (input.signal.aborted)
        return errAsync(resourceError("cancelled", "Fixture resource gate cancelled"));
      const gate =
        gateUrl === undefined
          ? okAsync(undefined)
          : ResultAsync.fromPromise(
              fetch(`${gateUrl}?orbId=${encodeURIComponent(input.orbId)}`, {
                signal: input.signal,
              }).then(async (response) => {
                if (!response.ok) throw new Error("fixture resource gate rejected");
                await response.text();
              }),
              () =>
                resourceError(
                  input.signal.aborted ? "cancelled" : "fetch",
                  "Fixture resource gate failed",
                ),
            );
      const acquired = gate.andThen(() =>
        input.signal.aborted
          ? errAsync(resourceError("cancelled", "Fixture resource gate cancelled"))
          : source.acquire(input),
      );
      if (!gateUrl || new URL(gateUrl).searchParams.get("reportOutcome") !== "1") return acquired;
      // A test-only acknowledgement barrier; cancellation must not suppress it.
      return new ResultAsync(
        (async () => {
          const result = await acquired;
          const settled = new URL(gateUrl);
          settled.searchParams.set("phase", "settled");
          settled.searchParams.set("outcome", result.isOk() ? "ready" : result.error.code);
          const reported = await ResultAsync.fromPromise(
            fetch(settled).then(async (response) => {
              if (!response.ok) throw new Error("fixture settlement rejected");
              await response.text();
            }),
            () => resourceError("fetch", "Fixture settlement failed"),
          );
          return reported.isErr() ? err(reported.error) : result;
        })(),
      );
    },
  };
}

/** Normal Git URL rewriting in the test credential adapter; no production URL exceptions. */
export function localResourceSource(repository: string, gateUrl?: string): ResourceSource {
  const source = new GitResourceSource({
    environment: (url) =>
      okAsync({
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: `url.${pathToFileURL(repository).href}.insteadOf`,
        GIT_CONFIG_VALUE_0: url,
        GIT_CONFIG_KEY_1: "protocol.file.allow",
        GIT_CONFIG_VALUE_1: "always",
      }),
  });
  return gatedResourceSource(source, gateUrl);
}
