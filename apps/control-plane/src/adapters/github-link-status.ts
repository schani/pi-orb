import type { OrbLinkCheck, OrbLinkStatus } from "@pi-orb/protocol";
import { err, ok, ResultAsync } from "neverthrow";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";

const QUERY_FRAGMENTS = `
fragment C on CheckRun {
  name status conclusion detailsUrl url startedAt completedAt
  steps(first: 50) { nodes { name status conclusion startedAt completedAt } }
}
fragment L on UniformResourceLocatable {
  __typename
  ... on PullRequest {
    title state isDraft reviewDecision
    commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
      __typename ... on CheckRun { ...C } ... on StatusContext { context state targetUrl }
    } } } } } }
  }
  ... on Issue { title state }
  ... on WorkflowRun {
    workflow { name }
    checkSuite { status conclusion branch { name } checkRuns(first: 100) { nodes { ...C } } }
  }
}`;

const nullable = <T extends Parameters<typeof Type.Union>[0][number]>(schema: T) =>
  Type.Union([schema, Type.Null()]);
const CheckRun = Type.Object({
  name: Type.String(),
  status: Type.String(),
  conclusion: nullable(Type.String()),
  detailsUrl: nullable(Type.String()),
  url: Type.String(),
  startedAt: nullable(Type.String()),
  completedAt: nullable(Type.String()),
  steps: Type.Object({
    nodes: Type.Array(
      Type.Object({
        name: Type.String(),
        status: Type.String(),
        conclusion: nullable(Type.String()),
        startedAt: nullable(Type.String()),
        completedAt: nullable(Type.String()),
      }),
    ),
  }),
});
const Context = Type.Union([
  Type.Intersect([Type.Object({ __typename: Type.Literal("CheckRun") }), CheckRun]),
  Type.Object({
    __typename: Type.Literal("StatusContext"),
    context: Type.String(),
    state: Type.String(),
    targetUrl: nullable(Type.String()),
  }),
]);
const PullRequest = Type.Object({
  __typename: Type.Literal("PullRequest"),
  title: Type.String(),
  state: Type.String(),
  isDraft: Type.Boolean(),
  reviewDecision: nullable(Type.String()),
  commits: Type.Object({
    nodes: Type.Array(
      Type.Object({
        commit: Type.Object({
          statusCheckRollup: nullable(
            Type.Object({ contexts: Type.Object({ nodes: Type.Array(Context) }) }),
          ),
        }),
      }),
    ),
  }),
});
const Issue = Type.Object({
  __typename: Type.Literal("Issue"),
  title: Type.String(),
  state: Type.String(),
});
const WorkflowRun = Type.Object({
  __typename: Type.Literal("WorkflowRun"),
  workflow: Type.Object({ name: Type.String() }),
  checkSuite: Type.Object({
    status: Type.String(),
    conclusion: nullable(Type.String()),
    branch: nullable(Type.Object({ name: Type.String() })),
    checkRuns: Type.Object({ nodes: Type.Array(CheckRun) }),
  }),
});
const Resource = Type.Union([PullRequest, Issue, WorkflowRun]);
const ResponseSchema = Type.Object({
  data: Type.Optional(nullable(Type.Record(Type.String(), Type.Unknown()))),
  errors: Type.Optional(Type.Array(Type.Object({ message: Type.String() }))),
});

/** Only https URLs reach the browser as links. */
const https = (url: string | null): string | null => (url?.startsWith("https://") ? url : null);

const PASSED = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

function runResult(run: { status: string; conclusion: string | null }): OrbLinkCheck["result"] {
  return run.status === "COMPLETED"
    ? PASSED.has(run.conclusion ?? "")
      ? "passed"
      : "failed"
    : run.status === "IN_PROGRESS"
      ? "running"
      : "pending";
}

/** Epoch ms, or null for absent or unparsable times. */
function time(value: string | null): number | null {
  const ms = value === null ? Number.NaN : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function checkRun(run: Static<typeof CheckRun>): OrbLinkCheck {
  return {
    name: run.name,
    result: runResult(run),
    url: https(run.detailsUrl ?? run.url),
    startedAt: time(run.startedAt),
    completedAt: time(run.completedAt),
    steps: run.steps.nodes
      .filter((step) => step.conclusion !== "SKIPPED")
      .map((step) => ({
        name: step.name,
        result: runResult(step),
        startedAt: time(step.startedAt),
        completedAt: time(step.completedAt),
      })),
  };
}

function context(node: Static<typeof Context>): OrbLinkCheck {
  if (node.__typename === "CheckRun") return checkRun(node);
  const result =
    node.state === "SUCCESS"
      ? "passed"
      : node.state === "FAILURE" || node.state === "ERROR"
        ? "failed"
        : "pending";
  return {
    name: node.context,
    result,
    url: https(node.targetUrl),
    startedAt: null,
    completedAt: null,
    steps: [],
  };
}

function status(resource: Static<typeof Resource>): OrbLinkStatus {
  switch (resource.__typename) {
    case "PullRequest": {
      const contexts =
        resource.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes.map(context) ?? [];
      const word =
        resource.state !== "OPEN"
          ? resource.state.toLowerCase()
          : resource.isDraft
            ? "draft"
            : resource.reviewDecision === "APPROVED"
              ? "approved"
              : resource.reviewDecision === "CHANGES_REQUESTED"
                ? "changes requested"
                : resource.reviewDecision === "REVIEW_REQUIRED"
                  ? "review"
                  : "open";
      return { title: resource.title, status: word, checks: contexts };
    }
    case "Issue":
      return { title: resource.title, status: resource.state.toLowerCase(), checks: [] };
    case "WorkflowRun": {
      const suite = resource.checkSuite;
      const word =
        suite.status !== "COMPLETED"
          ? suite.status === "IN_PROGRESS"
            ? "running"
            : "queued"
          : PASSED.has(suite.conclusion ?? "")
            ? "passed"
            : "failed";
      return {
        title: [resource.workflow.name, suite.branch?.name].filter(Boolean).join(" · "),
        status: word,
        checks: suite.checkRuns.nodes.map(checkRun),
      };
    }
  }
}

/** One GraphQL request for every URL; unresolvable URLs map to null. */
export function readGithubLinkStatuses(
  fetcher: typeof fetch,
  token: string,
  urls: readonly string[],
): ResultAsync<readonly (OrbLinkStatus | null)[], string> {
  const query = `query(${urls.map((_, i) => `$u${i}: URI!`).join(", ")}) {
${urls.map((_, i) => `  l${i}: resource(url: $u${i}) { ...L }`).join("\n")}
}${QUERY_FRAGMENTS}`;
  const variables = Object.fromEntries(urls.map((url, i) => [`u${i}`, url]));
  return ResultAsync.fromThrowable(
    async () => {
      const response = await fetcher("https://api.github.com/graphql", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "user-agent": "pi-orb",
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(10_000),
      });
      return {
        status: response.status,
        body: response.ok ? ((await response.json()) as unknown) : null,
      };
    },
    () => "GitHub status unavailable",
  )().andThen(({ status: httpStatus, body }) => {
    if (body === null) return err(`GitHub status HTTP ${httpStatus}`);
    if (!Check(ResponseSchema, body)) return err("GitHub status response malformed");
    const data = body.data;
    if (data === undefined || data === null)
      return err(`GitHub status failed: ${body.errors?.[0]?.message ?? "no data"}`);
    return ok(
      urls.map((_, i) => {
        const resource = data[`l${i}`];
        return Check(Resource, resource) ? status(resource) : null;
      }),
    );
  });
}
