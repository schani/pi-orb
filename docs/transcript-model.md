# Shared transcript model

`@pi-orb/transcript` (`packages/transcript`) holds the client-side model of one
orb conversation: pure TypeScript over `@pi-orb/protocol` types, with no React,
no DOM and no browser globals. Extracted 2026-09-16 so a planned native macOS
client can be ported from the same rules and checked against shared fixture
scenarios, instead of re-deriving them from a React page.

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
- **Presentation.** `presentTranscript({ records, liveBlocks, tools,
  queuedMessages, busy })` returns the ordered `PresentedRow[]` a client
  renders: turns, the live tail attached to the final agent turn or standing
  alone, the tool activity of each turn already deduplicated against committed
  calls, the queued inbox rows that survive retirement, live shell rows and the
  busy marker. A presented block also carries `copySource`: the response's raw
  Markdown on the one block that hosts its copy action, `null` everywhere else
  (`docs/web-ui.md`). It is the rendering contract — no client repeats any of
  those decisions. Its building blocks (`groupTurns`, `splitAgentRecords`,
  `assistantFailure`, `assistantResponseMarkdown`, `isDisplayedCustomMessage`,
  `isSubagentNotice`, `activityCalls`, `categorize`, `categoryHeadline`,
  `categoryCount`, `categoryProgress`, `patchStats`) stay exported for direct
  use.

The model reads only typed record fields — `shell`, `custom`, `subagent`,
`inboxMessageIds`, `failure`, `patch` — never `overflow.native`, which belongs
to the harness adapter alone (`docs/pi-adapter.md`).
`packages/transcript/src/native-fields.contract.test.ts` pins that.

The browser keeps what is genuinely its own: the WebSocket adapter
(`apps/web/src/lib/live.ts`), the HTTP client and its `ApiError` taxonomy, the
`sessionStorage` composer draft, notifications, favicons, and the components
that turn each presented row into DOM — `HistoryView` maps rows to elements and
decides nothing else. `historyError` in the model is an already-described
message, so no client's transport error type leaks into the shared state.

## Fixture corpus

`packages/transcript/fixtures/` pins represented reducer/model behavior and
selected presentation structure for its scenarios. Another implementation can
replay the corpus and compare those projections exactly;
`packages/transcript/src/fixtures.test.ts` does so for TypeScript. A match does
not establish complete model equivalence or rendering fidelity. The files are
plain JSON and deliberately language-neutral.

`serializeState(state, queuedMessages)`, `serializeTurns(records)`,
`serializeInbox(...)` and `serializeCache(cache)` define the comparison
surface. Equality is structural JSON equality, not byte identity. Maps become
insertion-ordered arrays, and only explicitly projected optional fields become
`null`; nested protocol objects included directly preserve their shapes. The
presentation projection omits image data and URLs, tool arguments, and
interpreted subagent details. Raw records and state fields still carry that
information where applicable. Five kinds of fixture share the surface:
`state/`, `generated/`, `grouping/`, `inbox/` and `cache/`.

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
state projection, compared structurally.

The serialized state's `presentation` key projects `presentTranscript` for that
state. It pins structural decisions in the covered scenarios: which live tools
survive deduplication, whether live output continues the final turn, and which
queued rows remain. An optional top-level `queuedMessages` array supplies the
inbox rows the client holds while replaying; the corpus presents a running orb,
so `busy` follows the connection and activity the frames establish.

**Grouping fixtures** (`fixtures/grouping/`):

```json
{
  "name": "prose breaks a tool run",
  "records": [{ "id": "a1", "…": "…" }],
  "expect": { "turns": [], "representedMessageIds": [], "persistedToolCallIds": [] }
}
```

Records are validated against `HistoryRecordSchema`; their fixture projection
is compared structurally. `turns` is the presentation projection for records
alone, with no live input.

**Inbox fixtures** (`fixtures/inbox/`):

```json
{
  "name": "a failed message stays visible even once a record represents it",
  "inboxMessages": [{ "id": "m1", "…": "…" }],
  "records": [{ "id": "u1", "…": "…" }],
  "append": [{ "id": "m2", "…": "…" }],
  "expect": {
    "represented": ["m1"],
    "awaitingHistory": ["m1"],
    "deliveredAwaitingHistory": false,
    "afterAppend": [{ "id": "m1", "status": "failed", "delivery": null }]
  }
}
```

`messagesAwaitingHistory` retires only *delivered* rows at their record, while
`presentTranscript` drops every represented row: the inbox keeps a failed
message as a terminal resource, the transcript stops showing it once its record
arrives. `append` applies `withQueuedMessage` in order.

**Cache fixtures** (`fixtures/cache/`):

```json
{
  "name": "only the current owner may publish, clear or release",
  "limits": { "maxEntries": 2 },
  "steps": [
    { "op": "acquire", "args": { "owner": "first", "orbId": "a", "projectId": "p1" } },
    { "op": "publish",
      "args": { "owner": "first", "snapshot": { "sessionId": "s1", "records": [{ "id": "r1", "text": "hello" }], "afterRecordId": "r1", "headId": "r1" } },
      "expect": { "admission": "stale" } }
  ],
  "expect": { "entries": [], "owners": 1, "invalidationEpoch": 0 }
}
```

Owners are named rather than held, so no fixture carries a closure. A snapshot
names its records by id and text; the runner builds one assistant message
record per entry with timestamp `2026-09-16T00:00:00Z`, no parent and empty
overflow. The fixtures cover portable behavior: owner freshness, admission
consistency, full-sync clearing and session replacement, entry-count LRU
and the invalidation fence. Cache fixtures do not compare byte estimation,
byte-budget eviction or oversize rejection; those remain TypeScript
implementation tests because they use a JavaScript heap heuristic.

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
- re-delivering a `history.record` frame changes nothing;
- no call id appears twice in the presented activity, so a committed tool call
  always owns its chip.

Seeds are fixed, so the suite is deterministic and a failure names the seed
that reproduces it. The first five seeds are committed as replayable fixtures;
regenerate them with:

```
TRANSCRIPT_FIXTURES_WRITE=1 npx vitest run packages/transcript/src/generator.test.ts
```

A regenerated file that differs is a behavior change, and must be reviewed as
one.
