# Prompt review

**Decision (2026-10-17, America/Los_Angeles):** a standalone developer app in
`scripts/prompt-browser/` reviews and edits model-facing text in this checkout.
No database, browser storage, inference, commit or deployment endpoints.

## Run and access

Install with `npm ci`, then `npm run prompts`. Default port: 5188;
override with `PORT=5189 npm run prompts`. Open the printed capability URL.
The server binds `127.0.0.1`; the orb's tailnet can expose that listener.

The per-process token stays in the URL fragment and browser memory. Restarting
invalidates it. Anyone with the live link and tailnet access can read and edit
allowlisted prompts. API requests require Bearer authentication and the allowed
Host/port. Writes also require the exact same Origin and JSON Content-Type;
unexpected read Origins are rejected. Responses are no-store/no-referrer; no CORS.
Open tabs retain drafts until explicit reload/discard. A restart cannot recover
unsaved text from another tab.

## Catalogue

**Decision (2026-10-18, America/Los_Angeles):** catalogue active consumers, not
all prose in installed packages. The current inventory has 133 atoms across 40 source files:
central Pi roots/local children, native Claude, separate auxiliary requests,
lifecycle inputs, tool feedback, repository instructions and six bundled skills.
Naming/headline calls serve both harnesses; turn summaries are central completed-
root-operation notifications, not native Claude requests.
Installed Durable tool/compaction/code-mode atoms and Pi's central skill-formatter
atoms are read-only with package provenance. Catalogue completeness is scoped to these
reviewed expressions, not every possible runtime-generated response. Four internal
admission errors are sanitized before model delivery; only the six exact
passed-through admission messages are included.

`scripts/prompt-browser/catalog.ts` identifies expressions by semantic owners and
structural selectors. The API exposes decoded text, titles, categories, scopes,
editability, notes and revisions—not source paths or implementation code.
Skill descriptions and bodies are separate; bodies exclude frontmatter.
Conditional variants remain separate. Protected `{{variable}}` tokens represent
runtime substitutions; prompt code is never evaluated.

**Decision (2026-10-18):** Org environment is the shared checkout prompt, not an
account setting. Central Pi and Claude's known root append receive that base plus
their respective suffix. Preserve the user's exact wording, including
“Do not send progress updates to other orbs unless explicitly asked.” This is
progress-update guidance, not a messaging permission change. The Pi suffix is a
valid empty editable prompt; Claude's suffix directs the agent to CLI help.

Personal/project instructions remain editable in Settings/Config. Selected
pinned repository content, skill inventory/locations, external MCP content,
request values and native Claude internals remain visibly unavailable here.
The checkout's `repository/instructions` atom does not stand in for an unknown
conversation's selected repository content.

Claude uses native repository discovery with user/project/local settings enabled.
The SDK/CLI contract test captures the first provider request: AGENTS.md alone
loads once; CLAUDE.md takes precedence; symlink/import layouts also load once.
[Claude memory documentation](https://code.claude.com/docs/en/memory#agents-md)
documents AGENTS.md support since CLI 2.1.277. Native memory remains an opaque
boundary, not an editable first-party wrapper or a claim about child inheritance.

## Navigation and overlaps

**Decision (2026-10-18):** Up/Down follows visible filtered inventory order from
the page, inventory, Search or Redundant toggle. Bounds do not wrap. Without a
visible selection, Down starts first and Up starts last. Selection scrolls into
view; Search keeps focus, otherwise the selected link receives focus. Drafts,
errors and review state survive navigation. Caret keys, modifiers and IME are
untouched.

Direct informational overlaps use current literal drafts across categories, not
metadata. Narrow named predicates and substantive repeated eight-word clauses
provide conservative evidence, not exhaustive semantic understanding or complete
redundancy. Links are symmetric, ordered, without self-links or transitive
expansion. Empty/dynamic entries provide no evidence. Facts are cached by current
content in browser memory and pruned to the current catalogue.

Hover/focus shows the target's full literal draft in one viewport-contained,
scrollable preview. Pointer/focus can cross into it. Tab enters the preview then
advances; Shift-Tab returns to the trigger. Escape closes and restores focus when
needed. Selection, outside scrolling and resizing close it. Ambiguous titles
include scope. Links retain drafts/errors/review, history and the capability
fragment; modified clicks retain native behavior.

`promptOverlapFacts(content)` and `findPromptOverlaps(entries, id)` are inspectable
exports of the existing `app.js`. Input, revert, reload and save share one path.

## Complete redundancy

**Decision (2026-10-18, America/Los_Angeles):** orange requires positively audited
whole-entry coverage by canonical keepers in the same effective context whenever
the target emits. It does not authorize deleting source instructions or schemas.
The current complete-redundancy list is empty. Initial tool routing and the offered
native tool description have distinct purposes; optional code-mode skill bodies arrive
only on demand and cannot cover initial instructions.

`findPromptRedundancies(entries)` returns `{ id, keeperIds, reason }` in catalogue
order. Audited rules require whole-current-content fingerprints for targets and
keepers, not file revisions or shared-fact subsets. Whitespace is normalized; case,
punctuation, qualifications and placeholders remain significant. Changes fail closed.
Fingerprints use normalized UTF-16 code-unit length plus FNV-1a-128 over UTF-16LE
bytes: a synchronous drift guard, not authentication. Public assets never contain
private prompt snapshots. Keepers must be acyclic and unmarked.

Rejected shortcuts: alternative auxiliary calls/lifecycle outcomes cannot cover
each other; optional skill bodies cannot cover discovery descriptions; an enclosing
template substitutes its body once, not twice. Parameter prose binds API arguments
and is not automatically redundant with a tool description. Unknown/empty content never qualifies; unmarked
does not mean unique.

Redundant filters the existing inventory with Search. Rows, selected headings and
marked overlap links use accessible orange status. Covered by links reuse the full
preview/navigation, without repeating keepers under Overlaps. Tab from the last
keeper preview advances to the first overlap when present. Marks recompute from
drafts on input/revert/reload/save; filtering never discards drafts. Classification
adds no persisted state or endpoint.

## Initial context

**Decision (2026-10-18, America/Los_Angeles):** Atomic / Initial context offers
Root/Subagent and Pi/Claude selectors. Checkout template is source-linked composition,
not a provider capture, deployed prompt or universal aggregation. Subagent means
local leaf delegation; Pi means central Durable.

`composeInitialContext(entries, { harness, role })` is pure and reads current
drafts. Sections identify channels; parts carry atomic IDs, availability,
conditions and derived text. Known text expands once. Atom links open the editor;
Back returns to the template. Drafts/errors/Diff/variant/history survive navigation.
Unknown view/harness/role values preserve the URL and show a specific missing-view
message with a dashboard link. Missing resources/routes follow the same rule.

**Decision (2026-10-18):** Request content and review notes occupy separate columns,
including at 390px. Only known source fragments have a content frame. Source links,
conditions, empty/missing/runtime slots and budget caveats stay outside it. Dashed
frames mark conditional recipes, not guaranteed emission. Protected variables from
that atom's declared variables (plus generated skill locations) are marked as runtime
substitutions; arbitrary literal `{{example}}` text is not. The plain `## orb` header
is a source fragment, not a fixed wire header: runtime budgeting may add a suffix.
The callable reference inventory is not itself a request section; individual entries
may be inline if budget-selected or returned through discovery. Deferred MCP resource
tools remain discovery-only. Source-link previews use full current drafts; empty
sources remain navigable without a blank preview. Focus previews in the long template
open after native focus scrolling. Tab opens the focused link's preview even if a
stationary pointer has hovered another link. Escape cancels pending focus-preview
work after restoring the anchor, so the preview stays closed across animation frames.

Delivery is explicit on each template section and in the selected atom's **When**
row. These are frontend source semantics, not captured payloads or inferred timing
from catalogue position. Empty drafts update to “emits nothing” immediately. Unknown
atoms retain unknown delivery; no backend fields or persisted classification are added.

**Decision (2026-10-18, America/Los_Angeles):** the editor preserves Central Pi's
production order: coding-assistant preamble; personal/selected repository/project
instructions; append-system context; shared environment; Pi suffix; skill metadata.
The pure optional preamble/environment/Pi-suffix overrides change only supplied
text, not default output, ordering or the default skill formatter.

Central Pi's default system section order is `codemode` then `orb-instructions`.
Tool definitions are separate API fields, not the next text in a single linear prompt.
The first request receives applicable context, not this whole page: configuration,
selected resources, budgets and conditional branches determine membership. Later
requests retain context and may add updates, discoveries, skill reads or event inputs.
Unchanged instructions need not create a new history entry; transport continuation
can send only new input, so neither once-only injection nor full retransmission on
every request is promised. Context construction is not live polling of all settings.
Native Claude's known root append is supplied at query launch in source order; the
SDK owns final provider layout/timing, and child inheritance remains unknown.
Atomic delivery labels distinguish selected skill metadata from bodies read/invoked
on demand, tool outcomes, matching lifecycle/input events, separate auxiliary and
compaction requests, and summaries retained after compaction. Those later/separate
inputs are not added to the initial system template.

Central channels:

- System `<codemode>` (UI: **Tool catalogue**): native introduction and budget-selected
  callable declarations, including argument/result schemas, namespace headers/descriptions
  and budget markers. Registered namespace discovery guides and instructions follow
  the declarations in registration order. The local renderer constructs the production
  role extension and calls its section renderer; it never executes a tool or provider.
  Orb description/instruction drafts preserve all other namespace metadata. With no
  configured MCP endpoints, only Orb namespace guidance is present. Resource/external
  tools remain deferred; registered server namespace guides can still be initial.
  Annotated declarations, membership, ordering and runtime server content are marked
  uncaptured rather than replaced by a name-only shortlist.
- System `<orb-instructions>`: coding identity; personal/selected repository/project
  slots; code-mode/time-zone context; shared environment; Pi suffix; formatted skill
  discovery. The child template splices the parent once, then adds same-orb/shared-
  filesystem identity, `notify_parent` instead of `orb_send`, and no child/orb
  spawning. Empty suffixes retain editing links. Skill descriptions are XML-escaped;
  bodies and auxiliary/lifecycle/compaction prompts are not initial context.
- Model tool `functions.codemode.description`: installed native introduction, globals
  and closing sentence, with the production inline-image sentence replacement and
  appended editable `POLICY`. The annotated tools channel composes those source
  fragments without displaying the inactive image-saving sentence as model text.
  The replacement search needle is implementation, not a second prompt atom.
  Grammar/schema and function-fallback parameter prose stay separate. These API
  fields are not appended to Raw exact SYSTEM text.
- Callable descriptions express availability/discovery, not guaranteed initial
  inline membership. Roots exclude `notify_parent`; children exclude orb spawn/alert
  and all five subagent-management operations. MCP resource tools are conditional and discovery-only.

Claude root: opaque native preset/memory/skills/tools, then the known append in
source order: shared environment, Claude suffix, personal, project, conditional
networking and its distinct source-linked timezone. Claude child profile/context/
inheritance/tools remain unknown; root append inheritance is not assumed. No variant
selects an initial task. Central sleep-wake input has its own lifecycle atom,
including the preserved-session/history fact; it is not an initial system section.

Source contracts: `apps/control-plane/src/process-agent-composition.ts`,
`apps/control-plane/src/adapters/durable/{prompt,agent,native-input}.ts`,
`apps/control-plane/src/adapters/durable/tools/{index,codemode}.ts`,
`apps/orb-runtime/src/claude/agent.ts`, installed Durable code-mode/harness builders
and Pi's `formatSkillsForPrompt`.

The six bundled skills are boot-hooks, charts, cloud-identity, codemode-manual,
codemode-quick-reference and hosting. Descriptions are selected discovery metadata;
bodies are read on demand. The production formatter uses its default hint:
“Use the read tool to load a skill's file when the task matches its description.”
No skill files, runtime code-mode behavior or production prompt order change in this
editor feature.

Pi system delivery labels say “From first model request · retained while unchanged;
changes append updates.” This describes context construction, not live polling or a
promise to retransmit all bytes on each request.

**Decision (2026-10-18):** the header's Skills shortcut opens Atomic at the first
available skill body, clears Search/Redundant and scrolls to the Skills heading.
All inventory stays available; the six existing editable bodies and descriptions
remain separate rows. Drafts, errors and Diff state survive the jump, including
from Rendered prompt. Keyboard activation and mobile nav wrapping use the existing
controls and responsive layout.

## Rendered prompt

**Decision (2026-10-18, America/Los_Angeles):** `view=rendered` shows only the
complete initial system text for this checkout and selected local Pi Root/Subagent
configuration. The production renderer supplies tool declarations and schemas,
`<codemode>` / `<orb-instructions>` tags and spacing. Separate API tool
definitions, history and later inputs are not appended. This is not another orb's
capture. Native Claude's full preset is unavailable; rendering fails explicitly,
without substituting its known append or the annotated template.

The scope caption and Root/Subagent, harness and time-zone controls stay outside
one literal, selectable `<pre>`. Local configuration uses this checkout's current
AGENTS.md and all bundled skill metadata/locations, empty personal/project
instructions and no external MCP servers. Time zone defaults to
`America/Los_Angeles`; None sends `null`. No account configuration is fetched.

Opening the mode, changing configuration or pressing Refresh requests a new render.
Reopening applies all current drafts; typing in Atomic does not issue requests.
A newer request or mode exit invalidates older completions and clears the displayed
text. Errors, unsupported configurations and malformed responses show a message,
never a partial fallback. Atomic and annotated Initial context retain drafts,
selection, filters, review/errors and shared harness/role choices across modes.
Unknown view/harness/role URLs retain their address and offer Dashboard.

`POST /api/render` accepts `{ harness, role, timeZone, drafts }`; each dirty editable
draft includes `{ id, content, revision }`. The backend reads unchanged checkout
content. Success is `{ text }`; failures use the existing `{ error: { code,
message } }` envelope. Rendering is read-only: only Atomic's existing Save action
writes repository files. The endpoint uses the same process capability, Host,
Bearer, exact Origin and JSON constraints as Save. No browser storage or persisted
configuration is added.

## Save contract

HTTP adapter → prompt service → source adapter. Fallible boundaries return typed
`neverthrow` Results; filesystem/parsing/JSON failures stay at adapters.

`GET /api/prompts` returns `{ entries: [...] }`.
`PUT /api/prompts/:id` accepts `{ content, revision }` and returns the updated atom.
IDs select allowlisted expressions, never client-selected paths.

Saves rewrite only selected decoded literal/template spans or Markdown bodies,
leaving surrounding code/frontmatter unchanged. Placeholders and dynamic-array
separators stay protected. Missing/ambiguous selectors fail visibly. Content is
capped at 1 MiB; updated code is parsed, never evaluated.

Saves serialize, hash-check, write an exclusive neighboring temporary file,
recheck and rename atomically. Regular non-symlink files must stay within the
allowlist. External editors do not participate in that queue; checks are not a
filesystem-wide transaction. Stale revisions/syntax/write failures remain visible.
After save, unchanged siblings refresh revisions without losing drafts; Save stays
disabled until refresh completes. Changed sibling text still conflicts. Failed
refresh does not undo a confirmed save. Git exposes checkout changes; the app does
not commit, deploy or reload running agents.

## Validation

`npm run test:prompts` runs all focused Node tests and is included in `npm test`.
CI runs these Node contracts explicitly. Browser smoke:
`node --test scripts/prompt-browser/smoke.test.mjs`, run sequentially on E2E shard 1
after browser installation. Both launch paths prefer `PLAYWRIGHT_CHROMIUM_EXECUTABLE`,
then an existing `/usr/bin/chromium`, then Playwright’s managed Chromium.

```sh
npx tsc scripts/prompt-browser/*.ts --noEmit --target es2023 --module nodenext --allowImportingTsExtensions --strict --skipLibCheck --types node --exactOptionalPropertyTypes
npx biome check scripts/prompt-browser
```

**Qualification (2026-10-18, America/Los_Angeles):** independent main-based editor
candidate, base `ce4659db611c73245463855ce2c7b1f3c0da2e06`: 58 Node contracts and all
61 sequential Chromium browser checks pass; control-plane workspace types, focused
editor strict types with `exactOptionalPropertyTypes` and Biome pass.

Tests capture real production Harness fake-provider SYSTEM bytes for root/child,
configured/null timezone, simultaneous dirty drafts and namespace description-only,
instruction-only and combined edits. Separate provider tool-field captures match
the annotated native description, including policy/image prose drafts and empty
strings. Default rendering pins main's order and read formatter. All six code-mode
feedback selectors pin exact delivered messages; every editable atom survives
save/reload without changing sibling text. Only consumed timezone/child atoms are
required. HTTP/pre equality, regenerated schemas, auth/path/conflict bounds,
keyboard/hover/source links, no orange positives, draft retention and desktop/mobile
layouts remain covered.

First failures remain private under
`/workspace/prompt-browser/pr-split-evidence/editor/`. Initial Node failures exposed
the PR-149-only renderer import and stale tags. Browser failures expected environment
after preamble; DOM evidence at both widths proved main's next Tab target is personal
instructions. Only that stale selector changed; strict focus assertions remain.
No new timeout, timing relaxation or passing rerun alone is claimed as a fix.

No live PUT, persistent server restart, heavy/image build or E2E job ran. The two
unexplained 20 MiB image 30s timeouts remain unresolved deployment blockers; focused
editor qualification does not clear them. Earlier combined-head evidence is not
qualification of this independent candidate. CI still runs its normal full gates.
