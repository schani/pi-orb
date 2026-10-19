import { err, ok, ResultAsync } from "/neverthrow.js";

/**
 * @typedef {{code: string, message: string}} ApiError
 * @typedef {{id: string, title: string, category: string, scope: string,
 *   editable: boolean, content: string, revision: string, note?: string, variables?: string[]}} Entry
 */

/** The only network boundary; credentials stay in the fragment and Authorization headers. */
export function createPromptApi(token, fetchRequest = globalThis.fetch) {
  function request(path, method = "GET", body) {
    return ResultAsync.fromThrowable(
      () =>
        fetchRequest(path, {
          method,
          credentials: "omit",
          redirect: "error",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      () => ({ code: "network", message: "Cannot reach the prompt server. Try again." }),
    )().andThen((response) =>
      ResultAsync.fromThrowable(
        () => response.json(),
        () => ({ code: "invalid_response", message: "The prompt server returned invalid JSON." }),
      )().andThen((data) =>
        response.ok
          ? ok(data)
          : err({
              code: data?.error?.code ?? `http_${response.status}`,
              message: data?.error?.message ?? `Request failed (${response.status}).`,
            }),
      ),
    );
  }
  return {
    list: () => request("/api/prompts"),
    render: (config) => request("/api/render", "POST", config),
    save: (id, content, revision) =>
      request(`/api/prompts/${encodeURIComponent(id)}`, "PUT", { content, revision }),
  };
}

// Specific, content-grounded claims; matching a claim means overlap, not agreement.
// Keep predicates with their objects: a shared topic or tool name is not evidence.
const overlapClaims = [
  [
    "coding-agent-work",
    /coding (?:assistant|agent).{0,100}(?:inspect and change|reading files|read, write, edit files)/i,
  ],
  ["concise-responses", /be concise(?: in your responses)?/i],
  ["child-orb-spawning", /(?:do not|cannot) start subagents or orbs/i],
  ["orb-info", /(?:get this orb's identity|get info on this orb)/i],
  ["orb-list", /(?:list orbs owned|list\/search\/read other orbs)/i],
  ["orb-transcript", /(?:read an orb's committed transcript|list\/search\/read other orbs)/i],
  ["orb-create", /(?:create a same.project orb|other orbs, create new ones)/i],
  ["orb-archive", /archive(?:\/delete)? this orb/i],
  ["orb-delete", /delete this orb/i],
  [
    "orb-user-alert",
    /(?:archive\/delete this orb, alert the user|notify the user: append a transcript alert)/i,
  ],
  [
    "orb-sleep-deadline",
    /(?:commit a sleep deadline for this orb|archive\/delete this orb, alert the user, sleep)/i,
  ],
  ["orb-workspace-isolation", /orbs do(?: not|n't)? share (?:workspaces|file systems)/i],
  ["submission-not-reply", /acceptance.{0,55}not a reply/i],
  ["explicit-lifecycle-consent", /(?:archive|delete).{0,55}only on explicit user request/i],
  ["admission-revocation", /(?:revokes execution admission|execution admission revoked)/i],
  ["parent-notification", /notify (?:your |a )?parent(?: agent)?|subagents can notify a parent/i],
  ["restart-killed-processes", /all processes running before the restart were killed/i],
  [
    "verify-process-survival",
    /(?:verify their state rather than assuming they survived or died|reassess any assumptions about running processes)/i,
  ],
  ["continue-interrupted-work", /continue (?:whatever you were doing|from where you left off)/i],
  ["retry-user-input", /(?:send a message to continue|use start or new input to retry)/i],
  ["sleep-deadline-elapsed", /scheduled sleep (?:finished|expired)/i],
  ["user-uploaded-files", /the user uploaded (?:a file|files)/i],
  [
    "missing-requested-resource",
    /(?:execution orb does not exist|requested resource does not exist)/i,
  ],
  [
    "boot-hook-preparation",
    /\.agents\/setup.{0,180}\.agents\/resume.{0,200}(?:before the agent|before you get|once per compute|once per compute incarnation)|\.agents\/setup.{0,180}(?:before the agent|once per compute).{0,200}\.agents\/resume/i,
  ],
  ["healthy-autonomy-quiet", /a healthy (?:fleet logs nothing|boot says nothing anywhere)/i],
  [
    "autonomous-outcomes-visible",
    /(?:outcomes that affect the user must be visible to the user in the product|a hook that did not succeed is shown on the orb page)/i,
  ],
  ["hook-env-file", /(?:write|append).{0,70}(?:pi_orb_hook_env_file|\$home\/\.pi-orb\/env)/i],
  [
    "hook-not-executable",
    /(?:present but not executable|hook_not_executable|non-executable hook)/i,
  ],
  ["hook-exit-code", /failed.{0,30}(?:with exit code|with exitcode|with.{0,5}exitcode)/i],
  [
    "deadline-process-kill",
    /(?:terminated after exceeding its deadline|deadline.{0,35}(?:killed|kills)|timeout.{0,65}deadline.{0,35}killed)/i,
  ],
  [
    "hook-env-skipped-line",
    /(?:line was skipped, the rest applied|unusable line is skipped.{0,110}rest of the file still applies)/i,
  ],
  [
    "hook-runtime-owned-env",
    /(?:runtime owns.{0,30}ignored|names are the runtime's.{0,40}ignored|runtime-owned.{0,40}(?:ignored|denylist))/i,
  ],
  [
    "keyless-orb-identity",
    /obtain short.lived cloud credentials.{0,150}(?:no secret|no stored secret|no service.account key)/i,
  ],
  [
    "hook-outcome-log",
    /(?:\.agents\/\s*;\s*log:|hook that did not succeed.{0,110}outcome and log path)/i,
  ],
  [
    "owner-relative-path-resolution",
    /(?:relative path, resolve it against the skill directory|resolve docs\/.{0,110}not the current working directory)/i,
  ],
  [
    "load-matching-skill",
    /(?:load|read).{0,35}skill(?:'s)? file when the task matches its description/i,
  ],
  ["share-openable-url", /(?:share the full url|return the exact url printed)/i],
  [
    "unknown-external-effects",
    /(?:effects may have occurred|effects.{0,85}not rolled back|failure.{0,30}not rollback|failed scripts do not undo effects|upload reports an unknown outcome)/i,
  ],
  ["shell-execution-failed", /shell execution failed/i],
  [
    "codemode-tool-composition",
    /(?:use codemode to (?:compose|batch)|run javascript (?:that calls|to compose)|compose authorized tools in javascript)/i,
  ],
  ["raw-javascript-input", /raw javascript (?:source|\(not json|, not json)/i],
  [
    "codemode-discovery",
    /(?:searchtools.{0,70}(?:describetool|deferred tool)|(?:deferred|unlisted) tools.{0,50}(?:search|discover)|search query for deferred tools|searches over deferred tool metadata)/i,
  ],
  [
    "namespace-discovery",
    /(?:discover with describenamespace|describenamespace\(.{0,70}(?:find|discover|promise of)|discover tools with.{0,45}describenamespace)/i,
  ],
  [
    "codemode-batching",
    /(?:batch independent tool calls|batch independent calls|promise\.allsettled.{0,50}(?:independent|calls)|promise\.allsettled\(\) for independent work)/i,
  ],
  ["codemode-callback-limits", /8(?:-| )outstanding.{0,45}256.{0,45}8 mib.{0,35}64 mib/i],
  ["codemode-output-limits", /1 mib text.{0,30}32 mib.{0,35}4096 items/i],
  ["codemode-no-redeclaration", /do not redeclare (?:tools or other )?injected (?:globals|names)/i],
  ["codemode-options", /(?:@options.{0,70}timeout_ms|timeout_ms.{0,40}max_output_tokens)/i],
  ["inline-images", /images (?:are returned|remain|stay) inline/i],
  [
    "image-block-output",
    /(?:show (?:blocks|images|image blobs) with image\(\)|images must use image\(\)|use image\(\) for (?:each image block|image blobs))/i,
  ],
  [
    "explicit-script-output",
    /(?:only (?:explicit|emitted) (?:output|text)|text\(value\).{0,80}return.{0,10}add output)/i,
  ],
  [
    "json-store-load",
    /store\(key, value\).{0,45}load\(key\).{0,70}(?:json|state)|store\/load.{0,25}json|store:.{0,130}load\(\) returns a copy/i,
  ],
  [
    "script-replay",
    /(?:script survives a restart.{0,70}without running finished calls again|journals.{0,70}(?:resume|reconstruct)|resume.{0,50}native journals)/i,
  ],
  [
    "script-completion-cancellation",
    /(?:calls still running when the script ends are cancelled|script completion.{0,65}cancels outstanding calls|unawaited calls are cancelled when execution ends)/i,
  ],
  [
    "private-output-artifact",
    /(?:code-mode output spilled to a private artifact|truncation can spill text to a private.{0,25}artifact|private text artifact)/i,
  ],
  ["codemode-output-truncation", /(?:code-mode output truncated|output-budget truncation)/i],
  [
    "chart-transcript-row",
    /(?:chart\(spec\).{0,65}(?:row|transcript)|line or bar charts.{0,80}transcript rows)/i,
  ],
  [
    "codemode-limits-reference",
    /(?:brief code.mode overview, example and all pi.orb code.mode limits|for all resource caps, read.{0,100}limits \(central native code.mode\)|limits \(central native code.mode\).{0,25}sandbox: no node)/i,
  ],
  [
    "codemode-manual-contract",
    /(?:code.mode.{0,40}tool discovery.{0,50}result types|discovery exposes their exact argument and result shapes)/i,
  ],
  [
    "host-file-url",
    /(?:publish and share.{0,100}pi-orb host|publish.{0,80}pi-orb host|pi-orb host file\.html)/i,
  ],
  [
    "read-file-contents",
    /(?:read (?:the )?(?:contents of a file|text or image files|file contents)|use read to (?:examine|inspect) files)/i,
  ],
  [
    "read-offset-continuation",
    /(?:use offset\/?(?:limit)?.{0,30}(?:continue|large files)|continue with offset|use offset=.{0,45}to continue)/i,
  ],
  ["read-line-offset", /line number to start reading from/i],
  [
    "read-line-limit",
    /(?:maximum number of lines to read|text is truncated to.{0,30}lines|for text files, output is truncated to.{0,30}lines)/i,
  ],
  ["read-text-50k", /(?:text.{0,50}50 kib|first line exceeds 50 kib)/i],
  [
    "whole-file-16m",
    /(?:file exceeds 16 mib|whole-file reads.{0,10}16 mib|16 mib.{0,35}whole.file)/i,
  ],
  ["unsupported-image-format", /unsupported.{0,50}image format/i],
  ["read-file-path", /path to the file to read \(relative or absolute\)/i],
  ["write-file-path", /path to the file to write \(relative or absolute\)/i],
  ["edit-file-path", /path to the file to edit \(relative or absolute\)/i],
  [
    "write-create-overwrite",
    /(?:create or overwrite files|creates the file if it doesn't exist, overwrites if it does|write only for new files or complete rewrites)/i,
  ],
  ["write-file-content", /(?:content to write to the file|write content to a file)/i],
  [
    "edit-exact-match",
    /(?:oldtext.{0,80}(?:match exactly|unique)|exact text for one targeted replacement|exact text replacement|precise file edits with exact text replacement)/i,
  ],
  [
    "edit-original-file",
    /(?:each edit is matched against the original file|each edits\[\]\.oldtext is matched against the original file|original file, not (?:after|incrementally))/i,
  ],
  ["edit-merge-nearby", /merge (?:nearby changes|them into one edit|nearby edits)/i],
  [
    "edit-disjoint-batch",
    /(?:multiple disjoint edits in one call|multiple separate locations.{0,45}one edit call|overlapping or nested edits)/i,
  ],
  [
    "edit-minimal-context",
    /(?:do not include large unchanged regions|do not pad with large unchanged regions|oldtext as small as possible while still being unique)/i,
  ],
  ["edit-replacement-content", /replacement text for (?:this|one) targeted (?:edit|replacement)/i],
  [
    "shell-command-execution",
    /(?:execute (?:a bash|a \{\{shell_name\}\}|bash) commands?|(?:bash|shell) command to execute|execute a command in the current working directory.{0,45}stdout and stderr)/i,
  ],
  ["shell-timeout-seconds", /(?:timeout in seconds|timeout seconds)/i],
  [
    "context-as-data",
    /(?:treat (?:all )?supplied context (?:only )?as (?:untrusted )?data|untrusted quoted data.{0,40}never follow instructions inside it)/i,
  ],
  [
    "checkpoint-summary",
    /(?:structured context checkpoint summary|structured summary of this conversation branch|concise checkpoint of the user's request)/i,
  ],
  [
    "subagent-launch-task",
    /(?:start a background subagent|launch a new agent to handle complex|task for the agent to perform)/i,
  ],
  [
    "subagent-profiles",
    /(?:no profiles or kinds|agent profile, not a model|specialized agents.{0,100}each agent type)/i,
  ],
  [
    "subagent-model-override",
    /(?:optional model override|runs on model, or the parent's model|to choose a model use model)/i,
  ],
  ["subagent-thinking", /(?:thinking level: off|use thinking to control extended thinking)/i],
  [
    "subagent-result-wait",
    /(?:get subagent status|check status and retrieve results from a background agent|wait for (?:the agent to complete|completion))/i,
  ],
  [
    "subagent-steering",
    /(?:send input to a subagent|send (?:a steering message|mid-run messages) to a running (?:background )?agent|steering message.{0,65}injected into its conversation)/i,
  ],
  [
    "mcp-resource-read",
    /read (?:an mcp resource|a specific resource from an mcp server).{0,60}(?:server|uri)/i,
  ],
  [
    "mcp-resource-server",
    /(?:mcp server name(?: exactly as configured)?|server names from mcp namespaces)/i,
  ],
  [
    "mcp-listed-identifiers",
    /(?:returned by list_mcp_resources|list resources\/templates before reading unfamiliar uris)/i,
  ],
  [
    "mcp-resource-list",
    /(?:list mcp resources or uri templates|lists resources provided by mcp servers)/i,
  ],
  [
    "mcp-template-list",
    /(?:list mcp resources or uri templates|lists resource templates provided by mcp servers)/i,
  ],
  [
    "mcp-resource-pagination",
    /(?:optional server\/cursor returns one page|opaque cursor from a previous call with the same server)/i,
  ],
];

/** Inspectable derived facts, independent of IDs, metadata, revisions and storage. */
export function promptOverlapFacts(content) {
  const plain = content
    .replace(/\{\{[^}]*\}\}/g, " ")
    .replace(/`|\*\*|\r/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return [];
  const facts = overlapClaims.filter(([, pattern]) => pattern.test(plain)).map(([name]) => name);
  // Long shared clauses catch literal repetition without matching headings, slots,
  // licenses, or generic short errors. No bag-of-words/topic similarity.
  const ignored = new Set(
    "a an and are as at be by can context for from has have in is it its of on or prompt system text that the their these this to tool tools use with you your agent agents default own omit optional model".split(
      " ",
    ),
  );
  const prose = content.split(/\bMIT License\b/i)[0].replace(/\{\{[^}]*\}\}/g, " ");
  for (const clause of prose.split(/\n|[.!?](?:\s|$)/)) {
    const words = clause.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
    for (let index = 0; index <= words.length - 8; index += 1) {
      const phrase = words.slice(index, index + 8);
      if (new Set(phrase.filter((word) => word.length > 2 && !ignored.has(word))).size >= 4)
        facts.push(`clause:${phrase.join(" ")}`);
    }
  }
  return [...new Set(facts)];
}

// Retain only the current corpus, never a history of edited drafts.
let overlapFactCache = new Map();

/** Direct, symmetric overlaps in catalogue order. Contents must be current drafts. */
export function findPromptOverlaps(entries, id) {
  const current = new Map();
  for (const entry of entries) {
    if (!entry.id.startsWith("dynamic/") && !current.has(entry.content))
      current.set(
        entry.content,
        overlapFactCache.get(entry.content) ?? promptOverlapFacts(entry.content),
      );
  }
  overlapFactCache = current;
  const source = entries.find((entry) => entry.id === id);
  if (!source || id.startsWith("dynamic/")) return [];
  const facts = new Set(current.get(source.content));
  return [
    ...new Set(
      entries
        .filter(
          (entry) =>
            entry.id !== id &&
            !entry.id.startsWith("dynamic/") &&
            current.get(entry.content).some((fact) => facts.has(fact)),
        )
        .map((entry) => entry.id),
    ),
  ];
}

// Audited co-emission, not overlap inference. See docs/prompt-review.md.
// Keepers are canonical; neither unknown prose nor template bindings are inferred.
const auditedKeepers = {};
const redundancyRules = [];
// FNV-1a-128 over normalized UTF-16LE plus code-unit length: audit identity, not authentication.
// Synchronous on HTTP origins; prompt text still requires the capability-protected API.
export function promptContentFingerprint(content) {
  const normalized = content.replace(/\s+/g, " ").trim();
  let hash = 0x6c62272e07bb014262b821756295c58dn;
  for (let i = 0; i < normalized.length; i++) {
    const unit = normalized.charCodeAt(i);
    for (const byte of [unit & 255, unit >>> 8])
      hash = BigInt.asUintN(128, (hash ^ BigInt(byte)) * 0x1000000000000000000013bn);
  }
  return `${normalized.length}:${hash.toString(16).padStart(32, "0")}`;
}

/** Whole-entry audited coverage, in catalogue order, using current literal drafts. */
export function findPromptRedundancies(entries) {
  const contents = new Map(
    entries
      .filter(
        ({ id }) =>
          Object.hasOwn(auditedKeepers, id) || redundancyRules.some((rule) => rule.id === id),
      )
      .map(({ id, content }) => [id, promptContentFingerprint(content)]),
  );
  return entries.flatMap(({ id }) => {
    const rule = redundancyRules.find((candidate) => candidate.id === id);
    if (!rule || !contents.get(id) || contents.get(id) !== rule.fingerprint) return [];
    if (!rule.keeperIds.every((keeperId) => contents.get(keeperId) === auditedKeepers[keeperId]))
      return [];
    return [{ id, keeperIds: [...rule.keeperIds], reason: rule.reason }];
  });
}

/** Delivery semantics of the reviewed sources, not a reconstruction of a provider request. */
export function promptDelivery({ id, content }) {
  if (id === "dynamic/claude-native")
    return "SDK-owned context · delivery timing and content unavailable";
  if (id.startsWith("dynamic/")) {
    if (["dynamic/personal", "dynamic/project"].includes(id))
      return "At context build, if set · Pi context / Claude root append; actual content unavailable";
    if (id === "dynamic/mcp")
      return "Namespace guides: initial when registered · deferred tools/schemas: on discovery; server-owned content unavailable";
    if (id === "dynamic/repository-resources")
      return "At Pi context build, if selected · pinned instructions and skill inventory unavailable";
    return "Runtime-dependent delivery · content and timing unavailable here";
  }
  if (content === "") return "Empty · emits nothing";
  if (id.startsWith("skill/"))
    return id.endsWith("/body")
      ? "On demand · when the skill is read or invoked; not included by its discovery listing"
      : "Pi: at context build if selected · Claude: native skill discovery; body separate";
  if (id === "repository/instructions")
    return "Pi: initial if selected · Claude: native repository discovery; insertion timing opaque";
  if (id.startsWith("feedback/"))
    return "After matching tool outcome · feedback, not initial instructions";
  if (id.startsWith("lifecycle/"))
    return "On matching lifecycle/input event · not a universal session preamble";
  if (id.startsWith("aux/"))
    return "When its task runs · separate model request, not main-agent context";
  if (id.startsWith("upstream/durable/compaction-"))
    return "When compacting · separate model request, not main-agent initial context";
  if (id.startsWith("upstream/durable/summary-"))
    return "After compaction · wraps the summary retained in main-agent context";
  if (id === "upstream/durable/codemode-code-parameter")
    return "When function fallback is used · separate tool schema field, not system text";
  if (
    id === "codemode/policy" ||
    id === "codemode/inline-images" ||
    /^upstream\/durable\/codemode-(intro|globals-\d|closing)$/.test(id)
  )
    return "From first model request · offered code-mode tool definition, separate API field";
  if (["namespace/mcp-description", "namespace/mcp-instructions"].includes(id))
    return "From first Pi model request when registered · namespace guide and discovery response";
  if (id.startsWith("tool/mcp-resource-"))
    return "On discovery · deferred from initial declarations; when resources supported";
  if (id === "namespace/orb-description" || id === "namespace/orb-instructions")
    return "From first Pi model request · namespace declarations/guide and discovery response; retained while unchanged; changes append updates";
  if (
    id.startsWith("tool/") ||
    id.startsWith("parameter/") ||
    /^upstream\/durable\/(write|edit|bash)-description$/.test(id)
  )
    return "Inline if budget-selected; otherwise on discovery · code-mode declarations";
  if (id.startsWith("upstream/pi/skills-"))
    return "At Pi context build · selected skill discovery only; bodies are not included";
  if (id === "system/environment")
    return "Pi: first model request, retained while unchanged; changes append updates · Claude: root query append; native timing opaque";
  if (["system/environment-claude", "system/claude-timezone", "system/network"].includes(id))
    return `At root query launch · Claude SDK append${id === "system/environment-claude" ? "" : " if configured"}; native delivery opaque`;
  if (id.startsWith("system/"))
    return `From first Pi model request · retained while unchanged; changes append updates${id === "system/timezone" ? "; if time zone configured" : ""}`;
  return "Delivery not established by this checkout";
}

/** Source-linked checkout recipes, not provider captures. Text comes only from supplied drafts. */
export function composeInitialContext(entries, { harness = "pi", role = "root" } = {}) {
  const sources = new Map(entries.map((entry) => [entry.id, entry]));
  const structure = (text) => ({ text, availability: "structure" });
  const gap = (text) => ({ text: `[${text}]`, availability: "runtime" });
  const atom = (id, conditional) => {
    const entry = sources.get(id);
    const availability = !entry
      ? "missing"
      : id.startsWith("dynamic/")
        ? "runtime"
        : entry.content === ""
          ? "empty"
          : "known";
    return {
      id,
      conditional,
      availability,
      variables: entry?.variables ?? [],
      text:
        availability === "missing"
          ? `[Missing atom: ${id}]`
          : availability === "runtime"
            ? `[Runtime: ${id.slice(8)}]`
            : entry.content,
    };
  };
  const section = (title, channel, parts) => ({ title, channel, parts });
  const separated = (parts) =>
    parts.flatMap((part, index) => (index ? [structure("\n\n"), part] : [part]));
  const splice = (id, variable, inner, conditional) => {
    const wrapper = atom(id, conditional);
    const pieces = wrapper.text.split(`{{${variable}}}`);
    if (pieces.length !== 2) return [wrapper, gap(`Unresolved ${variable} wrapper`), ...inner];
    const fragment = (text) => (text.trim() ? { ...wrapper, text } : structure(text));
    return [
      fragment(pieces[0]),
      ...inner,
      fragment(pieces[1]),
      ...(!pieces.some((piece) => piece.trim())
        ? [{ ...wrapper, text: "", availability: "empty" }]
        : []),
    ];
  };
  const task = section("Input", "input", [gap("Initial task / user input not selected")]);
  if (harness === "claude") {
    const native = atom("dynamic/claude-native");
    return role === "subagent"
      ? [
          section("Native child context", "native", [
            native,
            gap("CLI child profile, context, inheritance and tool policy unavailable"),
          ]),
          task,
        ]
      : [
          section("Native context", "native", [
            native,
            gap("claude_code preset, memory, skills, reminders and tool policy unavailable"),
          ]),
          section(
            "Known append",
            "system",
            separated([
              atom("system/environment"),
              atom("system/environment-claude"),
              atom("dynamic/personal", "when nonempty"),
              atom("dynamic/project", "when nonempty"),
              atom("system/network", "when preview host configured"),
              atom("system/claude-timezone", "when time zone configured"),
            ]),
          ),
          section("Native tool definitions", "tools", [gap("Native / MCP schemas unavailable")]),
          task,
        ];
  }

  const declarations = section("Tool catalogue", "system", [
    structure("<codemode>\nTools scripts can call (`await tools.<name>(args)`):\n\n"),
    gap(
      "Runtime-generated callable declarations, including argument/result schemas; budget-selected membership and order not captured here",
    ),
    {
      ...structure("\n## orb\n"),
      note: "Header may include a budget suffix; generated membership is unavailable.",
    },
    atom("namespace/orb-description"),
    gap(
      "Runtime-generated orb declarations, including argument/result schemas; budget-selected membership not captured here",
    ),
    structure('\n\nNamespace orb: discover with describeNamespace("orb").\n'),
    atom("namespace/orb-instructions"),
    gap(
      "Other namespace guides and instructions, when registered; runtime server content unavailable",
    ),
    structure("\n</codemode>"),
  ]);
  const parent = separated([
    atom("system/preamble"),
    { ...structure("<project_instructions>"), conditional: "when instructions nonempty" },
    atom("dynamic/personal", "when nonempty"),
    atom("dynamic/repository-resources", "selected repository instructions; # path + body"),
    atom("dynamic/project", "when nonempty"),
    { ...structure("</project_instructions>"), conditional: "when instructions nonempty" },
    atom("system/codemode"),
    atom("system/timezone", "when time zone configured"),
    atom("system/environment"),
    atom("system/environment-pi"),
    atom("upstream/pi/skills-heading", "when visible skills present"),
    atom("upstream/pi/skills-read", "when visible skills present"),
    atom("upstream/pi/skills-relative-paths", "when visible skills present"),
  ]);
  parent.push({
    ...structure("\n\n<available_skills>\n"),
    conditional: "when visible skills present",
  });
  for (const name of [
    "boot-hooks",
    "charts",
    "cloud-identity",
    "codemode-manual",
    "codemode-quick-reference",
    "hosting",
  ]) {
    const description = atom(
      `skill/${name}/description`,
      "when selected and model invocation enabled",
    );
    const escapeXml = (text) =>
      text
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&apos;");
    parent.push(
      {
        ...structure(`  <skill>\n    <name>${name}</name>\n    <description>`),
        conditional: description.conditional,
      },
      {
        ...description,
        text: description.availability === "known" ? escapeXml(description.text) : description.text,
      },
      {
        ...structure(
          `</description>\n    <location>{{skill_path:${name}}}</location>\n  </skill>\n`,
        ),
        conditional: description.conditional,
        variables: [`skill_path:${name}`],
      },
    );
  }
  parent.push(gap("Selected skill inventory and runtime locations unavailable"), {
    ...structure("\n</available_skills>"),
    conditional: "when visible skills present",
  });
  const instructions = section("orb-instructions", "system", [
    structure("<orb-instructions>\n"),
    ...(role === "subagent"
      ? splice("system/child-restriction", "parent_instructions", parent)
      : parent),
    structure("\n</orb-instructions>"),
  ]);
  const output = atom("upstream/durable/codemode-globals-1");
  const inline = atom("codemode/inline-images");
  const imagePhrase =
    "`image()` also saves the image to a temp file and the result names its path.";
  const imageParts = output.text.split(imagePhrase);
  const modelTool = section("functions.codemode · description", "tools", [
    atom("upstream/durable/codemode-intro"),
    structure("\n\n"),
    atom("upstream/durable/codemode-globals-0"),
    structure("\n"),
    ...(imageParts.length === 2
      ? [{ ...output, text: imageParts[0] }, inline, { ...output, text: imageParts[1] }]
      : [output, gap("Native inline-image replacement target unavailable")]),
    structure("\n"),
    atom("upstream/durable/codemode-globals-2"),
    structure("\n"),
    atom("upstream/durable/codemode-globals-3"),
    structure("\n\n"),
    atom("upstream/durable/codemode-closing"),
    atom("codemode/policy"),
  ]);
  const schema = section("functions.codemode · schema", "tools", [
    gap("Generated grammar / schema unavailable; parameter prose only in function fallback"),
    atom("upstream/durable/codemode-code-parameter", "function fallback only"),
  ]);
  const common = [
    "orb_self",
    "orb_list",
    "orb_transcript",
    "orb_send",
    "orb_sleep",
    "orb_archive",
    "orb_delete",
  ];
  const rootOnly = [
    "orb_spawn",
    "orb_alert",
    "subagent",
    "steer_subagent",
    "get_subagent_result",
    "list_subagents",
    "cancel_subagent",
  ];
  const available = [...common, ...(role === "subagent" ? ["notify_parent"] : rootOnly)].map(
    (name) => atom(`tool/${name}`),
  );
  available.push(
    atom("tool/read"),
    ...["write", "edit", "bash"].map((name) => atom(`upstream/durable/${name}-description`)),
    atom("tool/mcp-status"),
    {
      ...atom("tool/mcp-resource-read", "when MCP resources supported"),
      note: "Deferred · on discovery only",
    },
    {
      ...atom(
        "tool/mcp-resource-list",
        "resources / templates; separate declarations when both supported",
      ),
      note: "Deferred · on discovery only",
    },
  );
  return [
    declarations,
    instructions,
    modelTool,
    schema,
    section("Callable descriptions", "availability", available),
    task,
  ];
}

const token = new URLSearchParams(location.hash.slice(1)).get("token");
const api = createPromptApi(token);
const byId = (id) => document.getElementById(id);
const ui = Object.fromEntries(
  [
    "atomic-view",
    "template-view",
    "rendered-view",
    "skills-jump",
    "rendered-prompt",
    "rendered-role",
    "rendered-harness",
    "rendered-timezone",
    "render-refresh",
    "rendered-status",
    "rendered-text",
    "initial-context",
    "template-harness",
    "template-role",
    "template-sections",
    "template-timing",
    "catalog-status",
    "workspace",
    "search",
    "redundant-filter",
    "covered-by",
    "keeper-links",
    "inventory",
    "empty-filter",
    "selection-message",
    "prompt-panel",
    "prompt-title",
    "prompt-note",
    "prompt-delivery",
    "overlaps",
    "overlap-links",
    "overlap-preview",
    "overlap-preview-title",
    "overlap-preview-text",
    "edit-status",
    "diff",
    "reload",
    "revert",
    "save",
    "prompt-error",
    "editors",
    "before-panel",
    "before",
    "prompt-label",
    "prompt",
  ].map((id) => [id, byId(id)]),
);

const prompts = new Map();
let selectedId = new URLSearchParams(location.search).get("id");
let templateView = new URLSearchParams(location.search).get("view") === "template";
let templateHarness =
  new URLSearchParams(location.search).get("harness") === "claude" ? "claude" : "pi";
let templateRole =
  new URLSearchParams(location.search).get("role") === "subagent" ? "subagent" : "root";
let renderedView = new URLSearchParams(location.search).get("view") === "rendered";
let renderedTimeZone = "America/Los_Angeles";
let renderVersion = 0;
let reviewing = false;
let catalogLoading = false;
let catalogReady = false;
let redundantOnly = false;

const dirty = (state) => state.draft !== state.entry.content;
const selected = () => prompts.get(selectedId);
const saving = () => [...prompts.values()].some((state) => state.saving);
const makeState = (entry) => ({
  entry,
  draft: entry.content,
  editVersion: 0,
  saving: false,
  saved: false,
  reloading: false,
  error: null,
});

function selectPrompt(event, id, href) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
    return;
  event.preventDefault();
  if (selectedId !== id || templateView || renderedView) history.pushState(null, "", href);
  templateView = false;
  renderedView = false;
  selectedId = id;
  renderInventory();
  renderDetail();
  renderView();
}

let previewLink = null;
let previewFocusFrame = 0;
function closePreview({ restoreFocus = false, cancelFocus = true } = {}) {
  const link = previewLink;
  // Restore before hiding: hiding a focused preview otherwise loses its focus target.
  if (restoreFocus && ui["overlap-preview"].contains(document.activeElement))
    link?.focus({ preventScroll: true });
  // Restoring focus can queue another preview; cancel that intent too.
  if (cancelFocus) {
    cancelAnimationFrame(previewFocusFrame);
    previewFocusFrame = 0;
  }
  previewLink = null;
  ui["overlap-preview"].hidden = true;
  link?.setAttribute("aria-expanded", "false");
}

function overlapLabel(entry) {
  const sameTitle = [...prompts.values()].filter((state) => state.entry.title === entry.title);
  if (sameTitle.length < 2) return entry.title;
  const sameScope = sameTitle.filter((state) => state.entry.scope === entry.scope);
  return `${entry.title} · ${entry.scope}${sameScope.length > 1 ? ` · ${entry.id}` : ""}`;
}

function openPreview(link, state) {
  if (previewLink === link && !ui["overlap-preview"].hidden) return;
  closePreview();
  previewLink = link;
  link.setAttribute("aria-expanded", "true");
  const preview = ui["overlap-preview"];
  ui["overlap-preview-title"].textContent = overlapLabel(state.entry);
  ui["overlap-preview-text"].textContent = state.draft;
  preview.hidden = false;
  preview.scrollTop = 0;
  const anchor = link.getBoundingClientRect();
  const width = Math.min(760, innerWidth - 16);
  const below = innerHeight - anchor.bottom - 8;
  const above = anchor.top - 8;
  const height = Math.max(0, Math.min(600, innerHeight * 0.65, Math.max(below, above)));
  preview.style.width = `${width}px`;
  preview.style.maxHeight = `${height}px`;
  const actualHeight = preview.getBoundingClientRect().height;
  preview.style.left = `${Math.max(8, Math.min(anchor.left, innerWidth - width - 8))}px`;
  preview.style.top = `${Math.max(8, below >= actualHeight ? anchor.bottom : anchor.top - actualHeight)}px`;
}

function leavePreview(event) {
  if (!previewLink) return;
  const preview = ui["overlap-preview"];
  const within = (target) =>
    target instanceof Node && (previewLink.contains(target) || preview.contains(target));
  if (within(event.relatedTarget)) return;
  if (event.type === "focusout") {
    if (previewLink.matches(":hover") || preview.matches(":hover")) return;
  } else if (within(document.activeElement)) return;
  closePreview();
}

function currentEntries() {
  return [...prompts.values()].map((state) => ({
    id: state.entry.id,
    content: state.draft,
    variables: state.entry.variables,
  }));
}

function markRedundant(element, mark) {
  element.classList.toggle("redundant", Boolean(mark));
  element.querySelector(".redundancy-status")?.remove();
  element.removeAttribute("aria-description");
  if (!mark) return;
  const status = document.createElement("span");
  status.className = "redundancy-status visually-hidden";
  status.textContent = " Redundant";
  element.append(status);
  element.setAttribute("aria-description", mark.reason);
}

function bindPromptLink(link, state, afterFocusScroll = false) {
  link.dataset.promptId = state.entry.id;
  link.addEventListener("click", (event) => selectPrompt(event, state.entry.id, link.href));
  if (!state.draft) return;
  link.setAttribute("aria-controls", "overlap-preview");
  link.setAttribute("aria-expanded", "false");
  link.addEventListener("mouseenter", () => openPreview(link, state));
  link.addEventListener("focus", () => {
    if (!afterFocusScroll) {
      openPreview(link, state);
      return;
    }
    closePreview();
    // Native focus scrolling runs before animation frames; place the preview afterwards.
    previewFocusFrame = requestAnimationFrame(() => {
      previewFocusFrame = 0;
      if (document.activeElement === link) openPreview(link, state);
    });
  });
  link.addEventListener("mouseleave", leavePreview);
  link.addEventListener("focusout", leavePreview);
}

let overlapSignature = "";
function renderOverlaps() {
  const entries = currentEntries();
  const marks = new Map(findPromptRedundancies(entries).map((mark) => [mark.id, mark]));
  const mark = marks.get(selectedId);
  markRedundant(ui["prompt-title"], mark);
  const keeperIds = mark?.keeperIds ?? [];
  const ids = findPromptOverlaps(entries, selectedId).filter((id) => !keeperIds.includes(id));
  const signature = JSON.stringify([
    selectedId,
    location.hash,
    keeperIds,
    [...keeperIds, ...ids].map((id) => [id, overlapLabel(prompts.get(id).entry), marks.get(id)]),
  ]);
  if (signature === overlapSignature) {
    if (previewLink) {
      const content = prompts.get(previewLink.dataset.promptId).draft;
      if (ui["overlap-preview-text"].textContent !== content)
        ui["overlap-preview-text"].textContent = content;
    }
    return;
  }
  overlapSignature = signature;
  closePreview();
  ui.overlaps.hidden = ids.length === 0;
  ui["covered-by"].hidden = keeperIds.length === 0;
  for (const [target, links] of [
    [ui["keeper-links"], keeperIds],
    [ui["overlap-links"], ids],
  ]) {
    target.replaceChildren();
    for (const id of links) {
      const state = prompts.get(id);
      const link = document.createElement("a");
      link.href = `/?id=${encodeURIComponent(id)}${location.hash}`;
      link.textContent = overlapLabel(state.entry);
      markRedundant(link, marks.get(id));
      bindPromptLink(link, state);
      target.append(link);
    }
  }
}

ui["overlap-preview"].addEventListener("mouseleave", leavePreview);
ui["overlap-preview"].addEventListener("focusout", leavePreview);
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && previewFocusFrame) {
    event.preventDefault();
    closePreview();
  }
  if (
    event.key === "Tab" &&
    !event.shiftKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    event.target instanceof HTMLAnchorElement &&
    event.target.dataset.promptId
  ) {
    const state = prompts.get(event.target.dataset.promptId);
    if (state?.draft) openPreview(event.target, state);
  }
  if (!previewLink) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closePreview({ restoreFocus: true });
  } else if (event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey) {
    if (!event.shiftKey && event.target === previewLink) {
      event.preventDefault();
      ui["overlap-preview"].focus({ preventScroll: true });
    } else if (event.target === ui["overlap-preview"]) {
      const sourceLinks = [...ui["template-sections"].querySelectorAll("a[data-prompt-id]")];
      const sourceIndex = sourceLinks.indexOf(previewLink);
      const target = event.shiftKey
        ? previewLink
        : sourceIndex >= 0
          ? (sourceLinks[sourceIndex + 1] ?? ui["atomic-view"])
          : (previewLink.nextElementSibling ??
            (previewLink.parentElement === ui["keeper-links"]
              ? ui["overlap-links"].firstElementChild
              : null) ??
            ui["prompt-panel"].querySelector(".actions button:not([disabled])"));
      if (target) {
        event.preventDefault();
        target.focus({ preventScroll: sourceIndex < 0 });
      }
    }
  }
});
window.addEventListener("resize", () => closePreview());
window.addEventListener(
  "scroll",
  (event) => {
    if (!(event.target instanceof Node) || !ui["overlap-preview"].contains(event.target))
      closePreview({ cancelFocus: false });
  },
  true,
);

function dashboardLink() {
  const link = document.createElement("a");
  link.href = `/${location.hash}`;
  link.textContent = "Dashboard";
  link.addEventListener("click", (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    history.pushState(null, "", link.href);
    selectedId = null;
    templateView = false;
    renderedView = false;
    renderInventory();
    renderDetail();
    if (catalogReady) renderView();
  });
  return link;
}

function message(target, text, { error = false, dashboard = false, retry = false } = {}) {
  target.replaceChildren();
  const paragraph = document.createElement("p");
  paragraph.textContent = text;
  if (error) paragraph.setAttribute("role", "alert");
  target.append(paragraph);
  if (dashboard) target.append(dashboardLink());
  if (retry) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Retry";
    button.addEventListener("click", loadCatalog);
    target.append(button);
  }
}

function renderInventory() {
  const filter = ui.search.value.toLocaleLowerCase().trim();
  const categories = new Map();
  const marks = new Map(findPromptRedundancies(currentEntries()).map((mark) => [mark.id, mark]));
  for (const state of prompts.values()) {
    const entry = state.entry;
    if (redundantOnly && !marks.has(entry.id)) continue;
    const haystack = [entry.title, entry.category, entry.scope, entry.note ?? "", state.draft]
      .join("\n")
      .toLocaleLowerCase();
    if (filter && !haystack.includes(filter)) continue;
    if (!categories.has(entry.category)) categories.set(entry.category, []);
    categories.get(entry.category).push(entry);
  }
  ui.inventory.replaceChildren();
  for (const [category, entries] of categories) {
    const heading = document.createElement("h2");
    heading.textContent = category;
    const list = document.createElement("ul");
    for (const entry of entries) {
      const row = document.createElement("li");
      const link = document.createElement("a");
      link.href = `/?id=${encodeURIComponent(entry.id)}${location.hash}`;
      const title = document.createElement("span");
      title.textContent = entry.title;
      const scope = document.createElement("span");
      scope.className = "scope";
      scope.textContent = entry.scope;
      link.append(title, scope);
      markRedundant(link, marks.get(entry.id));
      if (entry.id === selectedId) link.setAttribute("aria-current", "page");
      link.addEventListener("click", (event) => selectPrompt(event, entry.id, link.href));
      row.append(link);
      list.append(row);
    }
    ui.inventory.append(heading, list);
  }
  ui["empty-filter"].hidden = categories.size > 0;
}

function renderControls() {
  const state = selected();
  if (!state) return;
  ui["prompt-delivery"].textContent =
    `When · ${promptDelivery({ ...state.entry, content: state.draft })}`;
  const editable = state.entry.editable;
  ui["edit-status"].textContent = !editable
    ? "Read-only"
    : state.saving
      ? "Saving…"
      : state.reloading
        ? "Reloading…"
        : dirty(state)
          ? "Unsaved changes"
          : state.saved
            ? "Saved"
            : "";
  ui.save.disabled = !editable || !dirty(state) || saving() || state.reloading;
  ui.revert.disabled = !editable || !dirty(state) || state.saving || state.reloading;
  ui.reload.disabled = state.saving || state.reloading;
  ui.diff.disabled = !editable;
  ui["prompt-error"].hidden = !state.error;
  ui["prompt-error"].textContent = state.error?.message ?? "";
  ui.before.value = state.entry.content;
  renderOverlaps();
}

function renderDetail() {
  closePreview();
  const state = selected();
  ui["prompt-panel"].hidden = !state;
  ui["selection-message"].hidden = Boolean(state);
  if (!state) {
    if (selectedId !== null) {
      message(ui["selection-message"], `Prompt “${selectedId}” doesn't exist.`, {
        dashboard: true,
      });
    } else {
      message(ui["selection-message"], "Select a prompt.");
    }
    return;
  }
  ui["prompt-title"].textContent = state.entry.title;
  ui["prompt-note"].hidden = !state.entry.note;
  ui["prompt-note"].textContent = state.entry.note ?? "";
  ui.prompt.value = state.draft;
  ui.prompt.readOnly = !state.entry.editable;
  const showReview = reviewing && state.entry.editable;
  ui["before-panel"].hidden = !showReview;
  ui.editors.classList.toggle("reviewing", showReview);
  ui.diff.setAttribute("aria-expanded", String(showReview));
  ui["prompt-label"].textContent = showReview ? "After" : "Prompt";
  ui["prompt-label"].classList.toggle("visually-hidden", !showReview);
  renderControls();
}

function templateUrl() {
  const url = new URL(location.href);
  url.search = new URLSearchParams({
    view: renderedView ? "rendered" : "template",
    harness: templateHarness,
    role: templateRole,
  });
  return url.href;
}

function renderView() {
  closePreview();
  renderVersion += 1;
  ui["rendered-prompt"].hidden = true;
  ui["rendered-text"].hidden = true;
  ui["rendered-text"].textContent = "";
  const params = new URLSearchParams(location.search);
  const invalid = [
    ["view", ["atomic", "template", "rendered"]],
    ["harness", ["pi", "claude"]],
    ["role", ["root", "subagent"]],
  ].flatMap(([key, values]) =>
    params
      .getAll(key)
      .filter((value) => !values.includes(value))
      .map((value) => `${key}=${value}`),
  );
  if (invalid.length) {
    ui.workspace.hidden = true;
    ui["initial-context"].hidden = true;
    ui["catalog-status"].hidden = false;
    message(
      ui["catalog-status"],
      `${params.get("view") === "rendered" ? "Rendered prompt" : "Initial context template"} “${invalid.join(", ")}” doesn't exist.`,
      { dashboard: true },
    );
    return;
  }
  ui["catalog-status"].hidden = true;
  ui.workspace.hidden = templateView || renderedView;
  ui["initial-context"].hidden = !templateView;
  ui["atomic-view"].setAttribute("aria-pressed", String(!templateView && !renderedView));
  ui["template-view"].setAttribute("aria-pressed", String(templateView));
  ui["rendered-view"].setAttribute("aria-pressed", String(renderedView));
  if (renderedView) {
    ui["rendered-prompt"].hidden = false;
    ui["rendered-harness"].value = templateHarness;
    ui["rendered-role"].value = templateRole;
    ui["rendered-timezone"].value = renderedTimeZone;
    void renderPrompt();
    return;
  }
  if (!templateView) return;
  ui["template-harness"].value = templateHarness;
  ui["template-role"].value = templateRole;
  ui["template-timing"].textContent =
    "Conditional source recipe · not a request capture. Source order within sections.";
  ui["template-sections"].replaceChildren();
  const entries = currentEntries();
  const marks = new Map(findPromptRedundancies(entries).map((mark) => [mark.id, mark]));
  for (const section of composeInitialContext(entries, {
    harness: templateHarness,
    role: templateRole,
  })) {
    const group = document.createElement("section");
    group.dataset.channel = section.channel;
    const heading = document.createElement("h2");
    const channel = {
      system: "System content",
      tools: "Offered tool definition · separate from system",
      native: "Native context · unavailable",
      availability: "Reference inventory · not a request section",
      input: "User input",
    }[section.channel];
    heading.textContent = `${channel} · ${section.title}`;
    const delivery = document.createElement("p");
    delivery.className = "template-delivery";
    delivery.textContent = {
      system:
        templateHarness === "claude"
          ? "At root query launch · supplied to SDK; native request layout unknown"
          : "From first model request · retained while unchanged; changes append updates",
      tools:
        templateHarness === "claude"
          ? "SDK-owned tool definitions · delivery timing and content unavailable"
          : "From first model request · separate API field; current definition",
      native: "SDK-owned context · delivery timing and content unavailable",
      availability: "Inline if budget-selected; otherwise on discovery",
      input: "When input arrives · not selected here",
    }[section.channel];
    group.append(heading, delivery);
    for (const part of section.parts) {
      if (part.availability === "structure" && !part.text.trim()) continue;
      const block = document.createElement("div");
      block.className = `template-part ${part.availability}`;
      block.classList.toggle("conditional", Boolean(part.conditional));
      const annotation = document.createElement("div");
      annotation.className = "template-annotation";
      if (part.id) {
        block.dataset.atomId = part.id;
        const state = prompts.get(part.id);
        if (state) {
          const link = document.createElement("a");
          link.href = `/?id=${encodeURIComponent(part.id)}${location.hash}`;
          link.textContent = state.entry.title;
          markRedundant(link, marks.get(part.id));
          bindPromptLink(link, state, true);
          annotation.append(link);
        }
      }
      const note = (text, className = "") => {
        const paragraph = document.createElement("p");
        paragraph.className = className;
        paragraph.textContent = text;
        annotation.append(paragraph);
      };
      if (part.availability === "empty") note("Empty · emits nothing");
      else if (part.conditional)
        note(
          `Conditional${section.channel === "system" ? " at context build" : ""} · ${part.conditional}`,
          "template-condition",
        );
      if (part.note) note(part.note);
      const known = ["known", "structure"].includes(part.availability);
      const inventory = section.channel === "availability";
      if (!known && part.text) note(part.text);
      else if (part.text) {
        const text = document.createElement("pre");
        if (inventory) {
          text.textContent = part.text;
          annotation.append(text);
        } else {
          text.className = "template-payload";
          const fragments = part.text.split(/(\{\{[^{}]+\}\})/g);
          let substituted = false;
          for (const fragment of fragments) {
            if ((part.variables ?? []).some((name) => fragment === `{{${name}}}`)) {
              substituted = true;
              const variable = document.createElement("span");
              variable.className = "runtime-value";
              variable.title = "Runtime value · substituted before sending";
              variable.textContent = fragment;
              text.append(variable);
            } else text.append(document.createTextNode(fragment));
          }
          if (substituted) note("Runtime values substituted before sending");
          block.append(text);
        }
      }
      block.append(annotation);
      group.append(block);
    }
    ui["template-sections"].append(group);
  }
}

async function renderPrompt() {
  const version = ++renderVersion;
  ui["rendered-text"].hidden = true;
  ui["rendered-text"].textContent = "";
  ui["rendered-status"].textContent = "Rendering…";
  const result = await api.render({
    harness: templateHarness,
    role: templateRole,
    timeZone: renderedTimeZone || null,
    drafts: [...prompts.values()]
      .filter((state) => state.entry.editable && dirty(state))
      .map((state) => ({
        id: state.entry.id,
        content: state.draft,
        revision: state.entry.revision,
      })),
  });
  if (version !== renderVersion || !renderedView) return;
  if (result.isErr()) {
    ui["rendered-status"].textContent = result.error.message;
  } else if (typeof result.value?.text !== "string" || !result.value.text) {
    ui["rendered-status"].textContent = "The prompt server returned an invalid rendered prompt.";
  } else {
    ui["rendered-status"].textContent = "";
    ui["rendered-text"].textContent = result.value.text;
    ui["rendered-text"].hidden = false;
  }
}

function showView(template, rendered = false) {
  if (catalogLoading || ui["catalog-status"].hidden === false) return;
  templateView = template;
  renderedView = rendered;
  history.pushState(
    null,
    "",
    template || rendered
      ? templateUrl()
      : `/${selectedId ? `?id=${encodeURIComponent(selectedId)}` : ""}${location.hash}`,
  );
  renderInventory();
  renderDetail();
  renderView();
}
ui["atomic-view"].addEventListener("click", () => showView(false));
ui["template-view"].addEventListener("click", () => showView(true));
ui["rendered-view"].addEventListener("click", () => showView(false, true));
ui["skills-jump"].addEventListener("click", (event) => {
  const skill = [...prompts.values()].find(
    ({ entry }) => entry.id.startsWith("skill/") && entry.id.endsWith("/body"),
  );
  if (!skill) return;
  ui.search.value = "";
  redundantOnly = false;
  ui["redundant-filter"].setAttribute("aria-pressed", "false");
  selectPrompt(event, skill.entry.id, `/?id=${encodeURIComponent(skill.entry.id)}${location.hash}`);
  [...ui.inventory.querySelectorAll("h2")]
    .find((heading) => heading.textContent === "Skills")
    ?.scrollIntoView({ block: "start" });
});
ui["render-refresh"].addEventListener("click", () => void renderPrompt());
for (const id of ["rendered-harness", "rendered-role", "rendered-timezone"]) {
  ui[id].addEventListener("change", () => {
    templateHarness = ui["rendered-harness"].value;
    templateRole = ui["rendered-role"].value;
    renderedTimeZone = ui["rendered-timezone"].value;
    history.replaceState(null, "", templateUrl());
    renderView();
  });
}
for (const id of ["template-harness", "template-role"]) {
  ui[id].addEventListener("change", () => {
    templateHarness = ui["template-harness"].value;
    templateRole = ui["template-role"].value;
    history.replaceState(null, "", templateUrl());
    renderView();
  });
}

function validEntry(entry) {
  return (
    entry &&
    ["id", "title", "category", "scope", "content"].every(
      (key) => typeof entry[key] === "string",
    ) &&
    typeof entry.editable === "boolean" &&
    entry.revision !== undefined
  );
}

async function fetchEntries() {
  const result = await api.list();
  if (result.isErr()) return result;
  if (!Array.isArray(result.value?.entries) || !result.value.entries.every(validEntry)) {
    return err({
      code: "invalid_response",
      message: "The prompt server returned an invalid inventory.",
    });
  }
  return ok(result.value.entries);
}

async function loadCatalog() {
  if (catalogLoading) return;
  catalogLoading = true;
  ui.workspace.hidden = true;
  ui["initial-context"].hidden = true;
  ui["rendered-prompt"].hidden = true;
  ui["catalog-status"].hidden = false;
  message(ui["catalog-status"], "Loading prompts…");
  const result = await fetchEntries();
  catalogLoading = false;
  if (result.isErr()) {
    message(ui["catalog-status"], result.error.message, {
      error: true,
      retry: true,
      dashboard: true,
    });
    return;
  }
  for (const entry of result.value) {
    if (!prompts.has(entry.id)) prompts.set(entry.id, makeState(entry));
  }
  if (result.value.length === 0 && selectedId === null) {
    message(ui["catalog-status"], "No prompts found.", { retry: true });
    return;
  }
  catalogReady = true;
  ui["catalog-status"].hidden = true;
  ui.workspace.hidden = false;
  renderInventory();
  renderDetail();
  renderView();
}

async function refreshAfterSave(savedState) {
  const baseline = new Map([...prompts].map(([id, state]) => [id, state.entry]));
  const result = await fetchEntries();
  if (result.isErr()) {
    if (
      savedState.entry === baseline.get(savedState.entry.id) &&
      !savedState.reloading &&
      !savedState.error
    ) {
      savedState.error = {
        code: "refresh_failed",
        message: "Saved. Could not refresh other prompts. Reload latest before saving them.",
      };
    }
  } else {
    for (const entry of result.value) {
      const state = prompts.get(entry.id);
      const original = baseline.get(entry.id);
      if (
        state &&
        state.entry === original &&
        !state.saving &&
        !state.reloading &&
        entry.content === original.content
      ) {
        state.entry = entry;
      }
    }
    renderInventory();
  }
  renderControls();
}

async function saveSelected() {
  const state = selected();
  if (!state?.entry.editable || !dirty(state) || saving() || state.reloading) return;
  const version = state.editVersion;
  let saved = false;
  state.saving = true;
  state.error = null;
  renderControls();
  const result = await api.save(state.entry.id, state.draft, state.entry.revision);
  if (result.isErr()) {
    state.error = result.error;
  } else if (!validEntry(result.value) || result.value.id !== state.entry.id) {
    state.error = {
      code: "invalid_response",
      message: "The prompt server returned an invalid saved prompt. Reload latest to check.",
    };
  } else {
    state.entry = result.value;
    // Only replace the submitted draft if nothing was typed while the request ran.
    if (state.editVersion === version) state.draft = result.value.content;
    state.saved = state.editVersion === version;
    saved = true;
  }
  renderInventory();
  if (selected() === state) {
    if (state.editVersion === version) ui.prompt.value = state.draft;
    renderControls();
  }
  if (saved) await refreshAfterSave(state);
  state.saving = false;
  renderControls();
}

async function reloadSelected() {
  const state = selected();
  if (!state || state.saving || state.reloading) return;
  if (dirty(state) && !window.confirm("Discard this draft and reload the latest prompt?")) return;
  const version = state.editVersion;
  state.reloading = true;
  state.saved = false;
  state.error = null;
  renderControls();
  const result = await fetchEntries();
  state.reloading = false;
  if (result.isErr()) {
    state.error = result.error;
  } else {
    const entry = result.value.find((entry) => entry.id === state.entry.id);
    if (!entry) {
      state.error = {
        code: "not_found",
        message: `Prompt “${state.entry.id}” doesn't exist. Your draft is still here.`,
      };
    } else {
      state.entry = entry;
      if (state.editVersion === version) state.draft = entry.content;
    }
  }
  renderInventory();
  if (selected() === state) {
    if (state.editVersion === version) ui.prompt.value = state.draft;
    renderControls();
  }
}

ui.search.addEventListener("input", renderInventory);
ui["redundant-filter"].addEventListener("click", () => {
  redundantOnly = !redundantOnly;
  ui["redundant-filter"].setAttribute("aria-pressed", String(redundantOnly));
  renderInventory();
});
ui.prompt.addEventListener("input", () => {
  const state = selected();
  if (!state?.entry.editable) return;
  state.draft = ui.prompt.value;
  state.saved = false;
  state.editVersion += 1;
  renderInventory();
  renderControls();
});
ui.save.addEventListener("click", saveSelected);
ui.reload.addEventListener("click", reloadSelected);
ui.revert.addEventListener("click", () => {
  const state = selected();
  if (!state || state.saving || state.reloading) return;
  state.draft = state.entry.content;
  state.saved = false;
  state.editVersion += 1;
  state.error = null;
  renderInventory();
  renderDetail();
});
ui.diff.addEventListener("click", () => {
  reviewing = !reviewing;
  renderDetail();
});
window.addEventListener("popstate", () => {
  const params = new URLSearchParams(location.search);
  templateView = params.get("view") === "template";
  renderedView = params.get("view") === "rendered";
  if (!templateView && !renderedView) selectedId = params.get("id");
  if (templateView || renderedView) {
    templateHarness = params.get("harness") === "claude" ? "claude" : "pi";
    templateRole = params.get("role") === "subagent" ? "subagent" : "root";
  }
  renderInventory();
  renderDetail();
  if (catalogReady) renderView();
});
window.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    if (!templateView && !renderedView) void saveSelected();
  }
});
window.addEventListener("keydown", (event) => {
  if (
    !["ArrowUp", "ArrowDown"].includes(event.key) ||
    event.defaultPrevented ||
    event.isComposing ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.shiftKey ||
    ui.workspace.hidden
  )
    return;
  if (
    event.target !== document.body &&
    event.target !== ui.search &&
    event.target !== ui["redundant-filter"] &&
    !ui.inventory.contains(event.target)
  )
    return;
  const links = [...ui.inventory.querySelectorAll("a")];
  const index = links.findIndex((link) => link.hasAttribute("aria-current"));
  const next =
    index < 0
      ? event.key === "ArrowDown"
        ? 0
        : links.length - 1
      : index + (event.key === "ArrowDown" ? 1 : -1);
  if (!links[next]) return;
  event.preventDefault();
  links[next].click();
  const current = ui.inventory.querySelector('[aria-current="page"]');
  if (event.target !== ui.search) current.focus({ preventScroll: true });
  current.scrollIntoView({ block: "nearest", inline: "nearest" });
});
window.addEventListener("beforeunload", (event) => {
  if (![...prompts.values()].some(dirty)) return;
  event.preventDefault();
  event.returnValue = "";
});

if (location.pathname !== "/" && location.pathname !== "/index.html") {
  message(ui["catalog-status"], `Page “${location.pathname}” doesn't exist.`, { dashboard: true });
} else if (!token) {
  message(
    ui["catalog-status"],
    "Prompt browser doesn't exist at this link: missing access token.",
    { dashboard: true },
  );
} else {
  void loadCatalog();
}
