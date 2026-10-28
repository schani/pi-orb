import { expect, it } from "vitest";
import { acquireGithubOwnerSkill } from "./github-owner-skill.ts";

const sha = "a".repeat(40);
const content = "---\nname: nasa\ndescription: science\n---\n";
function fixture(
  options: {
    mode?: string;
    path?: string;
    root?: boolean;
    truncated?: boolean;
    status?: number;
    size?: number;
  } = {},
) {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    expect(init?.redirect).toBe("error");
    if (options.status)
      return Response.json({ message: "Validation Failed" }, { status: options.status });
    if (url.includes("/commits/feature%2Fscience%2Fskills"))
      return Response.json(
        {
          message: "No commit found for SHA: feature/science/skills",
          documentation_url: "https://docs.github.com/rest/commits/commits#get-a-commit",
          status: "422",
        },
        { status: 422 },
      );
    if (url.includes("/commits/feature%2Fscience"))
      return Response.json({ sha, commit: { tree: { sha: "b".repeat(40) } } });
    if (url.includes(`/git/trees/${"b".repeat(40)}`))
      return Response.json({
        tree: [{ path: "skills", mode: "040000", type: "tree", sha: "c".repeat(40) }],
        truncated: false,
      });
    if (url.includes(`/git/trees/${"c".repeat(40)}`) && !url.includes("recursive"))
      return Response.json({
        tree: [{ path: "nasa", mode: "040000", type: "tree", sha: "d".repeat(40) }],
        truncated: false,
      });
    if (url.includes("?recursive=1"))
      return Response.json({
        truncated: options.truncated ?? false,
        tree: [
          ...(options.root === false
            ? []
            : [
                {
                  path: "SKILL.md",
                  type: "blob",
                  mode: "100644",
                  size: Buffer.byteLength(content),
                },
              ]),
          {
            path: options.path ?? "scripts/run",
            type: "blob",
            mode: options.mode ?? "100755",
            size: options.size ?? 3,
          },
        ],
      });
    if (url.includes("raw.githubusercontent.com")) {
      expect(url).toContain(`/${sha}/skills/nasa/`);
      return new Response(url.endsWith("/SKILL.md") ? content : new Uint8Array([0, 255, 1]));
    }
    return new Response("", { status: 404 });
  };
  return { calls, fetcher };
}
const url = "https://github.com/nasa/science/tree/feature/science/skills/nasa";
it.each([url, url.replace("feature/science", "feature%2Fscience"), `${url}#`])(
  "resolves slash refs once, pins every download, preserves binary and executable mode: %s",
  async (input) => {
    const f = fixture();
    const result = await acquireGithubOwnerSkill(input, undefined, f.fetcher);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({
      content,
      files: [{ path: "scripts/run", base64: "AP8B", executable: true }],
      source: { url: `https://github.com/nasa/science/tree/${sha}/skills/nasa`, commitSha: sha },
    });
    expect(f.calls.filter((c) => c.includes("/commits/"))).toHaveLength(2);
  },
);
it.each([
  { mode: "120000" },
  { mode: "160000" },
  { path: "../escape" },
  { root: false },
  { truncated: true },
  { size: 8 * 1024 * 1024 },
])("rejects incomplete or unsafe trees %j before downloads", async (options) => {
  const f = fixture(options);
  expect((await acquireGithubOwnerSkill(url, undefined, f.fetcher)).isErr()).toBe(true);
  expect(f.calls.some((c) => c.includes("raw.githubusercontent.com"))).toBe(false);
});
it.each([
  "http://github.com/a/b/tree/main/x",
  "https://evil.test/a/b/tree/main/x",
  "https://u:p@github.com/a/b/tree/main/x",
  "https://github.com/a/b/tree/main/%2e%2e/x",
  "https://github.com/a%2Fb/c/tree/main/x",
  "https://github.com/a/b%2Fc/tree/main/x",
  "https://github.com/a/b/tr%2Fee/main/x",
])("rejects unsafe URL %s", async (bad) => {
  const f = fixture();
  expect((await acquireGithubOwnerSkill(bad, undefined, f.fetcher)).isErr()).toBe(true);
  expect(f.calls).toHaveLength(0);
});
it.each([403, 422])(
  "does not treat rate limits or unrelated validation errors as missing refs: %s",
  async (status) => {
    const f = fixture({ status });
    const result = await acquireGithubOwnerSkill(url, undefined, f.fetcher);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      code: "unavailable",
      message: expect.stringContaining(String(status)),
    });
    expect(f.calls).toHaveLength(1);
  },
);

it("maps synchronous fetch throws and cancelled requests to recoverable errors", async () => {
  const throwing = (() => {
    throw new Error("offline");
  }) as typeof fetch;
  expect((await acquireGithubOwnerSkill(url, undefined, throwing))._unsafeUnwrapErr().code).toBe(
    "unavailable",
  );
  const abort = new AbortController();
  abort.abort();
  const fetcher: typeof fetch = (_url, init) => {
    expect(init?.signal?.aborted).toBe(true);
    return Promise.reject(new Error("cancelled"));
  };
  expect((await acquireGithubOwnerSkill(url, abort.signal, fetcher))._unsafeUnwrapErr().code).toBe(
    "unavailable",
  );
});
