import { readdirSync } from "node:fs";
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
  expect(files).toContain("032_manual_stop.sql");
  expect(files).toContain("037_resource_events.sql");
  expect(files).toContain("029_history_record_shape.sql");
  expect(files).toContain("030_activity_headlines.sql");
});
