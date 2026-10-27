import { MemoryStorage } from "@earendil-works/pi-durable";
import { okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { NativeResourceContext } from "./context-storage.ts";

it("stores managed revisions and bundled resources together, separately from immutable Git files", async () => {
  const storage = new MemoryStorage();
  const context = new NativeResourceContext(storage, () => okAsync(undefined));
  const platform = { version: "v1", files: [] };
  (
    await context.save(platform, {
      personal: { revision: 1, content: "one" },
      project: { revision: 2, content: "project" },
      skills: [
        {
          name: "pinned",
          content: "root",
          source: { url: "https://github.com/o/r/tree/main/s", commitSha: "a".repeat(40) },
          files: [{ path: "assets/a.png", base64: "iVBORw0KGgoA/w==", executable: true }],
        },
      ],
    })
  )._unsafeUnwrap();
  expect((await context.platform())._unsafeUnwrap()).toEqual(platform);
  (
    await context.save(platform, {
      personal: { revision: 3, content: "latest" },
      project: { revision: 2, content: "project" },
      skills: [
        {
          name: "pinned",
          content: "root",
          source: { url: "https://github.com/o/r/tree/main/s", commitSha: "a".repeat(40) },
          files: [{ path: "assets/a.png", base64: "iVBORw0KGgoA/w==", executable: true }],
        },
      ],
    })
  )._unsafeUnwrap();
  expect(
    (await new NativeResourceContext(storage, () => okAsync(undefined)).managed())._unsafeUnwrap()
      ?.personal,
  ).toEqual({ revision: 3, content: "latest" });
});

it("captures supporting bytes, executable bits and source in the existing managed snapshot", async () => {
  const storage = new MemoryStorage();
  const context = new NativeResourceContext(storage, () => okAsync(undefined));
  const skills = [
    {
      name: "x",
      content: "root",
      files: [{ path: "x.bin", base64: "AP8=", executable: true }],
      source: { url: "https://github.com/o/r/tree/main/s", commitSha: "b".repeat(40) },
    },
  ];
  (
    await context.save(
      { version: "v1", files: [] },
      { personal: { content: "", revision: 0 }, project: { content: "", revision: 0 }, skills },
    )
  )._unsafeUnwrap();
  skills[0]!.files[0]!.base64 = "changed";
  expect(
    (await new NativeResourceContext(storage, () => okAsync(undefined)).managed())._unsafeUnwrap()
      ?.skills[0]?.files,
  ).toEqual([{ path: "x.bin", base64: "AP8=", executable: true }]);
});
