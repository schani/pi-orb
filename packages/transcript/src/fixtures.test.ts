import { readdirSync, readFileSync } from "node:fs";
import { type HistoryRecord, HistoryRecordSchema, ServerFrameSchema } from "@pi-orb/protocol";
import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import { serializeState, serializeTurns } from "./serialize.ts";
import { initialState, reducer, type TranscriptAction } from "./state.ts";

interface Step {
  action: TranscriptAction;
  expect?: Record<string, unknown>;
}

interface StateFixture {
  name: string;
  steps: Step[];
  expect: Record<string, unknown>;
}

interface GroupingFixture {
  name: string;
  records: HistoryRecord[];
  expect: Record<string, unknown>;
}

function loadFixtures<T>(directory: string): { file: string; fixture: T }[] {
  const root = new URL(`../fixtures/${directory}/`, import.meta.url);
  return readdirSync(root)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => ({
      file,
      fixture: JSON.parse(readFileSync(new URL(file, root), "utf8")) as T,
    }));
}

function replay(fixture: StateFixture): void {
  let state = initialState();
  fixture.steps.forEach((step, index) => {
    const where = `${fixture.name} step ${index} (${step.action.type})`;
    if (step.action.type === "frame") {
      expect(Check(ServerFrameSchema, step.action.frame), `${where}: invalid ServerFrame`).toBe(
        true,
      );
    }
    state = reducer(state, step.action);
    expect(state, `${where}: unknown action`).toBeDefined();
    if (step.expect !== undefined) {
      expect(serializeState(state), where).toMatchObject(step.expect);
    }
  });
  expect(serializeState(state), fixture.name).toEqual(fixture.expect);
}

for (const directory of ["state"]) {
  describe(`transcript fixtures: ${directory}`, () => {
    const fixtures = loadFixtures<StateFixture>(directory);
    it("has fixtures", () => expect(fixtures.length).toBeGreaterThan(0));
    for (const { file, fixture } of fixtures) {
      it(`${file}: ${fixture.name}`, () => replay(fixture));
    }
  });
}

describe("transcript fixtures: grouping", () => {
  const fixtures = loadFixtures<GroupingFixture>("grouping");
  it("has fixtures", () => expect(fixtures.length).toBeGreaterThan(0));
  for (const { file, fixture } of fixtures) {
    it(`${file}: ${fixture.name}`, () => {
      for (const [index, record] of fixture.records.entries()) {
        expect(
          Check(HistoryRecordSchema, record),
          `${fixture.name} record ${index}: invalid HistoryRecord`,
        ).toBe(true);
      }
      expect(serializeTurns(fixture.records), fixture.name).toEqual(fixture.expect);
    });
  }
});
