import { expect, it } from "vitest";
import { readGithubLinkStatuses } from "./github-link-status.ts";

const PR = "https://github.com/o/r/pull/1";
const ISSUE = "https://github.com/o/r/issues/2";
const RUN = "https://github.com/o/r/actions/runs/3";
const GONE = "https://github.com/o/r/pull/4";

const TIMES = {
  startedAt: null,
  completedAt: null,
  checkSuite: { createdAt: "2026-11-11T17:00:00Z" },
  steps: { nodes: [] },
};
const NO_TIMES = {
  queuedAt: Date.parse("2026-11-11T17:00:00Z"),
  startedAt: null,
  completedAt: null,
  steps: [],
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
      l1: { __typename: "Issue", title: "Bug", state: "CLOSED" },
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
  expect(result._unsafeUnwrap()).toEqual([
    {
      title: "Add links",
      status: "approved",
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
          name: "ci/legacy",
          result: "pending",
          url: null,
          queuedAt: null,
          startedAt: null,
          completedAt: null,
          steps: [],
        },
      ],
    },
    { title: "Bug", status: "closed", checks: [] },
    {
      title: "e2e · links",
      status: "running",
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

it("maps check and step times, dropping skipped steps", async () => {
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
              {
                name: "e2e",
                status: "IN_PROGRESS",
                conclusion: null,
                detailsUrl: null,
                url: "https://github.com/o/r/runs/1",
                startedAt: "2026-11-11T17:00:05Z",
                completedAt: null,
                checkSuite: { createdAt: "2026-11-11T17:00:00Z" },
                steps: {
                  nodes: [
                    {
                      name: "Set up job",
                      status: "COMPLETED",
                      conclusion: "SUCCESS",
                      startedAt: "2026-11-11T17:00:06Z",
                      completedAt: "2026-11-11T17:00:07Z",
                    },
                    {
                      name: "Upload evidence",
                      status: "COMPLETED",
                      conclusion: "SKIPPED",
                      startedAt: "2026-11-11T17:00:07Z",
                      completedAt: "2026-11-11T17:00:07Z",
                    },
                    {
                      name: "Run tests",
                      status: "IN_PROGRESS",
                      conclusion: null,
                      startedAt: "2026-11-11T17:00:07Z",
                      completedAt: null,
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    },
  });
  const [check] =
    (await readGithubLinkStatuses(fetcher, "tok", [RUN]))._unsafeUnwrap()[0]?.checks ?? [];
  expect(check).toMatchObject({
    queuedAt: Date.parse("2026-11-11T17:00:00Z"),
    startedAt: Date.parse("2026-11-11T17:00:05Z"),
    completedAt: null,
    steps: [
      {
        name: "Set up job",
        result: "passed",
        startedAt: Date.parse("2026-11-11T17:00:06Z"),
        completedAt: Date.parse("2026-11-11T17:00:07Z"),
      },
      {
        name: "Run tests",
        result: "running",
        startedAt: Date.parse("2026-11-11T17:00:07Z"),
        completedAt: null,
      },
    ],
  });
});
