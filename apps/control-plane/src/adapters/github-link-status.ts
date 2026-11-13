import type { OrbLinkCheck, OrbLinkStatus, OrbLinkStepsResponse } from "@pi-orb/protocol";
import { err, ok, ResultAsync } from "neverthrow";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";

const QUERY_FRAGMENTS = `
fragment C on CheckRun {
  id name status conclusion detailsUrl url startedAt completedAt
}
fragment L on UniformResourceLocatable {
  __typename
  ... on PullRequest {
    title state isDraft reviewDecision additions deletions
    commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
      __typename ... on CheckRun { ...C } ... on StatusContext { context state targetUrl }
    } } } } } }
  }
  ... on Issue { title state comments { totalCount } }
  ... on WorkflowRun {
    workflow { name }
    checkSuite { status conclusion branch { name } checkRuns(first: 100) { nodes { ...C } } }
  }
}`;

const nullable = <T extends Parameters<typeof Type.Union>[0][number]>(schema: T) =>
  Type.Union([schema, Type.Null()]);
// Validate entries separately: GraphQL field errors can null individual nodes or connections.
const Connection = nullable(Type.Object({ nodes: nullable(Type.Array(Type.Unknown())) }));
const CheckRun = Type.Object({
  id: Type.Optional(nullable(Type.String())),
  name: Type.String(),
  status: Type.String(),
  conclusion: nullable(Type.String()),
  detailsUrl: nullable(Type.String()),
  url: Type.String(),
  startedAt: nullable(Type.String()),
  completedAt: nullable(Type.String()),
});
const Step = Type.Object({
  name: Type.String(),
  status: Type.String(),
  conclusion: nullable(Type.String()),
  startedAt: nullable(Type.String()),
  completedAt: nullable(Type.String()),
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
const Commit = Type.Object({
  commit: nullable(
    Type.Object({
      statusCheckRollup: nullable(Type.Object({ contexts: Connection })),
    }),
  ),
});
const PullRequest = Type.Object({
  __typename: Type.Literal("PullRequest"),
  title: Type.String(),
  state: Type.String(),
  isDraft: Type.Boolean(),
  reviewDecision: nullable(Type.String()),
  additions: Type.Number(),
  deletions: Type.Number(),
  commits: Connection,
});
const Issue = Type.Object({
  __typename: Type.Literal("Issue"),
  title: Type.String(),
  state: Type.String(),
  comments: nullable(Type.Object({ totalCount: Type.Number() })),
});
const WorkflowRun = Type.Object({
  __typename: Type.Literal("WorkflowRun"),
  workflow: nullable(Type.Object({ name: Type.String() })),
  checkSuite: nullable(
    Type.Object({
      status: Type.String(),
      conclusion: nullable(Type.String()),
      branch: nullable(Type.Object({ name: Type.String() })),
      checkRuns: Connection,
    }),
  ),
});
const Resource = Type.Union([PullRequest, Issue, WorkflowRun]);
const ResponseSchema = Type.Object({
  data: Type.Optional(nullable(Type.Record(Type.String(), Type.Unknown()))),
  errors: Type.Optional(Type.Array(Type.Object({ message: Type.String() }))),
});
const ErrorMessage = Type.Object({ message: Type.String() });

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
    id: run.id ?? null,
    name: run.name,
    result: runResult(run),
    url: https(run.detailsUrl ?? run.url),
    startedAt: time(run.startedAt),
    completedAt: time(run.completedAt),
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
    id: null,
    name: node.context,
    result,
    url: https(node.targetUrl),
    startedAt: null,
    completedAt: null,
  };
}

function status(resource: Static<typeof Resource>): OrbLinkStatus {
  switch (resource.__typename) {
    case "PullRequest": {
      const commit = resource.commits?.nodes?.find((node) => Check(Commit, node));
      const nodes = commit?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
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
      return {
        title: resource.title,
        status: word,
        diff: { additions: resource.additions, deletions: resource.deletions },
        comments: null,
        checks: nodes.filter((node) => Check(Context, node)).map(context),
      };
    }
    case "Issue":
      return {
        title: resource.title,
        status: resource.state.toLowerCase(),
        diff: null,
        comments: resource.comments?.totalCount ?? null,
        checks: [],
      };
    case "WorkflowRun": {
      const suite = resource.checkSuite;
      const word =
        suite === null
          ? "unknown"
          : suite.status !== "COMPLETED"
            ? suite.status === "IN_PROGRESS"
              ? "running"
              : "queued"
            : PASSED.has(suite.conclusion ?? "")
              ? "passed"
              : "failed";
      return {
        title: [resource.workflow?.name, suite?.branch?.name].filter(Boolean).join(" · "),
        status: word,
        diff: null,
        comments: null,
        checks: (suite?.checkRuns?.nodes ?? [])
          .filter((node) => Check(CheckRun, node))
          .map(checkRun),
      };
    }
  }
}

/** Bound untrusted explanations; never include request bodies or credentials. */
function safe(value: string, token: string, limit = 700): string {
  return value
    .replaceAll(token, "[redacted]")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, limit);
}

function graphql(
  fetcher: typeof fetch,
  token: string,
  query: string,
  variables: Readonly<Record<string, string>>,
): ResultAsync<{ data: Record<string, unknown>; githubError: string | null }, string> {
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
      // Only allowlisted diagnostic headers cross the adapter.
      const headers = [
        ["request-id", "x-github-request-id"],
        ["rate-limit", "x-ratelimit-limit"],
        ["rate-remaining", "x-ratelimit-remaining"],
        ["rate-reset", "x-ratelimit-reset"],
        ["retry-after", "retry-after"],
      ].flatMap(([label, name]) => {
        const value = response.headers.get(name ?? "");
        return value === null ? [] : [`${label}=${safe(value, token, 100)}`];
      });
      const parsed = await ResultAsync.fromThrowable(
        () => response.json() as Promise<unknown>,
        () => "malformed",
      )();
      return {
        status: response.status,
        ok: response.ok,
        body: parsed.isOk() ? parsed.value : null,
        headers,
      };
    },
    () => "GitHub status unavailable",
  )().andThen(({ status: httpStatus, ok: success, body, headers }) => {
    const diagnostic = (reason: string) =>
      safe(reason, token, 900) + (headers.length === 0 ? "" : `\nGitHub: ${headers.join("; ")}`);
    if (!success) {
      const explanation = Check(ErrorMessage, body) ? `: ${safe(body.message, token)}` : "";
      return err(diagnostic(`GitHub status HTTP ${httpStatus}${explanation}`));
    }
    if (!Check(ResponseSchema, body)) return err(diagnostic("GitHub status response malformed"));
    const explanation = body.errors
      ?.slice(0, 3)
      .map(({ message }) => safe(message, token, 250))
      .join("; ");
    const data = body.data;
    if (data === undefined || data === null)
      return err(diagnostic(`GitHub status failed: ${explanation || "no data"}`));
    return ok({
      data,
      githubError: explanation ? diagnostic(`GitHub status partial: ${explanation}`) : null,
    });
  });
}

/** One GraphQL request for every URL, without nested job steps. */
export function readGithubLinkStatuses(
  fetcher: typeof fetch,
  token: string,
  urls: readonly string[],
): ResultAsync<
  { statuses: readonly (OrbLinkStatus | null)[]; githubError: string | null },
  string
> {
  const query = `query(${urls.map((_, i) => `$u${i}: URI!`).join(", ")}) {
${urls.map((_, i) => `  l${i}: resource(url: $u${i}) { ...L }`).join("\n")}
}${QUERY_FRAGMENTS}`;
  const variables = Object.fromEntries(urls.map((url, i) => [`u${i}`, url]));
  return graphql(fetcher, token, query, variables).map(({ data, githubError }) => ({
    statuses: urls.map((_, i) => {
      const resource = data[`l${i}`];
      return Check(Resource, resource) ? status(resource) : null;
    }),
    githubError,
  }));
}

/** A single expanded check's steps, never the other checks or links. */
export function readGithubLinkSteps(
  fetcher: typeof fetch,
  token: string,
  checkId: string,
): ResultAsync<OrbLinkStepsResponse, string> {
  return graphql(
    fetcher,
    token,
    `query($id: ID!) {
    node(id: $id) { __typename ... on CheckRun {
      steps(first: 50) { nodes { name status conclusion startedAt completedAt } }
    } }
  }`,
    { id: checkId },
  ).map(({ data, githubError }) => {
    const schema = Type.Object({ __typename: Type.Literal("CheckRun"), steps: Connection });
    if (!Check(schema, data.node))
      return {
        steps: [],
        githubError: githubError ?? "GitHub check does not exist or is inaccessible",
      };
    return {
      steps: (data.node.steps?.nodes ?? [])
        .filter((step) => Check(Step, step))
        .filter((step) => step.conclusion !== "SKIPPED")
        .map((step) => ({
          name: step.name,
          result: runResult(step),
          startedAt: time(step.startedAt),
          completedAt: time(step.completedAt),
        })),
      githubError,
    };
  });
}
