import { expect, it } from "vitest";
import { readGithubLinkStatuses, readGithubLinkSteps } from "./github-link-status.ts";

const PR = "https://github.com/o/r/pull/1";
const ISSUE = "https://github.com/o/r/issues/2";
const RUN = "https://github.com/o/r/actions/runs/3";
const GONE = "https://github.com/o/r/pull/4";

const TIMES = {
  startedAt: null,
  completedAt: null,
  steps: { nodes: [] },
};
const NO_TIMES = {
  id: null,
  startedAt: null,
  completedAt: null,
};

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
        additions: 525,
        deletions: 38,
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
                        detailsUrl: "https://github.com/o/r/actions/runs/1/job/1",
                        url: "https://github.com/o/r/runs/1",
                        ...TIMES,
                      },
                      {
                        __typename: "CheckRun",
                        name: "e2e",
                        status: "COMPLETED",
                        conclusion: "FAILURE",
                        detailsUrl: null,
                        url: "https://github.com/o/r/runs/2",
                        ...TIMES,
                      },
                      {
                        __typename: "CheckRun",
                        name: "dst",
                        status: "IN_PROGRESS",
                        conclusion: null,
                        detailsUrl: "javascript:alert(1)",
                        url: "https://github.com/o/r/runs/3",
                        ...TIMES,
                      },
                      {
                        __typename: "StatusContext",
                        context: "ci/legacy",
                        state: "PENDING",
                        targetUrl: null,
                      },
                    ],
                  },
                },
              },
            },
          ],
        },
      },
      l1: { __typename: "Issue", title: "Bug", state: "CLOSED", comments: { totalCount: 4 } },
      l2: {
        __typename: "WorkflowRun",
        workflow: { name: "e2e" },
        checkSuite: {
          status: "IN_PROGRESS",
          conclusion: null,
          branch: { name: "links" },
          checkRuns: {
            nodes: [
              {
                name: "qualify",
                status: "QUEUED",
                conclusion: null,
                detailsUrl: "https://github.com/o/r/actions/runs/1/job/9",
                url: "https://github.com/o/r/runs/9",
                ...TIMES,
              },
            ],
          },
        },
      },
      l3: null,
    },
    errors: [{ message: "Could not resolve to a node" }],
  });
  const result = await readGithubLinkStatuses(fetcher, "tok", [PR, ISSUE, RUN, GONE]);
  expect(result._unsafeUnwrap().statuses).toEqual([
    {
      title: "Add links",
      status: "approved",
      diff: { additions: 525, deletions: 38 },
      comments: null,
      checks: [
        {
          name: "build",
          result: "passed",
          url: "https://github.com/o/r/actions/runs/1/job/1",
          ...NO_TIMES,
        },
        { name: "e2e", result: "failed", url: "https://github.com/o/r/runs/2", ...NO_TIMES },
        { name: "dst", result: "running", url: null, ...NO_TIMES },
        {
          id: null,
          name: "ci/legacy",
          result: "pending",
          url: null,
          startedAt: null,
          completedAt: null,
        },
      ],
    },
    { title: "Bug", status: "closed", diff: null, comments: 4, checks: [] },
    {
      title: "e2e · links",
      status: "running",
      diff: null,
      comments: null,
      checks: [
        {
          name: "qualify",
          result: "pending",
          url: "https://github.com/o/r/actions/runs/1/job/9",
          ...NO_TIMES,
        },
      ],
    },
    null,
  ]);
  const [request] = requests;
  expect(requests).toHaveLength(1);
  expect(request?.url).toBe("https://api.github.com/graphql");
  expect(new Headers(request?.init.headers).get("authorization")).toBe("Bearer tok");
  const body = JSON.parse(String(request?.init.body));
  expect(body.query).not.toContain("steps(");
  expect(body.query).toContain("startedAt completedAt");
  expect(result._unsafeUnwrap().githubError).toContain("Could not resolve to a node");
  expect(body.variables).toEqual({ u0: PR, u1: ISSUE, u2: RUN, u3: GONE });
});

it("reports PR and run outcomes", async () => {
  const pr = (fields: object) => ({
    __typename: "PullRequest",
    title: "t",
    additions: 1,
    deletions: 0,
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
  expect(result._unsafeUnwrap().statuses.map((status) => status?.status)).toEqual([
    "merged",
    "draft",
    "review",
    "failed",
  ]);
  expect(result._unsafeUnwrap().statuses[3]?.title).toBe("Deploy");
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

it("loads only one check's steps on demand, retaining accessible steps", async () => {
  const { requests, fetcher } = respond({
    data: {
      node: {
        __typename: "CheckRun",
        steps: {
          nodes: [
            null,
            {
              name: "run",
              status: "IN_PROGRESS",
              conclusion: null,
              startedAt: "2026-11-11T17:00:07Z",
              completedAt: null,
            },
            {
              name: "skip",
              status: "COMPLETED",
              conclusion: "SKIPPED",
              startedAt: null,
              completedAt: null,
            },
          ],
        },
      },
    },
    errors: [{ message: "Some steps unavailable" }],
  });
  const result = (await readGithubLinkSteps(fetcher, "tok", "CR_1"))._unsafeUnwrap();
  expect(result.steps).toEqual([
    {
      name: "run",
      result: "running",
      startedAt: Date.parse("2026-11-11T17:00:07Z"),
      completedAt: null,
    },
  ]);
  expect(result.githubError).toContain("Some steps unavailable");
  const body = JSON.parse(String(requests[0]?.init.body));
  expect(body.variables).toEqual({ id: "CR_1" });
  expect(body.query).toContain("steps(first: 50)");
  expect(body.query).not.toContain("resource(");
});

it("retains status and accessible checks when a check or connection is inaccessible", async () => {
  const { fetcher } = respond({
    data: {
      l0: {
        __typename: "WorkflowRun",
        workflow: { name: "CI" },
        checkSuite: {
          status: "IN_PROGRESS",
          conclusion: null,
          branch: null,
          checkRuns: {
            nodes: [
              null,
              {
                id: "CR_1",
                name: "build",
                status: "IN_PROGRESS",
                conclusion: null,
                detailsUrl: null,
                url: RUN,
                startedAt: "2026-11-11T17:00:05Z",
                completedAt: null,
              },
            ],
          },
        },
      },
      l1: {
        __typename: "PullRequest",
        title: "PR",
        state: "OPEN",
        isDraft: false,
        reviewDecision: null,
        additions: 1,
        deletions: 0,
        commits: null,
      },
    },
    errors: [{ message: "Resource not accessible by integration" }],
  });
  const result = (await readGithubLinkStatuses(fetcher, "tok", [RUN, PR]))._unsafeUnwrap();
  expect(result.statuses[0]?.checks).toMatchObject([
    { id: "CR_1", name: "build", startedAt: Date.parse("2026-11-11T17:00:05Z") },
  ]);
  expect(result.statuses[1]).toMatchObject({ title: "PR", checks: [] });
  expect(result.githubError).toContain("Resource not accessible by integration");
});

it("preserves bounded safe GitHub explanations and request/rate headers", async () => {
  const fetcher = (async () =>
    new Response(
      JSON.stringify({
        message: `Resource not accessible by integration\nsecret-token ${"x".repeat(5000)}`,
      }),
      {
        status: 403,
        headers: {
          "x-github-request-id": "request-1 secret-token",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "123",
          "retry-after": "60",
        },
      },
    )) as typeof fetch;
  const error = (await readGithubLinkStatuses(fetcher, "secret-token", [PR]))._unsafeUnwrapErr();
  expect(error).toContain("Resource not accessible by integration");
  expect(error).toContain("request-id=request-1");
  expect(error).toContain("rate-remaining=0");
  expect(error).toContain("rate-reset=123");
  expect(error).toContain("retry-after=60");
  expect(error).not.toContain("secret-token");
  expect(error).toContain("integration [redacted]");
  expect(error).toContain("request-id=request-1 [redacted]");
  expect(error.length).toBeLessThan(1400);
  expect(error.split("\n")).toHaveLength(2);
});
