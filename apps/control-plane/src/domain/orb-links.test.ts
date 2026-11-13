import { NoSimulationTask } from "determined";
import { errAsync, okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { makeHarness, seedRunningOrb, TEST_USER_ID } from "../testkit/fixtures.ts";
import { addOrbLink, type GithubLinkReader, readOrbLinks, removeOrbLink } from "./orb-links.ts";

const PR = "https://github.com/owner/repo/pull/7";
const RUN = "https://github.com/other/tool/actions/runs/9";

function setup(github: GithubLinkReader = () => okAsync({ statuses: [], githubError: null })) {
  const task = new NoSimulationTask("orb links", false);
  const h = makeHarness();
  seedRunningOrb(task, h, "orb-a");
  return {
    task,
    h,
    deps: { store: h.store, github, githubSteps: () => okAsync({ steps: [], githubError: null }) },
  };
}

it("adds canonical links once and lists them with GitHub status", async () => {
  const seen: string[][] = [];
  const { task, h, deps } = setup((_task, owner, urls) => {
    seen.push([owner, ...urls]);
    return okAsync({
      githubError: null,
      statuses: urls.map((url) =>
        url === PR ? { title: "T", status: "open", diff: null, comments: null, checks: [] } : null,
      ),
    });
  });
  expect((await addOrbLink(task, h.store, "orb-a", `${PR}/files#x`))._unsafeUnwrap()).toBe(PR);
  expect((await addOrbLink(task, h.store, "orb-a", PR))._unsafeUnwrap()).toBe(PR);
  expect((await addOrbLink(task, h.store, "orb-a", RUN))._unsafeUnwrap()).toBe(RUN);
  const links = (await readOrbLinks(task, deps, "orb-a"))._unsafeUnwrap();
  expect(links.repository).toBe("owner/repo");
  expect(links.githubError).toBeNull();
  const titles = new Map(links.items.map(({ url, github }) => [url, github?.title ?? null]));
  expect(titles).toEqual(
    new Map([
      [PR, "T"],
      [RUN, null],
    ]),
  );
  expect(seen).toEqual([[TEST_USER_ID, ...links.items.map(({ url }) => url)]]);
});

it("rejects non-GitHub links and unknown orbs", async () => {
  const { task, h, deps } = setup();
  expect(
    (await addOrbLink(task, h.store, "orb-a", "https://example.com/x"))._unsafeUnwrapErr(),
  ).toEqual({
    type: "invalid_link",
  });
  expect((await readOrbLinks(task, deps, "orb-missing"))._unsafeUnwrapErr()).toEqual({
    type: "orb_not_found",
  });
});

it("keeps links listable when GitHub is unavailable and skips GitHub without links", async () => {
  let calls = 0;
  const { task, h, deps } = setup(() => {
    calls += 1;
    return errAsync("GitHub login required");
  });
  const empty = (await readOrbLinks(task, deps, "orb-a"))._unsafeUnwrap();
  expect(empty).toEqual({ repository: "owner/repo", githubError: null, items: [] });
  expect(calls).toBe(0);
  await addOrbLink(task, h.store, "orb-a", PR);
  const links = (await readOrbLinks(task, deps, "orb-a"))._unsafeUnwrap();
  expect(links.githubError).toBe("GitHub login required");
  expect(links.items).toEqual([{ url: PR, addedAt: expect.any(Number), github: null }]);
});

it("removes links idempotently", async () => {
  const { task, h, deps } = setup();
  await addOrbLink(task, h.store, "orb-a", PR);
  expect((await removeOrbLink(task, h.store, "orb-a", PR)).isOk()).toBe(true);
  expect((await removeOrbLink(task, h.store, "orb-a", PR)).isOk()).toBe(true);
  expect((await readOrbLinks(task, deps, "orb-a"))._unsafeUnwrap().items).toEqual([]);
});
