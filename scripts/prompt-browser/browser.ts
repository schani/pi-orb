import { existsSync } from "node:fs";

export function chromiumExecutable(
  configured: string | undefined,
  available: (path: string) => boolean = existsSync,
): string | undefined {
  return configured ?? (available("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
}
