import { ORB_SELF_DELETE_PATH, OrbDeleteResponseSchema } from "@pi-orb/protocol";
import { cleanupCommand } from "../cleanup/command.ts";

export const {
  usage: DELETE_USAGE,
  parse: parseDeleteArgs,
  request: requestDelete,
  run: runDeleteCli,
} = cleanupCommand("delete", ORB_SELF_DELETE_PATH, OrbDeleteResponseSchema);
