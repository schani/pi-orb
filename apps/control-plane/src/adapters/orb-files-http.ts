import { Readable } from "node:stream";
import { err, Result, ResultAsync } from "neverthrow";
import type { FileError, OrbFilesTransport } from "../domain/orb-files.ts";

const unavailable = (): FileError => ({ status: 503, message: "Orb file stream interrupted" });
export class NodeOrbFilesTransport implements OrbFilesTransport {
  open: OrbFilesTransport["open"] = (route, request, signal) =>
    ResultAsync.fromThrowable(
      () =>
        fetch(
          `${route.baseUrl}/v1/files?${new URLSearchParams({ path: request.path, ...(request.base ? { base: request.base } : {}) })}`,
          {
            method: request.method,
            headers: {
              authorization: `Bearer ${route.token}`,
              "x-orb-incarnation": String(route.incarnation),
            },
            signal,
            redirect: "error",
          },
        ),
      unavailable,
    )().andThen((response) => {
      if (signal.aborted) return err(unavailable());
      if (!response.ok) {
        void ResultAsync.fromThrowable(
          () => response.body?.cancel() ?? Promise.resolve(),
          unavailable,
        )();
        const status = response.status;
        return err<never, FileError>({
          status:
            status === 400 || status === 401 || status === 403 || status === 404 || status === 409
              ? status
              : 503,
          message:
            status === 404
              ? "File doesn't exist"
              : status === 403
                ? "File permission denied"
                : "Orb file unavailable",
        });
      }
      const length = Number(response.headers.get("content-length"));
      if (
        !response.headers.has("content-length") ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        (request.method === "GET" && !response.body)
      )
        return err(unavailable());
      return Result.fromThrowable(
        () => ({
          contentType: response.headers.get("content-type") ?? "application/octet-stream",
          length,
          body:
            response.body && request.method === "GET"
              ? Readable.fromWeb(response.body, { signal })
              : null,
        }),
        unavailable,
      )();
    });
}
