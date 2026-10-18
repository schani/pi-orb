import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RUNTIME_TOKEN_ENV } from "@pi-orb/protocol";
import { describe, expect, it } from "vitest";
import {
  HOOK_ENV_DENIED,
  HOOK_ENV_FILE_ENV,
  HOOK_NAME_ENV,
  hookEnvPath,
  ORB_MARKER_ENV,
} from "./hooks/env-file.ts";
import { HOOK_DIRECTORY, SETUP_SCRUBBED_ENV } from "./hooks/runner.ts";

const root = join(import.meta.dirname, "../../..");
const skill = (name: string) =>
  readFileSync(join(root, "apps/orb-runtime/skills", name, "SKILL.md"), "utf8");
const bootstrap = readFileSync(join(root, "infra/bootstrap-pi-orb-oidc.sh"), "utf8");
const capture = (pattern: RegExp) => {
  const value = bootstrap.match(pattern)?.[1];
  if (value === undefined) throw new Error(`bootstrap no longer matches ${pattern}`);
  return value;
};

describe("baked skill security contracts", () => {
  const hooks = skill("boot-hooks");
  const cloud = skill("cloud-identity");

  it("documents the runner's identity scrub and env-file handoff", () => {
    expect(hooks).toContain(`${ORB_MARKER_ENV}=1`);
    expect(hooks).toContain(HOOK_NAME_ENV);
    for (const name of SETUP_SCRUBBED_ENV) expect(hooks).toContain(name);
    for (const name of ["PI_ORB_ID", "PI_ORB_HOST_INCARNATION", "PI_ORB_WORK_DIR", "HOME"])
      expect(hooks).toContain(name);
    expect(hooks).toContain(HOOK_ENV_FILE_ENV);
    expect(hooks).toContain(hookEnvPath("$HOME"));
    for (const name of HOOK_ENV_DENIED) expect(hooks).toContain(name);
    expect(hooks).toMatch(/bash -c/);
    expect(hooks).toMatch(/--noprofile --norc/);
  });

  it("keeps identity out of setup examples and authentication in resume", () => {
    const fences = [...hooks.matchAll(/```(?:sh|bash)\n([\s\S]*?)```/g)].map(
      (match) => match[1] ?? "",
    );
    const examples = (hook: string) =>
      fences.filter((fence) => new RegExp(`^#\\s*${HOOK_DIRECTORY}/${hook}\\b`, "m").test(fence));
    const setup = examples("setup");
    const resume = examples("resume");
    expect(setup.length).toBeGreaterThan(0);
    expect(resume.length).toBeGreaterThan(0);
    for (const fence of setup)
      for (const forbidden of ["pi-orb id-token", "gh auth", "gcloud auth", RUNTIME_TOKEN_ENV])
        expect(fence).not.toContain(forbidden);
    expect(resume.join("\n")).toMatch(/pi-orb id-token|auth/);
  });

  it("prints the reviewed GCP trust mapping, condition and impersonation markers", () => {
    const mapping = bootstrap
      .split("\n")
      .filter((line) => line.trim().startsWith("mapping="))
      .map((line) =>
        line
          .trim()
          .slice("mapping=".length)
          .replace(/^(["'])(.*)\1$/, "$2")
          .replace(/^\$mapping/, ""),
      )
      .join("");
    expect(mapping).toContain("string(assertion.host_incarnation)");
    expect(cloud).toContain(mapping);
    const tokenUse = capture(/^condition="([^"$]+)"$/m);
    const projectClause = capture(/condition="\$condition (&& assertion\.project_id == )'/);
    expect(tokenUse).toContain("token_use");
    expect(cloud).toContain(`${tokenUse} ${projectClause}'`);
    for (const marker of [
      "create-oidc",
      "--issuer-uri",
      "roles/iam.workloadIdentityUser",
      "principalSet://",
    ])
      expect(cloud).toContain(marker);
  });

  it("reserves interactive login for the human and revokes the temporary admin login", () => {
    const invocations = cloud.match(/gcloud auth login[^\n]*/g) ?? [];
    expect(invocations.length).toBeGreaterThan(0);
    for (const invocation of invocations)
      expect(invocation).toMatch(/--cred-file|--no-launch-browser/);
    expect(invocations.some((invocation) => invocation.includes("--no-launch-browser"))).toBe(true);
    expect(cloud).toMatch(
      /(do \*\*not\*\*|do not|never) run `?gcloud auth login --no-launch-browser`? yourself/i,
    );
    const sections = cloud.split(/^(?=#{2,4} )/m);
    const adminMarkers = [
      "gcloud services enable",
      "workload-identity-pools",
      "gcloud iam service-accounts create",
      "add-iam-policy-binding",
      "aws iam create-open-id-connect-provider",
      "aws iam create-role",
      "aws iam attach-role-policy",
    ];
    let inOrb = 0;
    let elsewhere = 0;
    for (const [index, section] of sections.entries()) {
      if (!section.includes("```") || !adminMarkers.some((marker) => section.includes(marker)))
        continue;
      if (
        /on your own machine|not inside (this|the|an) orb|never inside (this|the|an) orb/i.test(
          section,
        )
      ) {
        elsewhere++;
        continue;
      }
      inOrb++;
      expect(
        sections
          .slice(0, index)
          .some(
            (prior) =>
              prior.includes("gcloud auth login --no-launch-browser") &&
              /terminal tab/i.test(prior),
          ),
      ).toBe(true);
      expect(cloud).toMatch(/gcloud auth revoke/);
    }
    expect(inOrb).toBeGreaterThan(0);
    expect(elsewhere).toBeGreaterThan(0);
  });
});
