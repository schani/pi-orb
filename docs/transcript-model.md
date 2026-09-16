# Shared transcript model

`@pi-orb/transcript` (`packages/transcript`) holds the client-side model of one
orb conversation: pure TypeScript over `@pi-orb/protocol` types, with no React,
no DOM and no browser globals. Extracted 2026-09-16 so a planned native macOS
client can be ported from the same rules and proved equivalent against the same
fixtures, instead of re-deriving them from a React page.

## What lives there

- **Reduction.** `TranscriptState`, `TranscriptAction`, `initialState`,
  `reducer`, `isLiveBusy`: the record map, sync/connection bookkeeping, live
  output blocks, tool chips, subagent roster, settings, composer and request
  state driven by `ServerFrame`s and client actions.
- **History handoff.** `snapshotFromHistory`, `TranscriptCache`,
  `canRepairFromReplica`, `mergeReplicatedHistory` (`docs/transcript-cache.md`,
  `docs/history-replication.md`).
- **Inbox reconciliation.** `messagesAwaitingHistory`, `withQueuedMessage`, the
  mutation epoch and the `inboxMessageIds` retirement rules.
- **Presentation structure.** `groupTurns`, `splitAgentRecords`,
  `assistantFailure`, `isDisplayedCustomMessage`,
  `isSubagentNotice`, and the tool-call classification: `activityCalls`,
  `categorize`, `categoryHeadline`, `categoryCount`, `categoryProgress`,
  `patchStats`. These return plain data; the web components only render it.

The model reads only typed record fields — `shell`, `custom`, `subagent`,
`inboxMessageIds`, `failure`, `patch` — never `overflow.native`, which belongs
to the harness adapter alone (`docs/pi-adapter.md`).
`packages/transcript/src/native-fields.contract.test.ts` pins that.

The browser keeps what is genuinely its own: the WebSocket adapter
(`apps/web/src/lib/live.ts`), the HTTP client and its `ApiError` taxonomy, the
`sessionStorage` composer draft, notifications, favicons and every component.
`historyError` in the model is an already-described message, so no client's
transport error type leaks into the shared state.

## Fixture corpus

`packages/transcript/fixtures/` is the parity contract. Any other
implementation of this model must replay the corpus and produce the same
serialized output; `packages/transcript/src/fixtures.test.ts` does so for the
TypeScript one. The files are plain JSON and deliberately language-neutral.

`serializeState(state)` and `serializeTurns(records)` define the comparison
surface: JSON only, maps as insertion-ordered arrays, absent optional fields as
`null`, no functions.

**State fixtures** (`fixtures/state/`, `fixtures/generated/`):

```json
{
  "name": "welcome then a full sync loads the transcript",
  "steps": [
    { "action": { "type": "connection_status", "status": "open" } },
    { "action": { "type": "frame", "frame": { "v": 1, "at": "…", "type": "server.welcome", "…": "…" } },
      "expect": { "sessionId": "s1" } }
  ],
  "expect": { "records": [], "sessionId": "s1", "…": "…" }
}
```

Actions are exactly the reducer's action union and frames are exactly
`ServerFrame`, so the runner validates every frame against `ServerFrameSchema`
and fails on protocol drift. A step's `expect` is a partial match on the
serialized state — objects match a subset of keys, arrays must have the same
length and match element-wise. The fixture's own `expect` is the exact final
state.

**Grouping fixtures** (`fixtures/grouping/`):

```json
{
  "name": "prose breaks a tool run",
  "records": [{ "id": "a1", "…": "…" }],
  "expect": { "turns": [], "representedMessageIds": [], "persistedToolCallIds": [] }
}
```

Records are validated against `HistoryRecordSchema` and compared exactly.

## Generated fixtures

`packages/transcript/src/generator.test.ts` builds forty frame interleavings
from seeded `determined` entropy (`src/testkit/entropy.ts`) and asserts the
model's invariants on every step:

- every record is keyed by its own id, and live frames append in arrival order
  (an authoritative replica read re-seeds that order — PostgreSQL history is a
  prefix, `docs/history-replication.md`);
- a finished operation leaves no live blocks, tool chips, operation id or
  roster behind;
- a connection transition never drops the transcript;
- re-delivering a `history.record` frame changes nothing.

Seeds are fixed, so the suite is deterministic and a failure names the seed
that reproduces it. The first five seeds are committed as replayable fixtures;
regenerate them with:

```
TRANSCRIPT_FIXTURES_WRITE=1 npx vitest run packages/transcript/src/generator.test.ts
```

A regenerated file that differs is a behavior change, and must be reviewed as
one.
