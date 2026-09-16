import { readdirSync, readFileSync } from "node:fs";
import {
  type HistoryRecord,
  HistoryRecordSchema,
  type OrbMessageView,
  OrbMessageViewSchema,
  ServerFrameSchema,
} from "@pi-orb/protocol";
import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import { serializeCache, serializeInbox, serializeState, serializeTurns } from "./serialize.ts";
import { initialState, reducer, type TranscriptAction } from "./state.ts";
import {
  type CachedTranscript,
  TranscriptCache,
  type TranscriptOwner,
} from "./transcript-cache.ts";

interface Step {
  action: TranscriptAction;
  expect?: Record<string, unknown>;
}

interface StateFixture {
  name: string;
  /** Inbox rows the client holds while replaying; retirement is presentation. */
  queuedMessages?: OrbMessageView[];
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
  const queued = fixture.queuedMessages ?? [];
  for (const [index, message] of queued.entries()) {
    expect(
      Check(OrbMessageViewSchema, message),
      `${fixture.name} message ${index}: invalid OrbMessageView`,
    ).toBe(true);
  }
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
      expect(serializeState(state, queued), where).toMatchObject(step.expect);
    }
  });
  expect(serializeState(state, queued), fixture.name).toEqual(fixture.expect);
}

for (const directory of ["state", "generated"]) {
  describe(`transcript fixtures: ${directory}`, () => {
    const fixtures = loadFixtures<StateFixture>(directory);
    it("has fixtures", () => expect(fixtures.length).toBeGreaterThan(0));
    for (const { file, fixture } of fixtures) {
      it(`${file}: ${fixture.name}`, () => replay(fixture));
    }
  });
}

function checkRecords(name: string, records: readonly HistoryRecord[]): void {
  for (const [index, record] of records.entries()) {
    expect(
      Check(HistoryRecordSchema, record),
      `${name} record ${index}: invalid HistoryRecord`,
    ).toBe(true);
  }
}

describe("transcript fixtures: grouping", () => {
  const fixtures = loadFixtures<GroupingFixture>("grouping");
  it("has fixtures", () => expect(fixtures.length).toBeGreaterThan(0));
  for (const { file, fixture } of fixtures) {
    it(`${file}: ${fixture.name}`, () => {
      checkRecords(fixture.name, fixture.records);
      expect(serializeTurns(fixture.records), fixture.name).toEqual(fixture.expect);
    });
  }
});

interface InboxFixture {
  name: string;
  inboxMessages: OrbMessageView[];
  records: HistoryRecord[];
  append?: OrbMessageView[];
  expect: Record<string, unknown>;
}

describe("transcript fixtures: inbox", () => {
  const fixtures = loadFixtures<InboxFixture>("inbox");
  it("has fixtures", () => expect(fixtures.length).toBeGreaterThan(0));
  for (const { file, fixture } of fixtures) {
    it(`${file}: ${fixture.name}`, () => {
      for (const [index, message] of [
        ...fixture.inboxMessages,
        ...(fixture.append ?? []),
      ].entries()) {
        expect(
          Check(OrbMessageViewSchema, message),
          `${fixture.name} message ${index}: invalid OrbMessageView`,
        ).toBe(true);
      }
      checkRecords(fixture.name, fixture.records);
      expect(
        serializeInbox(fixture.inboxMessages, fixture.records, fixture.append ?? []),
        fixture.name,
      ).toEqual(fixture.expect);
    });
  }
});

/** A cache fixture names a snapshot's records; the runner builds them identically. */
interface FixtureSnapshot {
  sessionId: string | null;
  records: { id: string; text: string }[];
  afterRecordId: string | null;
  headId: string | null;
}

interface CacheStep {
  op: "acquire" | "publish" | "clear" | "release" | "get" | "invalidate" | "invalidate_project";
  args: Record<string, string | null | FixtureSnapshot>;
  expect?: unknown;
}

interface CacheFixture {
  name: string;
  limits?: { maxEntries?: number };
  steps: CacheStep[];
  expect: Record<string, unknown>;
}

function cacheRecord(id: string, text: string): HistoryRecord {
  return {
    id,
    parentId: null,
    timestamp: "2026-09-16T00:00:00Z",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    overflow: {},
  };
}

function cacheSnapshot(fixtureName: string, snapshot: FixtureSnapshot): CachedTranscript {
  const records = snapshot.records.map((record) => cacheRecord(record.id, record.text));
  checkRecords(fixtureName, records);
  return {
    sessionId: snapshot.sessionId,
    records: new Map(records.map((record) => [record.id, record])),
    afterRecordId: snapshot.afterRecordId,
    headId: snapshot.headId,
  };
}

function text(args: CacheStep["args"], key: string): string {
  const value = args[key];
  if (typeof value !== "string") throw new Error(`cache step is missing "${key}"`);
  return value;
}

function runCache(fixture: CacheFixture): void {
  const cache = new TranscriptCache(fixture.limits ?? {});
  const owners = new Map<string, TranscriptOwner>();
  const owner = (name: string): TranscriptOwner => {
    const found = owners.get(name);
    if (found === undefined) throw new Error(`cache step names an unacquired owner "${name}"`);
    return found;
  };
  fixture.steps.forEach((step, index) => {
    const where = `${fixture.name} step ${index} (${step.op})`;
    let observed: unknown;
    switch (step.op) {
      case "acquire":
        owners.set(
          text(step.args, "owner"),
          cache.acquire(text(step.args, "orbId"), text(step.args, "projectId")),
        );
        break;
      case "publish": {
        const snapshot = step.args["snapshot"];
        if (snapshot === null || typeof snapshot !== "object") {
          throw new Error("publish step is missing a snapshot");
        }
        observed = {
          admission: owner(text(step.args, "owner")).publish(cacheSnapshot(fixture.name, snapshot)),
        };
        break;
      }
      case "clear":
        owner(text(step.args, "owner")).clear();
        break;
      case "release":
        owner(text(step.args, "owner")).release();
        break;
      case "get": {
        const hit = cache.get(text(step.args, "orbId"));
        observed = {
          hit:
            hit === undefined
              ? null
              : {
                  sessionId: hit.sessionId,
                  recordIds: [...hit.records.keys()],
                  afterRecordId: hit.afterRecordId,
                  headId: hit.headId,
                },
        };
        break;
      }
      case "invalidate":
        cache.invalidate(text(step.args, "orbId"));
        break;
      case "invalidate_project":
        cache.invalidateProject(text(step.args, "projectId"));
        break;
    }
    if (step.expect !== undefined) expect(observed, where).toEqual(step.expect);
  });
  expect(serializeCache(cache), fixture.name).toEqual(fixture.expect);
}

describe("transcript fixtures: cache", () => {
  const fixtures = loadFixtures<CacheFixture>("cache");
  it("has fixtures", () => expect(fixtures.length).toBeGreaterThan(0));
  for (const { file, fixture } of fixtures) {
    it(`${file}: ${fixture.name}`, () => runCache(fixture));
  }
});
