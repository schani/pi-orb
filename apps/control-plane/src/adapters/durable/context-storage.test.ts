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
      skills: [],
    })
  )._unsafeUnwrap();
  expect((await context.platform())._unsafeUnwrap()).toEqual(platform);
  (
    await context.save(platform, {
      personal: { revision: 3, content: "latest" },
      project: { revision: 2, content: "project" },
      skills: [{ name: "mine", content: "---\nname: mine\ndescription: d\n---\n" }],
    })
  )._unsafeUnwrap();
  const managed = (
    await new NativeResourceContext(storage, () => okAsync(undefined)).managed()
  )._unsafeUnwrap();
  expect(managed?.personal).toEqual({ revision: 3, content: "latest" });
  expect(managed?.skills).toEqual([
    { name: "mine", content: "---\nname: mine\ndescription: d\n---\n" },
  ]);
});
