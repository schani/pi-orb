import { closeSync, fsyncSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { err, Result } from "neverthrow";

/** Opening an exclusively reserved empty file makes the public SDK initialize and own an eager session. */
const failure = () => ({
  type: "settings_error" as const,
  message: "Cannot initialize persistent session",
});
export function createPersistentSession(cwd: string, sessionDir: string) {
  return Result.fromThrowable(() => SessionManager.create(cwd, sessionDir), failure)().andThen(
    (manager) => {
      const file = manager.getSessionFile();
      if (!file) return err(failure());
      return Result.fromThrowable(() => {
        closeSync(openSync(file, "wx", 0o600));
        manager.setSessionFile(file);
        return manager;
      }, failure)();
    },
  );
}

/** SDK owns serialization/appending; this boundary only synchronizes its completed writes. */
export const syncSessionFile = Result.fromThrowable(
  (file: string): void => {
    for (const path of [file, dirname(file)]) {
      const fd = openSync(path, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
  },
  () => ({ type: "settings_error" as const, message: "Cannot persist agent settings" }),
);
