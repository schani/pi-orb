import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { OwnerSkillsSnapshot } from "@pi-orb/protocol";
import { errAsync, okAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { ResourceAcquisition, type ResourceSnapshot } from "../../domain/resources.ts";
import { loadPlatformResources } from "./platform-resources.ts";
import { type PersistedPlatformContext, prepareResourceContext } from "./resource-context.ts";

const file = (path: string, text: string) => ({
  path,
  bytes: Buffer.from(text),
  sha256: createHash("sha256").update(text).digest("hex"),
});
function fixture(skills: OwnerSkillsSnapshot["skills"] = []) {
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
    signal: new AbortController().signal,
    platformVersion: "v1",
    acquisition: {
      acquire: () =>
        acquisition.acquire({
          orbId: "orb",
          url: "https://github.com/o/r",
          signal: new AbortController().signal,
        }),
    },
    managed: () =>
      okAsync({
        personal: { content: `personal ${revision}`, revision },
        project: { content: "project", revision },
        skills,
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
  it("fences no-repository platform publication after revoked admission", async () => {
    const f = fixture();
    let writes = 0;
    const result = await prepareResourceContext({
      ...f.options,
      acquisition: { acquire: () => okAsync(null) },
      platformStore: {
        get: () => okAsync(null),
        put: () => {
          writes++;
          return okAsync(undefined);
        },
      },
      checkpoint: () => {
        f.revoke();
        return okAsync(undefined);
      },
    });
    expect(result.isErr()).toBe(true);
    expect(writes).toBe(0);
  });

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
  it("adopts the canonical skill on a platform version change without repinning repository", async () => {
    const f = fixture();
    const first = (await prepareResourceContext(f.options))._unsafeUnwrap();
    const path = "/opt/pi-orb/skills/codemode/SKILL.md";
    expect(first.reader.contains(path)).toBe(false);
    const loadPlatform = () =>
      loadPlatformResources(
        fileURLToPath(new URL("../../../../orb-runtime/skills/", import.meta.url)),
      );
    const second = (
      await prepareResourceContext({
        ...f.options,
        platformVersion: "v2",
        loadPlatform,
      })
    )._unsafeUnwrap();
    const canonical = (await loadPlatform())._unsafeUnwrap().find((file) => file.path === path);
    expect(second.skills.filter((skill) => skill.name === "codemode")).toHaveLength(1);
    expect(Buffer.from((await second.reader.read(path))._unsafeUnwrap())).toEqual(
      Buffer.from(canonical?.bytes ?? []),
    );
    expect(second.commitSha).toBe(first.commitSha);
    expect(f.counts()).toEqual({ sourceCalls: 1, platformCalls: 1 });
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

it("loads valid repository siblings despite malformed YAML, while platform remains strict", async () => {
  const f = fixture();
  const result = await prepareResourceContext({
    ...f.options,
    acquisition: {
      acquire: () =>
        okAsync({
          orbId: "orb",
          commitSha: "a".repeat(40),
          instructionPath: null,
          skillRoot: ".pi/skills",
          files: [
            file(".pi/skills/bad/SKILL.md", "---\ndescription: default-DENY: SECRET\n---\n"),
            file(".pi/skills/good/SKILL.md", "---\nname: good\ndescription: useful\n---\n"),
          ],
        }),
    },
  });
  expect(result.isOk()).toBe(true);
  if (result.isOk()) expect(result.value.skills.map((s) => s.name)).toEqual(["good", "hosting"]);
});

it("ranks platform over owner over repository skills; owner skills read at their own path", async () => {
  const owner = (name: string) => ({
    name,
    files: [],
    source: null,
    content: `---\nname: ${name}\ndescription: owner\n---\nowner ${name}`,
  });
  const f = fixture([owner("x"), owner("hosting"), owner("mine")]);
  const value = (await prepareResourceContext(f.options))._unsafeUnwrap();
  expect(value.skills.map((skill) => [skill.name, skill.description])).toEqual([
    ["mine", "owner"],
    ["x", "owner"],
    ["hosting", "platform skill"],
  ]);
  const path = value.skills.find((s) => s.name === "mine")!.filePath;
  expect(Buffer.from((await value.reader.read(path))._unsafeUnwrap()).toString()).toBe(
    owner("mine").content,
  );
  expect(value.reader.contains("../.pi-orb/owner-skills/hosting/SKILL.md")).toBe(false);
});

it("makes complete owner PNG/script bundles readable at the exact guest paths", async () => {
  const f = fixture([
    {
      name: "images",
      content: "---\nname: images\ndescription: images\n---\n",
      source: null,
      files: [
        { path: "assets/a.png", base64: "iVBORw0KGgoA/w==", executable: false },
        { path: "scripts/run.sh", base64: "IyEvYmluL3NoCg==", executable: true },
      ],
    },
  ]);
  const value = (await prepareResourceContext(f.options))._unsafeUnwrap();
  const root = value.skills.find((s) => s.name === "images")!.baseDir;
  expect(root).toMatch(/^\.\.\/\.pi-orb\/owner-skills\/[a-f0-9]{64}\/images$/);
  expect(
    Buffer.from((await value.reader.read(`${root}/assets/a.png`))._unsafeUnwrap()).toString(
      "base64",
    ),
  ).toBe("iVBORw0KGgoA/w==");
  expect(value.reader.contains(`${root}/scripts/run.sh`)).toBe(true);
});
