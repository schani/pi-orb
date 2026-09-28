import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Fixture = {
  failed: boolean;
  root: string;
  artifactDirectory: string;
  sessions: string[];
  mockOrigin: string;
  capture: () => Promise<unknown>;
  close: () => Promise<void>;
  removeProjects: () => Promise<void>;
  stop: () => Promise<void>;
  shutdownRemote?: () => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
};

export async function finishMcpFixture(fixture: Fixture): Promise<void> {
  const errors: Error[] = [];
  const attempt = async (label: string, action: () => Promise<void>) => {
    try {
      await action();
    } catch {
      const message = `MCP fixture ${label} failed`;
      console.error(message);
      errors.push(new Error(message));
    }
  };
  if (fixture.failed) {
    await attempt("diagnostics", async () => {
      const summary = await fixture.capture();
      mkdirSync(fixture.artifactDirectory, { recursive: true, mode: 0o700 });
      const path = join(fixture.artifactDirectory, `${randomUUID()}.json`);
      writeFileSync(path, JSON.stringify(summary, null, 2), { mode: 0o600 });
      console.error(`MCP failure summary: ${path}`);
    });
    let dashboard: string | undefined;
    try {
      dashboard = new URL(fixture.mockOrigin).origin;
    } catch {
      console.error("MCP fixture mock origin invalid");
    }
    for (const session of fixture.sessions) {
      if (/^sess_[a-zA-Z0-9]+$/.test(session))
        console.error(`MCP mock session (24h TTL): ${dashboard ?? "mock dashboard"}/ ${session}`);
    }
  }
  await attempt("browser close", fixture.close);
  await attempt("project cleanup", fixture.removeProjects);
  await attempt("control plane stop", fixture.stop);
  if (fixture.shutdownRemote) await attempt("remote stop", fixture.shutdownRemote);
  if (!fixture.failed)
    for (const session of fixture.sessions)
      await attempt("session deletion", () => fixture.deleteSession(session));
  try {
    rmSync(fixture.root, { recursive: true, force: true });
  } catch {
    const message = "MCP fixture temporary root cleanup failed";
    console.error(message);
    errors.push(new Error(message));
  }
  if (!fixture.failed && errors.length > 0)
    throw new AggregateError(errors, "MCP fixture cleanup failed");
}
