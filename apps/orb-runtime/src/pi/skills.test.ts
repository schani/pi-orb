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
});
