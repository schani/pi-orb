import { err, ok, type Result } from "neverthrow";

/** Applied only to the fresh temporary clone, never a retained workspace. */
export function initialCheckoutCommands(
  commit: string | undefined,
): Result<string[][], { type: "invalid_initial_commit"; message: string }> {
  if (!commit) return ok([]);
  if (!/^[a-f0-9]{40}$/.test(commit))
    return err({
      type: "invalid_initial_commit",
      message: "initial checkout commit must be a full Git SHA",
    });
  return ok([
    ["fetch", "origin", commit],
    ["checkout", "-B", "main", commit],
  ]);
}
