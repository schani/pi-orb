import { okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { OrbAgentManager } from "./manager.ts";

it("unloads optional ownership without closing future admissions", async () => {
  let opened = 0;
  const closed: number[] = [];
  const manager = new OrbAgentManager<number>({
    open: () => okAsync(++opened),
    close: (value) => {
      closed.push(value);
      return okAsync(undefined);
    },
  });
  expect((await manager.ensure("orb", 1))._unsafeUnwrap()).toBe(1);
  expect((await manager.unload("orb", () => okAsync(false)))._unsafeUnwrap()).toBe(false);
  expect(closed).toEqual([]);
  expect((await manager.unload("orb", () => okAsync(true)))._unsafeUnwrap()).toBe(true);
  expect(closed).toEqual([1]);
  expect((await manager.ensure("orb", 1))._unsafeUnwrap()).toBe(2);
  await manager.close();
});
