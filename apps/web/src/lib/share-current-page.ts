import { err, ok, type Result } from "neverthrow";
import { type CopyError, copyToClipboard } from "./copy-to-clipboard.ts";

export type ShareError = { type: "share_failed" } | CopyError;
export type ShareOutcome = "shared" | "copied" | "cancelled";

export function canShareCurrentPage(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.share === "function";
}

/** Call in the click stack: native sharing requires transient user activation. */
export async function shareCurrentPage(): Promise<Result<ShareOutcome, ShareError>> {
  const url = window.location.href;
  if (!canShareCurrentPage()) {
    const result = await copyToClipboard(url);
    return result.map(() => "copied");
  }

  try {
    await navigator.share({ url, title: document.title });
    return ok("shared");
  } catch (error) {
    return error instanceof DOMException && error.name === "AbortError"
      ? ok("cancelled")
      : err({ type: "share_failed" });
  }
}
