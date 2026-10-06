import { readFileSync } from "node:fs";
import { okAsync } from "neverthrow";
import { expect, it, vi } from "vitest";
import { artifactCreateSource, artifactReadSource } from "./testkit/durable-artifact-restart.ts";
import { gatedResourceSource } from "./testkit/resource-source-fixture.ts";

it("reports gated resource settlement without changing snapshot results", async () => {
  const urls: URL[] = [];
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    urls.push(new URL(String(input)));
    return new Response("released");
  });
  const snapshot = {
    orbId: "fixture",
    commitSha: "a".repeat(40),
    instructionPath: null,
    skillRoot: null,
    files: [],
  };
  try {
    const result = await gatedResourceSource(
      { acquire: () => okAsync(snapshot) },
      "http://fixture/gate?reportOutcome=1",
    ).acquire({
      orbId: "fixture",
      url: "https://github.com/fixture/repo",
      signal: new AbortController().signal,
    });
    expect(result.isOk() && result.value).toEqual(snapshot);
    expect(urls).toHaveLength(2);
    expect(urls[1]?.searchParams.get("phase")).toBe("settled");
    expect(urls[1]?.searchParams.get("outcome")).toBe("ready");
  } finally {
    fetchMock.mockRestore();
  }
});

it("reports cancelled acquisition independently of its aborted signal", async () => {
  const controller = new AbortController();
  const acquire = vi.fn(() =>
    okAsync({
      orbId: "fixture",
      commitSha: "a".repeat(40),
      instructionPath: null,
      skillRoot: null,
      files: [],
    }),
  );
  const urls: URL[] = [];
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    urls.push(url);
    if (url.searchParams.get("phase") !== "settled") {
      controller.abort();
      throw new Error("fixture cancelled gate");
    }
    expect(init?.signal).toBeUndefined();
    return new Response("settled");
  });
  try {
    const result = await gatedResourceSource(
      { acquire },
      "http://fixture/gate?reportOutcome=1",
    ).acquire({
      orbId: "fixture",
      url: "https://github.com/fixture/repo",
      signal: controller.signal,
    });
    expect(result.isErr() && result.error.code).toBe("cancelled");
    expect(acquire).not.toHaveBeenCalled();
    expect(urls[1]?.searchParams.get("outcome")).toBe("cancelled");
  } finally {
    fetchMock.mockRestore();
  }
});

it("spills a bounded fixture payload whose selected marker lies outside the excerpt", () => {
  const outputs: string[] = [];
  Function("text", artifactCreateSource)((value: unknown) => outputs.push(String(value)));
  const payload = outputs.join("");
  expect(payload.length).toBeGreaterThan(100_000);
  expect(payload.length).toBeLessThan(256 * 1024);
  expect(payload.split("\n")[119]).toBe("RETAINED_PRIVATE_SPILL_MARKER");
  expect(payload.slice(0, 4096)).not.toContain("RETAINED_PRIVATE_SPILL_MARKER");
  expect(artifactCreateSource).toContain('"max_output_tokens":128');
});

it("reads the persisted artifact selectively using the surfaced private path", () => {
  const path = "/orb-artifacts/12345678-1234-1234-1234-123456789abc";
  const source = artifactReadSource(path);
  expect(source).toContain(`path:${JSON.stringify(path)}, offset:120, limit:1`);
  expect(source).toContain(".agents/skills/pinned/asset.txt");
  expect(source).not.toContain("tools.bash");
});

it("keeps Abort ACK ahead of source release and asserts inbox settlement, not host shutdown", () => {
  const source = readFileSync(new URL("./durable-independent-fixture.ts", import.meta.url), "utf8");
  const branch = source.slice(
    source.indexOf('if (cancellation === "git-abort")'),
    source.indexOf('if (cancellation === "git-stop")'),
  );
  expect(branch.indexOf("Abort ACK before resource acquisition completes")).toBeLessThan(
    branch.indexOf('resourceHeld?.end("late resource release after Abort ACK")'),
  );
  expect(branch).toContain('item.status !== "queued" && item.status !== "delivering"');
  expect(branch).toContain('view.body["activity"] === "idle"');
  expect(branch).toContain("forceReconcilePass");
  expect(branch).not.toContain('toBe("stopped")');
});
