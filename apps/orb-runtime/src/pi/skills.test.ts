import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

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
 * The cloud-identity skill prints a GCP bootstrap block for a human to run. That
 * block is the short form of `infra/bootstrap-pi-orb-oidc.sh`, which is the
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

    it("never tells the agent to log gcloud in interactively", () => {
      for (const invocation of body.match(/gcloud auth login[^\n]*/g) ?? []) {
        expect(invocation, "in-orb gcloud login must federate, never prompt").toContain(
          "--cred-file",
        );
      }
    });

    it("only shows administrative commands in sections that send them out of the orb", () => {
      // An admin credential must never enter an orb, so every block that needs
      // one has to be addressed to the human at their own machine.
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
      const sections = body.split(/^(?=#{2,4} )/m);
      const adminSections = sections.filter(
        (section) =>
          section.includes("```") && adminMarkers.some((marker) => section.includes(marker)),
      );

      expect(
        adminSections.length,
        "the skill must still print the operator commands",
      ).toBeGreaterThan(0);
      for (const section of adminSections) {
        const heading = section.split("\n", 1)[0];
        expect(section, `"${heading}" must say these run outside the orb`).toMatch(outsideTheOrb);
      }
    });
  });
});
