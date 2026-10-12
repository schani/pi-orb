import { err, ok, type Result } from "neverthrow";
export const PREVIEW_USAGE = "usage: pi-orb expose <port> | unexpose <port> | previews [--json]";
export type PreviewCommand =
  | { type: "expose" | "unexpose"; port: number }
  | { type: "previews"; json: boolean };
export function parsePreviewArgs(args: readonly string[]): Result<PreviewCommand, string> {
  if (args[0] === "previews" && (args.length === 1 || (args.length === 2 && args[1] === "--json")))
    return ok({ type: "previews", json: args.length === 2 });
  if (
    (args[0] === "expose" || args[0] === "unexpose") &&
    args.length === 2 &&
    /^[1-9][0-9]{0,4}$/.test(args[1] ?? "")
  ) {
    const port = Number(args[1]);
    if (port <= 65535) return ok({ type: args[0], port });
  }
  return err(PREVIEW_USAGE);
}
