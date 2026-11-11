import { expect, it } from "vitest";
import { readGithubLinkStatuses } from "./github-link-status.ts";

const PR = "https://github.com/o/r/pull/1";
const ISSUE = "https://github.com/o/r/issues/2";
const RUN = "https://github.com/o/r/actions/runs/3";
const GONE = "https://github.com/o/r/pull/4";

function respond(body: unknown, status = 200) {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { requests, fetcher };
}

it("maps pull requests, issues and Actions runs from one GraphQL request", async () => {
  const { requests, fetcher } = respond({
    data: {
      l0: {
        __typename: "PullRequest",
        title: "Add links",
        state: "OPEN",
        isDraft: false,
        reviewDecision: "APPROVED",
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  contexts: {
                    nodes: [
                      {
                        __typename: "CheckRun",
                        name: "build",
                        status: "COMPLETED",
                        conclusion: "SUCCESS",
                      },
                      {
                        __typename: "CheckRun",
                        name: "e2e",
                        status: "COMPLETED",
                        conclusion: "FAILURE",
                      },
                      {
                        __typename: "CheckRun",
                        name: "dst",
                        status: "IN_PROGRESS",
                        conclusion: null,
                      },
                      { __typename: "StatusContext", context: "ci/legacy", state: "PENDING" },
                    ],
                  },
                },
              },
            },
          ],
        },
      },
      l1: { __typename: "Issue", title: "Bug", state: "CLOSED" },
      l2: {
        __typename: "WorkflowRun",
        workflow: { name: "e2e" },
        checkSuite: {
          status: "IN_PROGRESS",
          conclusion: null,
          branch: { name: "links" },
          checkRuns: { nodes: [{ name: "qualify", status: "QUEUED", conclusion: null }] },
        },
      },
      l3: null,
    },
    errors: [{ message: "Could not resolve to a node" }],
  });
  const result = await readGithubLinkStatuses(fetcher, "tok", [PR, ISSUE, RUN, GONE]);
  expect(result._unsafeUnwrap()).toEqual([
    {
      title: "Add links",
      status: "approved",
      checks: [
        { name: "build", result: "passed" },
        { name: "e2e", result: "failed" },
        { name: "dst", result: "running" },
        { name: "ci/legacy", result: "pending" },
      ],
    },
    { title: "Bug", status: "closed", checks: [] },
    { title: "e2e · links", status: "running", checks: [{ name: "qualify", result: "pending" }] },
    null,
  ]);
  const [request] = requests;
  expect(requests).toHaveLength(1);
  expect(request?.url).toBe("https://api.github.com/graphql");
  expect(new Headers(request?.init.headers).get("authorization")).toBe("Bearer tok");
  const body = JSON.parse(String(request?.init.body));
  expect(body.variables).toEqual({ u0: PR, u1: ISSUE, u2: RUN, u3: GONE });
});

it("reports PR and run outcomes", async () => {
  const pr = (fields: object) => ({
    __typename: "PullRequest",
    title: "t",
    commits: { nodes: [] },
    ...fields,
  });
  const { fetcher } = respond({
    data: {
      l0: pr({ state: "MERGED", isDraft: false, reviewDecision: null }),
      l1: pr({ state: "OPEN", isDraft: true, reviewDecision: null }),
      l2: pr({ state: "OPEN", isDraft: false, reviewDecision: "REVIEW_REQUIRED" }),
      l3: {
        __typename: "WorkflowRun",
        workflow: { name: "Deploy" },
        checkSuite: {
          status: "COMPLETED",
          conclusion: "FAILURE",
          branch: null,
          checkRuns: { nodes: [] },
        },
      },
    },
  });
  const result = await readGithubLinkStatuses(fetcher, "tok", [PR, PR, PR, RUN]);
  expect(result._unsafeUnwrap().map((status) => status?.status)).toEqual([
    "merged",
    "draft",
    "review",
    "failed",
  ]);
  expect(result._unsafeUnwrap()[3]?.title).toBe("Deploy");
});

it("fails with a message when GitHub rejects the request", async () => {
  expect(
    (await readGithubLinkStatuses(respond({}, 401).fetcher, "tok", [PR]))._unsafeUnwrapErr(),
  ).toBe("GitHub status HTTP 401");
  expect(
    (
      await readGithubLinkStatuses(respond({ errors: [{ message: "bad" }] }).fetcher, "tok", [PR])
    )._unsafeUnwrapErr(),
  ).toBe("GitHub status failed: bad");
  const failing = (async () => {
    throw new Error("offline");
  }) as typeof fetch;
  expect((await readGithubLinkStatuses(failing, "tok", [PR]))._unsafeUnwrapErr()).toBe(
    "GitHub status unavailable",
  );
});
