import { createHash } from "node:crypto";
import { errAsync, okAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { ResourceAcquisition, type ResourceSnapshot } from "../../domain/resources.ts";
import { type PersistedPlatformContext, prepareResourceContext } from "./resource-context.ts";

const file = (path: string, text: string) => ({
  path,
  bytes: Buffer.from(text),
  sha256: createHash("sha256").update(text).digest("hex"),
});
function fixture() {
  let repo: ResourceSnapshot | null = null;
  let platform: PersistedPlatformContext | null = null;
  let revision = 1;
  let sourceCalls = 0;
  let platformCalls = 0;
  let admitted = true;
  const acquisition = new ResourceAcquisition(
    {
      get: () => okAsync(repo),
      put: (s) => {
        repo = s;
        return okAsync(s);
      },
      remove: () => okAsync(undefined),
    },
    {
      acquire: () => {
        sourceCalls++;
        return okAsync({
          orbId: "orb",
          commitSha: "a".repeat(40),
          instructionPath: "AGENTS.md",
          skillRoot: ".pi/skills",
          files: [
            file("AGENTS.md", "repo rules"),
            file(".pi/skills/x/SKILL.md", "---\nname: x\ndescription: repo skill\n---\nbody"),
          ],
        });
      },
    },
  );
  const options = {
    orbId: "orb",
    url: "https://github.com/o/r",
    signal: new AbortController().signal,
    platformVersion: "v1",
    acquisition,
    managed: () =>
      okAsync({
        personal: { content: `personal ${revision}`, revision },
        project: { content: "project", revision },
      }),
    platformStore: {
      get: () => okAsync(platform),
      put: (s: PersistedPlatformContext) => {
        platform = s;
        return okAsync(undefined);
      },
    },
    loadPlatform: () => {
      platformCalls++;
      return okAsync([
        file(
          "/opt/pi-orb/skills/hosting/SKILL.md",
          "---\nname: hosting\ndescription: platform skill\n---\nhelp",
        ),
        file("/opt/pi-orb/skills/hosting/script.sh", "echo help"),
      ]);
    },
    check: () =>
      admitted
        ? okAsync(undefined)
        : errAsync({
            type: "resource_error" as const,
            code: "cancelled" as const,
            message: "revoked",
          }),
  };
  return {
    options,
    counts: () => ({ sourceCalls, platformCalls }),
    refresh: () => revision++,
    revoke: () => {
      admitted = false;
    },
  };
}
describe("prepared resource context", () => {
  it("rejects malformed platform skill metadata before publication", async () => {
    const f = fixture();
    let writes = 0;
    const result = await prepareResourceContext({
      ...f.options,
      loadPlatform: () => okAsync([file("/opt/pi-orb/skills/bad/SKILL.md", "missing metadata")]),
      platformStore: {
        get: () => okAsync(null),
        put: () => {
          writes++;
          return okAsync(undefined);
        },
      },
    });
    expect(result.isErr()).toBe(true);
    expect(writes).toBe(0);
  });
  it("restores pinned repository and all platform bytes offline but refreshes managed prompts", async () => {
    const f = fixture();
    const first = (await prepareResourceContext(f.options))._unsafeUnwrap();
    expect(first.instructions).toEqual([{ path: "AGENTS.md", content: "repo rules" }]);
    expect(first.skills.map((s) => s.name)).toEqual(["x", "hosting"]);
    expect(first.reader.contains("/opt/pi-orb/skills/hosting/script.sh")).toBe(true);
    f.refresh();
    const second = (await prepareResourceContext(f.options))._unsafeUnwrap();
    expect(second.managed.personal.content).toBe("personal 2");
    expect(second.commitSha).toBe(first.commitSha);
    expect(f.counts()).toEqual({ sourceCalls: 1, platformCalls: 1 });
  });
  it("adopts changed application platform versions without repinning repository", async () => {
    const f = fixture();
    await prepareResourceContext(f.options);
    await prepareResourceContext({ ...f.options, platformVersion: "v2" });
    expect(f.counts()).toEqual({ sourceCalls: 1, platformCalls: 2 });
  });
  it("rejects revoked admission at the publication checkpoint", async () => {
    const f = fixture();
    const value = await prepareResourceContext({
      ...f.options,
      checkpoint: () => {
        f.revoke();
        return okAsync(undefined);
      },
    });
    expect(value.isErr()).toBe(true);
  });
  it("never returns context after cancellation during restore", async () => {
    const f = fixture();
    const abort = new AbortController();
    expect(
      (
        await prepareResourceContext({
          ...f.options,
          signal: abort.signal,
          managed: () => {
            abort.abort();
            return f.options.managed();
          },
        })
      ).isErr(),
    ).toBe(true);
  });
});
