import { ORB_SELF_ARCHIVE_PATH, OrbArchiveResponseSchema } from "@pi-orb/protocol";
import { cleanupCommand } from "../cleanup/command.ts";

export const {
  usage: ARCHIVE_USAGE,
  parse: parseArchiveArgs,
  request: requestArchive,
  run: runArchiveCli,
} = cleanupCommand("archive", ORB_SELF_ARCHIVE_PATH, OrbArchiveResponseSchema);
