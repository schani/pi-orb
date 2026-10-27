import type { OwnerSkillList } from "@pi-orb/protocol";
import { ok, type Result } from "neverthrow";
import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0 }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => {
    const index = state.cursor++;
    if (index === state.slots.length) state.slots.push(initial);
    return [
      state.slots[index],
      (next: unknown) => {
        state.slots[index] = typeof next === "function" ? next(state.slots[index]) : next;
      },
    ] as const;
  };
  return {
    ...react,
    useState: slot,
    useRef: (initial: unknown) => slot({ current: initial })[0],
    useEffect: () => {},
  };
});
vi.mock("../lib/api.ts", async (original) => ({
  ...(await original<typeof import("../lib/api.ts")>()),
  listOwnerSkills: vi.fn(),
  previewOwnerSkill: vi.fn(),
  importOwnerSkill: vi.fn(),
}));

import { type ApiError, importOwnerSkill, listOwnerSkills, previewOwnerSkill } from "../lib/api.ts";
import { useOwnerSkills } from "./OwnerSkillsSettings.tsx";

beforeEach(() => {
  state.slots = [];
  state.cursor = 0;
  vi.clearAllMocks();
});
const render = () => {
  state.cursor = 0;
  return useOwnerSkills({ current: null });
};

it("does not let a list requested during import replace the completed write", async () => {
  const url = "https://github.com/example/skills/tree/main/handbook";
  const source = { url, commitSha: "a".repeat(40) };
  const item = {
    name: "handbook",
    description: "Write manuals.",
    content: "root",
    source,
    fileCount: 1,
    totalBytes: 4,
    updatedAt: "",
  };
  let releaseList!: (value: Result<OwnerSkillList, ApiError>) => void;
  let releaseImport!: (value: Result<OwnerSkillList, ApiError>) => void;
  const delayedList = new Promise<Result<OwnerSkillList, ApiError>>((resolve) => {
    releaseList = resolve;
  });
  const delayedImport = new Promise<Result<OwnerSkillList, ApiError>>((resolve) => {
    releaseImport = resolve;
  });
  vi.mocked(listOwnerSkills)
    .mockResolvedValueOnce(ok({ items: [] }))
    .mockReturnValueOnce(delayedList);
  vi.mocked(previewOwnerSkill).mockResolvedValue(
    ok({ ...item, manifest: [{ path: "SKILL.md", bytes: 4, executable: false }] }),
  );
  vi.mocked(importOwnerSkill).mockReturnValue(delayedImport);
  await render().load();
  render().setDraft("+new", "");
  render().changeSource("github");
  render().changeUrl(url);
  await render().review();
  const importing = render().addImport();
  expect(render().saving).toBe(true);
  const loading = render().load();
  releaseImport(ok({ items: [item] }));
  await importing;
  releaseList(ok({ items: [] }));
  await loading;
  expect(render().items).toEqual([item]);
  expect(listOwnerSkills).toHaveBeenCalledTimes(1);
});
