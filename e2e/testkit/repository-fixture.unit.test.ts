import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import {
  REPOSITORY_FIXTURE_URL,
  repositoryFixture,
  repositoryRewrite,
} from "./repository-fixture.ts";

it("serves a snapshot of this checkout in place of the GitHub repository", async () => {
  const fixture = await repositoryFixture();
  expect(fixture.containerUrl).toMatch(/^git:\/\/host\.docker\.internal:\d+\/pi-orb$/);
  const listed = execFileSync("git", ["ls-remote", REPOSITORY_FIXTURE_URL, "refs/heads/main"], {
    env: { PATH: process.env.PATH, ...repositoryRewrite(fixture.hostUrl) },
  }).toString();
  expect(listed.split("\t")[0]).toBe(fixture.commit);
  expect(await repositoryFixture()).toBe(fixture);
});
