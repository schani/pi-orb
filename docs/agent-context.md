# Agent context

What each harness puts in front of the model, where it comes from and when it changes; the owner-managed inputs (personal and project instructions, owner skills and secrets, git identity); and model/thinking settings. Pi acquisition details: `docs/pi.md`. Claude native options: `docs/claude.md`.

## Composition

### Pi

`renderPrompt` (`apps/control-plane/src/adapters/durable/prompt.ts`) builds the persisted `orb-instructions` system section, in this order:

| # | Part | Source |
|---|---|---|
| 1 | Preamble: `You are a coding assistant. Use tools to inspect and change the project. Be concise. Produce Markdown. Mermaid is supported.` | fixed |
| 2 | Shared environment prompt | `apps/orb-runtime/src/environment-prompt.ts` |
| 3 | `<project_instructions>`: personal text, then each pinned repository instruction file as `# <path>` + content, then additional project text | managed snapshots + Git pin |
| 4 | Append-system: `Use codemode to compose tool calls.` and, for a known zone, `User’s time zone: {zone}. Present dates and times in this time zone unless they request another.` | `processAgentSystemContext` |
| 5 | Pi environment suffix (empty) | `apps/control-plane/src/adapters/durable/environment-prompt.ts` |
| 6 | Skill metadata (`formatSkillsForPrompt`, indirect): repository skills not shadowed by owner skills, then owner skills, then bundled platform skills | Git pin, owner snapshot, `/opt/pi-orb/skills` |

Children get the same section plus the subagent suffix (`docs/pi.md`). Separate system sections: the native `tool-catalogue` (code-mode callables) and, when the project has MCP servers, `mcp-status` (`MCP <name>: <status>. Namespace: mcp__<name>.` per server, refreshed before each request). Owner and project secrets are environment variables on the execution host, never context.

### Claude

The SDK's `claude_code` system-prompt preset is the preamble. pi-orb's `append` (`apps/orb-runtime/src/claude/agent.ts`), in order:

| # | Part | Source |
|---|---|---|
| 1 | Shared environment prompt | `apps/orb-runtime/src/environment-prompt.ts` |
| 2 | Claude CLI suffix (`## Orb CLI`: `pi-orb` and `--help`) | `apps/orb-runtime/src/claude/environment-prompt.ts` |
| 3 | Personal text | owner snapshot |
| 4 | Additional project text | project snapshot |
| 5 | Port-exposure suffix (`pi-orb expose`) | same file as 2 |
| 6 | `User's time zone: {zone}.` when known | boot context |

Native Claude Code adds the rest: repository `CLAUDE.md`/`CLAUDE.local.md`, otherwise `AGENTS.md` (native rules, CLI ≥2.1.277), via `settingSources: ["user", "project", "local"]` and the checkout `cwd`; repository skills from native project discovery; owner skills materialized into the user skills directory `<workDir>/claude/config/skills` (native personal-over-project precedence); bundled platform skills through a local `pi-orb` plugin linking the skills directory. Repository bodies never enter the append.

### Shared rules

- The shared environment prompt holds facts common to both harnesses (VM tooling, browser use, MCP setup pointer, boot hooks, `orb:` file links, `Do not send progress updates to other orbs unless explicitly asked.`). Pi's suffix is empty because code-mode documents orb tools; Claude's points at CLI `--help` instead of repeating command contracts. Tests pin exact bullets, suffixes, order and exactly-once composition.
- Prompt text changes need user approval.
- Composition order is not a priority mechanism; conflicting instructions are ordinary instruction interpretation.
- No instruction file in the guest or repository is ever rewritten.

## Adoption

Managed text (personal, project) is **captured once per agent context; Stop/Start adopts new text.** Saving never wakes, restarts or interrupts an orb and never sends a message.

- **Pi** captures personal and project snapshots, the owner-skill inventory and the Git pin when the context opens, before the first model request and before execution readiness. The persisted `orb-instructions` section carries that snapshot; it is not reread per generation (`docs/postmortems/2026-10-12-durable-orb-prompt-tail.md`). Explicit Stop/Start recreates the context. Execution-only idle-stop or replacement may keep the central context and its old text. Children inherit the parent's captured context even if the project changed before child admission.
- **Claude** reads everything at each runtime boot, so every host start adopts current text.
- Owner skill **files** are written to the host at every host start from the latest saved data, independent of the Pi context's inventory (below).
- Empty content removes that managed source at the next boundary. Clearing future instructions does not erase conversational memory.
- A failed managed read blocks readiness with a specific typed error (`personal_instructions_unavailable`, `project_instructions_unavailable`, `owner_skills_unavailable`, `git_identity_unavailable`) through the existing orb failure path; never silently empty or stale.
- Luna naming and summary prompts never include managed instructions.

## Personal and project instructions

Two readable Markdown documents: one per user (`~/AGENTS.md` is a scope label, not a file), one per project ("Additional project instructions", supplementing the repository's own `AGENTS.md`).

- **Validation (both):** at most 64 KiB UTF-8; empty and whitespace preserved; NUL and unpaired UTF-16 surrogates rejected.
- **Storage.** Personal: one row per `user_id`; a user without a row reads `{content: "", revision: 0}`. Project: `projects.instructions_content` / `instructions_revision` (migration `020_project_instructions.sql`); bodies are never in fleet/list responses. Each successful PUT atomically replaces content and increments the revision; overflow fails rather than wraps. Last-applied-wins: no CAS, autosave, request replay or history UI. A lost acknowledgement may have committed; a later Save is a new assignment. Project saves conflict once deletion begins.
- **API.** `GET`/`PUT /api/v1/personal-instructions` (`{content}`) for the signed-in user; ops must send `X-Pi-Orb-User-Id` for a known user, and a user principal cannot override itself. `GET`/`PUT /api/v1/projects/:projectId/instructions`; a missing project is a typed 404 ("Project doesn't exist"), never an implicit create. Responses `{content, revision}`, `Cache-Control: no-store`; malformed 400, a project being deleted 409, storage outage 503, inconsistent state 500.
- **Runtime reads.** `GET /runtime/v1/personal-instructions` and `GET /runtime/v1/project-instructions` authenticate the active-incarnation bearer and derive `orb → project → owner`; the viewer and any caller-supplied project ID are irrelevant. One bounded request after bootstrap authentication, before session initialization; no retries, no write route.
- **Editors.** Personal: dashboard gear → Settings → Instructions. Project: project gear → Config → Instructions (tabs General / Instructions / MCPs / Secrets). Raw Markdown, explicit Save, unsaved indication only while dirty. The initial read happens once per opening; a failed read shows Retry, never an editable empty file. While saving, editing, tabs and closing are disabled and focus stays in the dialog; success appears only after acknowledgement as `Saved · next orb start`. Failure keeps the draft. Backdrop clicks do not dismiss; Escape/close return focus to the opener. Drafts live in page memory (project drafts scoped by project) across close/reopen and tab switches, never browser storage; reload or navigation discards them. A clean retained editor stays non-mutable from its activation render until its refresh owns the state, so a refresh cannot clobber an edit. Phone editing uses 16px text. Rejected entry points (footer page, dashboard fold, scope switch, sheets): single entry each.

## Owner skills and secrets

Owner-scoped like personal instructions: they apply to every orb of every project the owner has. Settings tabs: Instructions · Skills · Secrets · Git · Claude.

- **Secrets.** Write-only environment variables with the project-secret name rules, reserved names and limits (`docs/credentials.md`). Owner bundles `{userId, revision, values}` live under GSM parent `pi-orb-credential-user-secrets`; `user_secret_pointers` holds metadata and the exact version. Routes: `GET /api/v1/owner-secrets` (names only), `PUT`/`DELETE /api/v1/owner-secrets/:name` (`{value}`). The runtime secrets route returns owner values overlaid by project values, so **a same-named project secret wins**. MCP bearer references stay project-only. The Secrets tab is the project Secrets component (`ProjectSecretsSettings`) itself.
- **Skills.** `user_skills(user_id, name, content, files, source, updated_at)`, one row per skill, no revision. Name and description come from the root `SKILL.md` frontmatter (Pi's strict YAML parser): name `^[a-z0-9]+(-[a-z0-9]+)*$` ≤64, description ≤1024, root ≤64 KiB, ≤100 skills. Bundled platform names are rejected. The import/store/runtime shape `{skills:[{name,content,files,source}]}` is capped at 8 MiB serialized UTF-8 JSON and 1000 files including roots, under the 16 MiB transport limit. Supporting files are `{path, base64, executable}`; `source` is `{url, commitSha}` with a canonical commit-pinned folder URL (migration 053).
- **API.** `POST /api/v1/owner-skills` accepts `{content}` or `{githubUrl}`; `PUT /api/v1/owner-skills/:name` accepts `{content}`, replacing the root (and renaming in one transaction if the frontmatter name changed) while keeping files and source; `DELETE` removes the bundle. Writes validate the resulting set under a per-owner lock. Lists return root metadata, content and source, never supporting bytes. Rejected: one jsonb row per user (needs CAS), an adoption history record, a shadowing warning, a separate owner-secrets runtime route.
- **GitHub import.** A public `https://github.com/owner/repo/tree/ref/folder` URL is acquired once at save. Anonymous REST resolves branch/tag/SHA longest-first, including slash refs; fallback only on 404 or commit 422 `No commit found for SHA: <candidate>`. At most 32 URL components, 30 s shared deadline, cancellation, no redirects or credentials. Commit/tree SHAs pin traversal; truncated trees, links/gitlinks, unsafe paths, unsupported modes and missing/non-UTF-8 root `SKILL.md` reject. Rate-limit errors are recoverable and visible; private repositories are unsupported. Rejected: preview/refetch at boot (duplicate fetching, mutable gap).
- **Precedence.** Owner skills silently win over same-named repository skills in both harnesses.
- **Delivery.** Each host start loads current saved skills through the authenticated owner-skills runtime endpoint (no GitHub refetch) and materializes them: Pi at off-checkout `<workDir>/owner-skills` (`../owner-skills/<name>`), Claude at `<workDir>/claude/config/skills`. Pi's context reads its inventory and a private snapshot at context open: reads before execution readiness use the snapshot, later reads the host files, so a long-lived context can list older inventory than the host holds. Materialization validates before writing, rejects symlinked managed roots/parents, writes private regular files (0600; executables 0700) and rebuilds only the derived directory. Failures use `owner_skills_unavailable` boot health with normal restart/retry.
- **Editor.** Skills reuse the MCP workbench disclosure: one row per skill expanding to its raw `SKILL.md`, explicit Save, `Saved · next orb start`; an add row accepts Markdown or a GitHub folder URL.

## Git identity

- Settings → Git: `user.name` and `user.email` fields with the Instructions save/Retry/draft behavior (`apps/web/src/components/GitIdentitySettings.tsx`).
- Contract (`packages/protocol/src/git-identity.ts`): `{name, email}`, both empty (cleared) or both set, each ≤256 characters, no control characters, unpaired surrogates, `<` or `>`; a set email looks like `local@domain.tld`.
- Storage: `git_identities` (migration `042_git_identities.sql`), one row per `user_id` with `updated_at`; missing reads `{name: "", email: ""}`. Last-write-wins, no revisions.
- `GET`/`PUT /api/v1/git-identity` for the signed-in user (`no-store`, same ops header rule). `GET /runtime/v1/git-identity` derives the owner from the incarnation bearer.
- **Boot** (execution runtime and Claude): after the project-secrets fetch and before the resume hook, one bounded request (10 s), then `git config --file <xdg> --replace-all` per set key or `--unset-all` per cleared key (exit 5 = absent), where `<xdg>` is `$XDG_CONFIG_HOME/git/config` or `~/.config/git/config`; other keys are preserved. Then `~/.gitconfig` is created empty if missing, never truncated. `~/.gitconfig` and repository config take precedence, and in-orb `git config --global` writes to `~/.gitconfig`, so those edits survive the next boot's XDG rewrite. Git runs with the orb home as working directory (git ≥2.55 aborts when the inherited cwd is unreadable). The process provider drops an inherited `XDG_CONFIG_HOME`, so a local orb never writes the developer's config. Failure fails boot with `git_identity_unavailable`; no history edge.

## Model and thinking settings

Native sessions own settings; the runtime exposes the effective pair and catalog; the browser renders it. No settings file, settings inbox, per-project defaults or reconciler.

- **Pi catalog.** Only image-capable `openai-codex` entries Astra (`gpt-6-astra`), Sol (`gpt-6.1-sol`), Terra (`gpt-5.6-terra`), Luna (`gpt-6-luna`), in that order (`SELECTABLE_CODEX_MODELS`); missing or non-image entries are omitted because pi-ai silently drops images for text-only models. Labels are presentation; selection persists the canonical provider/ID and the full inference registry stays intact. Older saved IDs restore unchanged. Fresh conversations start at Sol/`high` (`PINNED_CODEX_MODEL_ID`, no fallback); a model missing from the registry leaves runs unanswered with native `no_model` (`docs/pi.md`). The browser receives only IDs, names and thinking levels; auth is rechecked on mutation. No model/provider/thinking environment variables. Thinking levels come from SDK metadata (including holes and `max`); model changes keep the current level where supported, otherwise clamp via the SDK; explicit unsupported choices reject. Pi commits model/thinking, request identity and the public settings projection through native Durable storage before acknowledging (`apps/control-plane/src/adapters/durable/settings-history.test.ts`).
- **Claude catalog.** New sessions use the native `opus` alias in initial options and every rotated query. The picker offers only SDK-advertised latest aliases, ordered Fable, Opus, Sonnet, Haiku; default, version-specific and context variants are excluded. The supervised child sets `ANTHROPIC_DEFAULT_FABLE_MODEL=claude-fable-5-2`, so `fable` resolves to [Fable 5.2](https://platform.claude.com/docs/en/models/fable-5-2/overview) in both the SDK catalog and inference. Saved choices keep their exact ID, matched by `value` or `resolvedModel`; unavailable saved models fail visibly. The control and command are labelled `effort`. Only advertised `low`, `medium`, `high`, `xhigh`, `max` map to native effort; `off`/`minimal` reject. Models advertising no effort get no explicit effort; switching to one clears the native overlay and publishes `off` with no levels. Model/effort persist in the private native-session pointer and restore through native controls before input. Uncertain setter or cleanup outcomes fail readiness and keep admission ownership; no rollback machinery.
- **Spawn initial intent.** Nullable immutable `orbs.initial_model` is bootstrap input applied through normal settings initialization before input; restored native choices win (`docs/inbox.md`).
- **Restore.** Settings restore before admitting input, including sessions with no assistant response, before boot notices or resumed turns can infer. No model substitution on restore: a vanished saved Pi model surfaces as `no_model`; Claude fails visibly. Uncertain persistence fails readiness. Transient auth failure never switches models.
- **Runtime view.** One `runtime.event`, live and in every hello batch including a caught-up cursor (`HarnessSnapshot`/`computeSyncFrames`), with no separate fetch, poll or revision:

```ts
type AgentSettingsEvent = {
  type: "agent_settings";
  settings: { model: { provider: string; id: string }; thinkingLevel: ThinkingLevel };
  models: Array<{ provider: string; id: string; name: string; thinkingLevels: ThinkingLevel[] }>;
  writable: boolean;
};
```

  The catalog is built at runtime initialization; opening the picker makes no discovery or auth call. During a mutation the event reports the last stable pair with `writable: false`; after persistence the runtime publishes history and the effective pair, then the receipt. Effective changes from outside the setter publish after persistence, never during a pending mutation. History keeps native settings entries for durability; there is no normalized settings field or offline projection, so stopped/archived pages show no settings.
- **Commands.** `ClientAction` `set_model {model: {provider, id}}` and `set_thinking {thinkingLevel}`; success is operation-free `settings_applied {duplicate}`, which never updates the header. Rejections reuse `busy`, `invalid_request`, `unsupported`, `internal`, `request_id_conflict`. Identical retries join the original; completed duplicates replay the receipt; conflicting payloads reject. A runtime restart drops automatic replay. Each command sets only its own field. Known pre-mutation auth failures release admission and report rejection.
- **Guard.** Apply only when running, synchronized and idle; no queued changes or wake. A configuration-in-progress guard is claimed inside the agent before the first setter await. Settings, live messages, HTTP inbox delivery (retryable result, message stays queued) and child admission check it; idle-stop/archive preparation declines while it is held, and once preparation succeeds settings are fenced like other work. Boot restoration finishes before any automatic turn claims the turn-start barrier, so no separate queue. Multiple tabs: last-applied-wins for explicit requests; runtime admission decides order. Stop can interrupt a mutation and is never followed by a settings-triggered wake.
- **UI.** Model and thinking pickers sit in the orb header after lifecycle controls and appear only once a running connection has synchronized; disconnect clears them. Choices stay disabled until writable and idle; busy rejection shows next to the picker. They are the composer's `model`/`thinking` commands (command mode: `docs/web-ui.md`). An outside click dismisses without consuming the outside action. Dismissal restores a header-initiated draft and never cancels a delivered request. Command text never enters the inbox. Pending state keeps confirmed values; rejection keeps input and shows the error; late completion cannot clear a newer draft. The requesting tab blocks Send while its settings outcome is unresolved.
- Rejected: settings revisions/CAS (single user; last-applied-wins), normalized history fields and offline display, settings values in receipts, a settings-specific error taxonomy, browser/localStorage authority, control-plane reconciliation, blind cross-restart retry.
