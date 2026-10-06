import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const workflow = readFileSync(new URL("../.github/workflows/e2e.yml", import.meta.url), "utf8");
const guard = "github.event_name == 'workflow_dispatch' && inputs.lifecycle_diagnostic == true";

it("defaults to the full suite and gates diagnostic selection and its nonqualifying name on manual dispatch", () => {
  expect(workflow).toMatch(
    /workflow_dispatch:\n {4}inputs:\n {6}lifecycle_diagnostic:\n {8}description: .+\n {8}type: boolean\n {8}default: false\n/,
  );
  expect(workflow).toContain(`name: \${{ ${guard} && 'lifecycle-diagnostic' || 'e2e' }}`);
  expect(workflow).toContain(`LIFECYCLE_DIAGNOSTIC: \${{ ${guard} }}`);
  expect(workflow).toMatch(
    /- name: Run end-to-end test\n\s+if: env.LIFECYCLE_DIAGNOSTIC != 'true'\n\s+run: npm run test:e2e -- --bail 1\n/,
  );
  expect(workflow).toMatch(
    /- name: Run lifecycle diagnostic\n\s+if: env.LIFECYCLE_DIAGNOSTIC == 'true'\n/,
  );
});

it("selects exactly the two implicated lifecycle cases without bail or extra shell arguments", () => {
  const command = workflow.match(
    /- name: Run lifecycle diagnostic\n\s+if: [^\n]+\n\s+run: (.+)\n/,
  )?.[1];
  expect(command).toBeDefined();
  // Parse the actual shell command without running npm or starting an E2E fixture.
  const args = execFileSync("bash", ["-c", `npm() { printf '%s\\0' "$@"; }; ${command}`], {
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  expect(args.slice(0, 8)).toEqual([
    "run",
    "test:e2e",
    "--",
    "--project",
    "lifecycle",
    "e2e/full-slice.e2e.test.ts",
    "e2e/subagents.e2e.test.ts",
    "--testNamePattern",
  ]);
  expect(args).toHaveLength(9);
  const titles = args.slice(5, 7).flatMap((path) => {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    return [...source.matchAll(/\bit\("([^"]+)"/g)].map(
      (match) => `${path.includes("full-slice") ? "full slice E2E " : ""}${match[1]}`,
    );
  });
  const pattern = new RegExp(args[8] ?? "");
  expect(titles.filter((title) => pattern.test(title))).toEqual([
    "full slice E2E runs login, a scripted tool round trip, replication, and drain",
    "rejects unknown profiles and models without child inference, and dispatches model sol explicitly",
  ]);
  expect(pattern.test(`prefix ${titles[0]}`)).toBe(false);
  expect(pattern.test(`${titles[0]} suffix`)).toBe(false);
});
