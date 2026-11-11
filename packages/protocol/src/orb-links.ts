import { type Static, Type } from "typebox";

const closed = { additionalProperties: false } as const;

export const ORB_LINKS_RUNTIME_PATH = "/runtime/v1/orb/links";

const LINK =
  /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/(pull|issues|actions\/runs)\/([0-9]+)(?:[/?#].*)?$/i;

/** `https://github.com/<owner>/<repo>/{pull|issues|actions/runs}/<n>`, or null. */
export function canonicalGithubLink(url: string): string | null {
  const match = LINK.exec(url);
  if (!match) return null;
  const [, owner, repo, kind, number] = match;
  return `https://github.com/${owner}/${repo}/${kind?.toLowerCase()}/${number}`;
}

/** Lowercased `owner/repo` of a GitHub repository URL, or null. */
export function githubRepository(repositoryUrl: string | null): string | null {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/i.exec(
    repositoryUrl ?? "",
  );
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}

/** `#291`, `run 1187`; prefixed with the repository name when it is not `repository`. */
export function githubLinkRef(url: string, repository: string | null): string {
  const match = LINK.exec(url);
  if (!match) return url;
  const [, owner, repo, kind, number] = match;
  const own = `${owner}/${repo}`.toLowerCase() === repository;
  const ref = kind === "actions/runs" ? `run ${number}` : `#${number}`;
  return own ? ref : `${repo}${ref.startsWith("#") ? "" : " "}${ref}`;
}

export const OrbLinkRequestSchema = Type.Object(
  { url: Type.String({ minLength: 1, maxLength: 2048 }) },
  closed,
);
export type OrbLinkRequest = Static<typeof OrbLinkRequestSchema>;

const OrbLinkResultSchema = Type.Union([
  Type.Literal("passed"),
  Type.Literal("failed"),
  Type.Literal("running"),
  Type.Literal("pending"),
]);
const Time = Type.Union([Type.Number(), Type.Null()]);

/** One Actions job step; times are epoch ms. */
export const OrbLinkStepSchema = Type.Object(
  { name: Type.String(), result: OrbLinkResultSchema, startedAt: Time, completedAt: Time },
  closed,
);
export type OrbLinkStep = Static<typeof OrbLinkStepSchema>;

export const OrbLinkCheckSchema = Type.Object(
  {
    name: Type.String(),
    result: OrbLinkResultSchema,
    /** The check's GitHub page (an Actions job for workflow checks). */
    url: Type.Union([Type.String({ pattern: "^https://" }), Type.Null()]),
    /** Epoch ms; `queuedAt` is when its check suite was created. */
    queuedAt: Time,
    startedAt: Time,
    completedAt: Time,
    steps: Type.Array(OrbLinkStepSchema),
  },
  closed,
);
export type OrbLinkCheck = Static<typeof OrbLinkCheckSchema>;

export const OrbLinkStatusSchema = Type.Object(
  { title: Type.String(), status: Type.String(), checks: Type.Array(OrbLinkCheckSchema) },
  closed,
);
export type OrbLinkStatus = Static<typeof OrbLinkStatusSchema>;

export const OrbLinkViewSchema = Type.Object(
  {
    url: Type.String({ pattern: "^https://github\\.com/" }),
    addedAt: Type.Number(),
    github: Type.Union([OrbLinkStatusSchema, Type.Null()]),
  },
  closed,
);
export type OrbLinkView = Static<typeof OrbLinkViewSchema>;

export const OrbLinksResponseSchema = Type.Object(
  {
    /** The project's own `owner/repo`, so its links drop the repository prefix. */
    repository: Type.Union([Type.String(), Type.Null()]),
    githubError: Type.Union([Type.String(), Type.Null()]),
    items: Type.Array(OrbLinkViewSchema),
  },
  closed,
);
export type OrbLinksResponse = Static<typeof OrbLinksResponseSchema>;
