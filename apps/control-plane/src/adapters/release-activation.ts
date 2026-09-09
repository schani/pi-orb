import { err, ok, ResultAsync } from "neverthrow";
import type {
  ReleaseActivationError,
  ReleaseActivationReader,
} from "../domain/release-activation.ts";
import type { GcsTokenProvider } from "./hosting/gcs.ts";

const unavailable = (): ReleaseActivationError => ({ type: "release_activation_unavailable" });

export function createReleaseActivationReader(
  bucket: string,
  auth: GcsTokenProvider,
  request: typeof fetch = fetch,
): ReleaseActivationReader {
  const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent("static-plane/releases/active.json")}?alt=media`;
  return {
    async read(task, stop) {
      await task.checkpoint("read release activation");
      const read = ResultAsync.fromThrowable(async () => {
        const token = await auth.getAccessToken();
        if (token === null) return err(unavailable());
        const response = await request(url, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.any([stop, AbortSignal.timeout(10_000)]),
          redirect: "error",
        });
        if (response.status === 404) return ok(null);
        if (!response.ok) return err(unavailable());
        const body: unknown = await response.json();
        if (
          typeof body !== "object" ||
          body === null ||
          !("generation" in body) ||
          typeof body.generation !== "number" ||
          !Number.isSafeInteger(body.generation) ||
          body.generation <= 0
        ) {
          return err(unavailable());
        }
        return ok(body.generation);
      }, unavailable);
      return (await read()).andThen((result) => result);
    },
  };
}
