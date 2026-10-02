import { Result } from "neverthrow";

export type ImageObjectUrlError =
  | { type: "object_url_create_failed" }
  | { type: "object_url_revoke_failed" };

export function createImageObjectUrl(blob: Blob): Result<string, ImageObjectUrlError> {
  return Result.fromThrowable(
    () => URL.createObjectURL(blob),
    (): ImageObjectUrlError => ({ type: "object_url_create_failed" }),
  )();
}

export function revokeImageObjectUrl(url: string): Result<void, ImageObjectUrlError> {
  return Result.fromThrowable(
    () => URL.revokeObjectURL(url),
    (): ImageObjectUrlError => ({ type: "object_url_revoke_failed" }),
  )();
}
