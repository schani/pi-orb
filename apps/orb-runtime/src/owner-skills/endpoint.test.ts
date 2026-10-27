import { OwnerSkillsSnapshotSchema } from "@pi-orb/protocol";
import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { fetchOwnerSkills } from "./endpoint.ts";

const env = { controlPlaneUrl: "https://control.invalid", runtimeToken: "secret" };
const snapshot = {
  skills: [
    {
      name: "mine",
      content: "root",
      source: { url: "https://github.com/o/r/tree/main/s", commitSha: "a".repeat(40) },
      files: [{ path: "assets/a.png", base64: "iVBORw0KGgoA/w==", executable: true }],
    },
  ],
};

it("fetches the complete pinned snapshot with runtime authentication", async () => {
  const result = await fetchOwnerSkills(env, async (url, init) => {
    expect(String(url)).toBe("https://control.invalid/runtime/v1/owner-skills");
    expect(init?.headers).toEqual({ authorization: "Bearer secret" });
    return Response.json(snapshot);
  });
  expect(result._unsafeUnwrap()).toEqual(snapshot);
  expect(Check(OwnerSkillsSnapshotSchema, result._unsafeUnwrap())).toBe(true);
});

it("maps sync/rejected fetches, HTTP errors and malformed snapshots to visible typed errors", async () => {
  for (const fetcher of [
    () => {
      throw new Error("secret");
    },
    async () => Promise.reject(new Error("secret")),
    async () => new Response("", { status: 503 }),
    async () => new Response("{"),
    async () => Response.json({ skills: [{ name: "old", content: "missing files" }] }),
  ]) {
    const result = await fetchOwnerSkills(env, fetcher);
    expect(result.isErr() && result.error.type).toBe("owner_skills_fetch_error");
    expect(result.isErr() && result.error.message).not.toContain("secret");
  }
});

it("bounds streamed owner snapshot responses before JSON parsing", async () => {
  let produced = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      produced++;
      controller.enqueue(new Uint8Array(1024 * 1024));
    },
  });
  const result = await fetchOwnerSkills(env, async () => new Response(body));
  expect(result.isErr()).toBe(true);
  expect(produced).toBeLessThanOrEqual(26);
});
