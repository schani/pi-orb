import { docker } from "./harness.ts";

export const POSTGRES_IMAGE = "pi-orb-postgres-test:17.11-textsearch1.3.1";

export async function ensurePostgresImage(): Promise<void> {
  await docker(
    ["build", "-f", "infra/postgres-test/Dockerfile", "-t", POSTGRES_IMAGE, "."],
    600_000,
  );
}
