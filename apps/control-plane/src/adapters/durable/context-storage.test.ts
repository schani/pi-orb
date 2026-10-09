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
    })
  )._unsafeUnwrap();
  expect((await context.platform())._unsafeUnwrap()).toEqual(platform);
  (
    await context.save(platform, {
      personal: { revision: 3, content: "latest" },
      project: { revision: 2, content: "project" },
    })
  )._unsafeUnwrap();
  expect(
    (await new NativeResourceContext(storage, () => okAsync(undefined)).managed())._unsafeUnwrap()
      ?.personal,
  ).toEqual({ revision: 3, content: "latest" });
});
