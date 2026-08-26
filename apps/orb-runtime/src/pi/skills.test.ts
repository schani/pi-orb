import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { RUNTIME_TOKEN_ENV } from "@pi-orb/protocol";
import { describe, expect, it } from "vitest";
import {
  HOOK_DIRECTORY,
  HOOK_NAME_ENV,
  hookLogDir,
  hookStampPath,
  hookStatusPath,
  ORB_MARKER_ENV,
  RESUME_BLOCKING_WINDOW_MS,
  SETUP_DEADLINE_MS,
  SETUP_SCRUBBED_ENV,
} from "../hooks/runner.ts";

/**
 * The skills the Dockerfile bakes at `/opt/pi-orb/skills` (docs/pi-adapter.md).
 * A skill whose frontmatter fails to parse is not loudly broken at runtime —
 * the SDK drops a skill with no description and merely warns about a bad name,
 * so the agent silently loses the capability. These checks make that a CI
 * failure instead.
 */
const skillsDir = join(import.meta.dirname, "../../skills");
const repoRoot = join(import.meta.dirname, "../../../..");

/**
 * The cloud-identity skill carries a GCP bootstrap sequence — run in the orb on
 * the primary path, printed for the human on the alternative one. It is the
 * short form of `infra/bootstrap-pi-orb-oidc.sh`, which is the
 * reviewed one — so the pieces that are easy to get subtly wrong are read out of
 * the script here rather than restated, and a change to either without the other
 * fails.
 */
const bootstrapScript = readFileSync(join(repoRoot, "infra/bootstrap-pi-orb-oidc.sh"), "utf8");

/** The literal after `<var>=`, with surrounding quotes and a `$<var>` self-reference stripped. */
const shellAssignments = (script: string, name: string): string[] =>
  script
    .split("\n")
    .filter((line) => line.trim().startsWith(`${name}=`))
    .map((line) =>
      line
        .trim()
        .slice(name.length + 1)
        .replace(/^(["'])(.*)\1$/, "$2")
        .replace(new RegExp(`^\\$${name}`), ""),
    );

const scriptCapture = (pattern: RegExp): string => {
  const captured = bootstrapScript.match(pattern)?.[1];
  if (captured === undefined)
    throw new Error(`bootstrap script no longer matches ${String(pattern)}`);
  return captured;
};

/** Per the Agent Skills spec, as enforced by the SDK's `skills.js`. */
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const skillNames = readdirSync(skillsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

const skillBody = (name: string): string => readFileSync(join(skillsDir, name, "SKILL.md"), "utf8");

/** Every shell fence in a skill body, innermost content only. */
const shellFences = (body: string): string[] =>
  [...body.matchAll(/```(?:sh|bash)\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");

/**
 * The example hook files a skill tells the agent to write. Each is identified by
 * the `# .agents/<hook>` line the example itself carries, so "what belongs in
 * setup" is decided by the fence's own header rather than by prose near it.
 */
const hookFences = (body: string, hook: "setup" | "resume"): string[] =>
  shellFences(body).filter((fence) =>
    new RegExp(`^#\\s*${HOOK_DIRECTORY}/${hook}\\b`, "m").test(fence),
  );

describe("baked agent skills", () => {
  it("ships at least the cloud identity skill", () => {
    expect(skillNames).toContain("cloud-identity");
  });

  it.each(skillNames)("%s has valid Agent Skills frontmatter", (dirName) => {
    const raw = readFileSync(join(skillsDir, dirName, "SKILL.md"), "utf8");
    const { frontmatter, body } = parseFrontmatter(raw);
    const name = frontmatter.name;
    const description = frontmatter.description;

    expect(typeof name).toBe("string");
    expect(typeof description).toBe("string");
    if (typeof name !== "string" || typeof description !== "string") return;

    expect(name).toBe(dirName);
    expect(name.length).toBeLessThanOrEqual(MAX_NAME_LENGTH);
    expect(name).toMatch(NAME_PATTERN);

    // The description is the only part of a skill always in the agent's
    // context: it alone decides whether the model ever opens the body.
    expect(description.trim().length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH);
    expect(body.trim().length).toBeGreaterThan(0);
  });

  it("points the cloud identity skill at helpers the image actually ships", () => {
    const body = readFileSync(join(skillsDir, "cloud-identity", "SKILL.md"), "utf8");
    const dockerfile = readFileSync(join(import.meta.dirname, "../../Dockerfile"), "utf8");
    // Every absolute helper path the skill instructs the agent to run must be
    // installed by the Dockerfile; a skill naming a path the image lacks is a
    // dead end the agent only discovers mid-task.
    for (const path of new Set(body.match(/\/usr\/local\/bin\/[a-z0-9-]+/g) ?? [])) {
      expect(dockerfile, `${path} must be installed by the image`).toContain(path);
    }
    expect(body).toContain("/usr/local/bin/pi-orb-gcp-identity");
  });

  /**
   * The boot-hooks skill is the authoring guide for `.agents/setup` and
   * `.agents/resume`. Everything it quotes about the mechanism — paths, budgets,
   * environment — is read out of the runner here rather than restated, so the
   * guide cannot drift away from the runtime that runs the files.
   */
  describe("the boot hooks skill", () => {
    const body = skillBody("boot-hooks");

    it("is baked into the image", () => {
      expect(skillNames).toContain("boot-hooks");
    });

    it("is discoverable from what a human would ask for", () => {
      const { frontmatter } = parseFrontmatter(body);
      const description = String(frontmatter.description);
      for (const trigger of [`${HOOK_DIRECTORY}/setup`, `${HOOK_DIRECTORY}/resume`]) {
        expect(description, `the description must name ${trigger}`).toContain(trigger);
      }
      // The two situations that must reach this skill: "make future orbs come
      // up like this" and "why did the hook fail?".
      expect(description).toMatch(/future orbs?/i);
      expect(description).toMatch(/fail/i);
    });

    it("quotes the paths the runtime actually writes", () => {
      for (const path of [
        hookLogDir("$HOME"),
        hookStatusPath("$HOME", "setup"),
        hookStatusPath("$HOME", "resume"),
        hookStampPath("$PI_ORB_WORK_DIR"),
      ]) {
        expect(body, `the skill must name ${path}`).toContain(path);
      }
    });

    it("quotes the environment contract the runner enforces", () => {
      expect(body).toContain(`${ORB_MARKER_ENV}=1`);
      expect(body).toContain(HOOK_NAME_ENV);
      for (const name of SETUP_SCRUBBED_ENV) {
        expect(body, `${name} is what makes the identity split mechanical`).toContain(name);
      }
      for (const name of ["PI_ORB_ID", "PI_ORB_HOST_INCARNATION", "PI_ORB_WORK_DIR", "HOME"]) {
        expect(body, `a hook may rely on ${name}`).toContain(name);
      }
    });

    it("quotes the runner's own budgets", () => {
      expect(body).toMatch(new RegExp(`\\b${SETUP_DEADLINE_MS / 60_000}[- ]minute`));
      expect(body).toMatch(new RegExp(`\\b${RESUME_BLOCKING_WINDOW_MS / 1_000}[- ]s(econd)?`));
    });

    it("keeps identity out of its setup example", () => {
      const setup = hookFences(body, "setup");
      const resume = hookFences(body, "resume");
      expect(setup.length, "the skill must show a setup example").toBeGreaterThan(0);
      expect(resume.length, "the skill must show a resume example").toBeGreaterThan(0);
      // Setup runs without the runtime token, so anything that mints or brokers
      // there fails closed — an example doing it teaches the one thing the
      // environment scrub exists to prevent.
      for (const fence of setup) {
        for (const forbidden of ["pi-orb id-token", "gh auth", "gcloud auth", RUNTIME_TOKEN_ENV]) {
          expect(fence, `setup cannot use ${forbidden}`).not.toContain(forbidden);
        }
      }
      expect(resume.join("\n"), "the resume example is where authentication happens").toMatch(
        /pi-orb id-token|auth/,
      );
    });

    it("shows examples a shell can parse", () => {
      const fences = shellFences(body);
      expect(fences.length).toBeGreaterThan(0);
      for (const fence of fences) {
        const parsed = spawnSync("bash", ["-n"], { encoding: "utf8", input: fence });
        expect(parsed.status, `${parsed.stderr}\n---\n${fence}`).toBe(0);
      }
    });
  });

  describe("the cloud identity skill's GCP bootstrap block", () => {
    const body = readFileSync(join(skillsDir, "cloud-identity", "SKILL.md"), "utf8");

    it("prints the same attribute mapping the reviewed script installs", () => {
      const mapping = shellAssignments(bootstrapScript, "mapping").join("");
      // Guards the extraction itself: a mapping that lost the STRING cast would
      // otherwise make this test pass by comparing two empty strings.
      expect(mapping).toContain("string(assertion.host_incarnation)");
      expect(body, "the skill's --attribute-mapping must match the bootstrap script's").toContain(
        mapping,
      );
    });

    it("prints the same attribute condition the reviewed script installs", () => {
      const tokenUse = scriptCapture(/^condition="([^"$]+)"$/m);
      const projectClause = scriptCapture(/condition="\$condition (&& assertion\.project_id == )'/);
      expect(tokenUse).toContain("token_use");
      expect(body).toContain(tokenUse);
      expect(body).toContain(`${tokenUse} ${projectClause}'`);
    });

    it("keeps the provider and impersonation markers the exchange depends on", () => {
      for (const marker of [
        "create-oidc",
        "--issuer-uri",
        "roles/iam.workloadIdentityUser",
        "principalSet://",
      ]) {
        expect(body, `the skill must still show ${marker}`).toContain(marker);
      }
    });

    it("logs gcloud in interactively only as the human's own step", () => {
      const invocations = body.match(/gcloud auth login[^\n]*/g) ?? [];
      expect(invocations.length, "the skill must still show how to log gcloud in").toBeGreaterThan(
        0,
      );
      // Two kinds of login exist and no third: the agent's own keyless
      // `--cred-file` federation, and the human's interactive device flow.
      for (const invocation of invocations) {
        expect(invocation, "a gcloud login must federate or be the human's device flow").toMatch(
          /--cred-file|--no-launch-browser/,
        );
      }
      expect(
        invocations.some((invocation) => invocation.includes("--no-launch-browser")),
        "the primary path needs the human's interactive login",
      ).toBe(true);
      expect(body, "that login happens in the orb's terminal tab").toMatch(/terminal tab/i);
      expect(body, "the human runs the interactive login; the agent never does").toMatch(
        /(do \*\*not\*\*|do not|never) run `?gcloud auth login --no-launch-browser`? yourself/i,
      );
    });

    it("runs administrative commands in the orb only behind a login it then revokes", () => {
      // Admin rights reach the orb one way only: a login the human starts in the
      // terminal and the agent revokes once federation is proven. Any other
      // admin block has to be addressed to the human at their own machine.
      const adminMarkers = [
        "gcloud services enable",
        "workload-identity-pools",
        "gcloud iam service-accounts create",
        "add-iam-policy-binding",
        "aws iam create-open-id-connect-provider",
        "aws iam create-role",
        "aws iam attach-role-policy",
      ];
      const outsideTheOrb =
        /on your own machine|not inside (this|the|an) orb|never inside (this|the|an) orb/i;
      const asksForTheLogin = (section: string) =>
        section.includes("gcloud auth login --no-launch-browser") && /terminal tab/i.test(section);
      const sections = body.split(/^(?=#{2,4} )/m);
      const adminSections = [...sections.entries()].filter(
        ([, section]) =>
          section.includes("```") && adminMarkers.some((marker) => section.includes(marker)),
      );

      expect(
        adminSections.length,
        "the skill must still print the operator commands",
      ).toBeGreaterThan(0);

      let inOrb = 0;
      let elsewhere = 0;
      for (const [index, section] of adminSections) {
        const heading = section.split("\n", 1)[0];
        if (outsideTheOrb.test(section)) {
          elsewhere += 1;
          continue;
        }
        inOrb += 1;
        expect(
          sections.slice(0, index).some(asksForTheLogin),
          `"${heading}" runs admin commands here, so an earlier step must ask the human to log in`,
        ).toBe(true);
        expect(body, `"${heading}" runs admin commands here, so the login must be revoked`).toMatch(
          /gcloud auth revoke/,
        );
      }

      expect(inOrb, "the primary path registers the trust from inside the orb").toBeGreaterThan(0);
      expect(elsewhere, "the alternative path must still exist").toBeGreaterThan(0);
    });
  });
});
