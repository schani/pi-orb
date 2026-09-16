import { readdirSync, readFileSync } from "node:fs";
import { ServerFrameSchema } from "@pi-orb/protocol";
import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import { serializeState } from "./serialize.ts";
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

function loadFixtures(directory: string): { file: string; fixture: StateFixture }[] {
  const root = new URL(`../fixtures/${directory}/`, import.meta.url);
  return readdirSync(root)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => ({
      file,
      fixture: JSON.parse(readFileSync(new URL(file, root), "utf8")) as StateFixture,
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
    const fixtures = loadFixtures(directory);
    it("has fixtures", () => expect(fixtures.length).toBeGreaterThan(0));
    for (const { file, fixture } of fixtures) {
      it(`${file}: ${fixture.name}`, () => replay(fixture));
    }
  });
}
