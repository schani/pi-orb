import { readdirSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("assigns each migration a unique sequence after shipped main migrations", () => {
  const files = readdirSync(new URL("./migrations/", import.meta.url)).filter((name) =>
    name.endsWith(".sql"),
  );
  const candidate = files.filter(
    (name) => !["029_history_record_shape.sql", "029_orb_harness.sql"].includes(name),
  );
  const sequences = candidate.map((name) => name.split("_")[0]);
  expect(new Set(sequences).size).toBe(candidate.length);
  expect(files).toContain("029_orb_harness.sql");
  expect(files).toContain("031_google_identities.sql");
  expect(files).toContain("032_orb_last_ready_at.sql");
  expect(files).toContain("034_manual_stop.sql");
  expect(files).toContain("039_resource_events.sql");
  expect(files).toContain("029_history_record_shape.sql");
  expect(files).toContain("030_activity_headlines.sql");
});

it("bounds 044 lock-only contention retries before DDL with edge telemetry", () => {
  const sql = readFileSync(
    new URL("./migrations/044_lossless_history_json.sql", import.meta.url),
    "utf8",
  );
  const [acquisition, ddl] = sql.split("END $$;");
  expect(acquisition).toContain("FOR attempt IN 1..120 LOOP");
  expect(acquisition).toContain("LOCK TABLE orbs, history_records IN ACCESS EXCLUSIVE MODE NOWAIT");
  expect(acquisition?.match(/EXCEPTION WHEN (\w+)/gu)).toEqual([
    "EXCEPTION WHEN lock_not_available",
  ]);
  expect(acquisition).toContain("IF attempt = 120 THEN");
  expect(acquisition).toContain("RAISE;");
  expect(acquisition).toMatch(/END;\s+PERFORM pg_sleep\(0\.25\);/u);
  expect(acquisition).not.toContain("ALTER TABLE");
  expect(ddl).toContain("ALTER TABLE history_records");
  expect(ddl).toContain("ALTER TABLE orbs");
  expect(acquisition).toMatch(
    /IF attempt = 1 THEN\s+RAISE LOG 'lifecycle: migration-lock-contended/u,
  );
  expect(acquisition).toMatch(
    /IF attempt > 1 THEN\s+RAISE LOG 'lifecycle: migration-lock-acquired/u,
  );
  expect(acquisition).toContain("migration-lock-exhausted");
  expect(acquisition).toContain("attempts=120 sqlstate=55P03");
});
