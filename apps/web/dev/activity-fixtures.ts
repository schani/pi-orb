import type { HistoryRecord } from "@pi-orb/protocol";

/** Thinking, call, failed call, subagent receipt, sleep wake after a host restart, harness restart. */
type Step = ["t" | "c" | "f" | "n" | "s" | "h", string];

const RUN: Step[] = [
  [
    "n",
    "Receipts ready: .context/pr267-babysit/resume-guard/RESULTS.md. One-line move only; diff --check clean.",
  ],
  ["t", "Clarifying reconnect behavior|Evaluating idle-timer isolation"],
  ["t", "Refreshing visible connection|Updating reset-tab setup"],
  ["t", "Checking annotated replay snapshots|Inspecting control activity API"],
  ["t", "Planning test-client reconnect|Checking client reconnect logic"],
  [
    "c",
    "text(await tools.bash({command:\"sed -n '285,345p' apps/control-plane/src/domain/control-state.ts\"}))",
  ],
  ["t", "Selecting reconnect correction|Validating reconnect registration"],
  ["t", "Reviewing replay logic|Authorizing root-gate fix"],
  ["c", 'text(await tools.steer_subagent({agent_id:"5944:c2",message:"Authorize root-gate fix"}))'],
  ["n", "Ignored instrumented pre/post copies now confirm exact root cause dynamically."],
  ["n", "Correction count: 42 lifecycle events pre and 42 post, virtual timestamps exactly equal."],
  ["t", "Reconnecting the test connection|Checking CI test status"],
  ["c", 'text(await tools.bash({command:"gh pr checks 267 --json name,state,link"}))'],
  ["n", "Reconnect fix original trace replay now diverges as expected at position 16539."],
  ["t", "Inspecting seed configuration"],
  [
    "c",
    "text(await tools.bash({command:\"sed -n '70,195p' apps/control-plane/src/testkit/sim.ts\"}))",
  ],
  ["t", "Checking recovery-state invariants|Checking unreachable recovery ordering"],
  ["t", "Checking reconnect behavior|Checking idle guard behavior"],
  ["t", "Checking test harness timing|Adjusting test timing setup"],
  ["t", "Reviewing harness timeout setup|Reviewing recovery assertions"],
  ["t", "Waiting for fresh failure|Monitoring pending test runs"],
  ["t", "Waiting for author"],
  ["c", 'text(await tools.get_subagent_result({agent_id:"5944:c2"}))'],
  ["n", "Corrected tiny diff ready: lifecycle test +2 reconnect lines, move unregister."],
  ["n", "Pushed 9afe5b0 to same PR267 branch; working tree clean."],
  ["t", "Reviewing corrected source and docs|Updating corrected PR body"],
  ["f", 'text(await tools.bash({command:"gh pr edit 267 --body-file .context/pr267-body.md"}))'],
  ["t", "Monitoring old-head failure logs|Checking old-run failures"],
  ["t", "Capturing current run table"],
  [
    "c",
    'text(await tools.bash({command:"gh run list --branch fix/claude-initial-input-completion --limit 12"}))',
  ],
  ["t", "Checking workflow statuses"],
  ["c", "text(await tools.bash({command:\"gh run list --json databaseId,status --jq '.[]'\"}))"],
  ["t", "Monitoring full unit run|Waiting for CI completion"],
  ["t", "Preparing squash commit message|Preparing squash merge"],
  ["c", 'text(await tools.bash({command:"gh pr merge 267 --squash"}))'],
];

const SLEEP = "text(await tools.sleep({seconds:1800}))";
const RESTARTS: Step[] = [
  ["t", "Starting the preview server"],
  ["c", 'text(await tools.bash({command:"nohup npm run dev:frontend &"}))'],
  ["t", "Scheduling the next deploy check"],
  ["c", SLEEP],
  ["s", ""],
  ["t", "Restarting the killed preview server|Checking the deploy"],
  ["c", 'text(await tools.bash({command:"gh run list --workflow deploy --limit 3"}))'],
  ["c", SLEEP],
  ["s", ""],
  ["t", "Checking the deploy"],
  ["h", ""],
  ["t", "Recovering the interrupted check"],
  ["c", 'text(await tools.bash({command:"gh run view --log-failed"}))'],
  ["c", SLEEP],
  ["s", ""],
  ["s", ""],
  ["t", "Confirming the deploy finished"],
  ["c", 'text(await tools.bash({command:"gh run list --workflow deploy --limit 1"}))'],
];

function stepRecords(prefix: string, steps: readonly Step[], at: string): HistoryRecord[] {
  return steps.flatMap(([kind, text], index): HistoryRecord[] => {
    const id = `${prefix}-${index}`;
    const base = { id, parentId: null, timestamp: at, overflow: {} };
    if (kind === "t")
      return [
        {
          ...base,
          type: "message",
          role: "assistant",
          content: [
            {
              type: "reasoning",
              text: `${text
                .split("|")
                .map((title) => `**${title}**`)
                .join("\n\n")}\n\nWorking through the next step.`,
            },
          ],
        },
      ];
    if (kind === "s" || kind === "h")
      return [
        {
          ...base,
          type: "event",
          eventType: "pi.custom_message",
          content:
            kind === "s"
              ? [
                  {
                    type: "text",
                    text: "The host was restarted. All processes running before the restart were killed, including servers, background jobs, and shell sessions. The agent session and its history were preserved.",
                  },
                  { type: "text", text: "Scheduled sleep finished." },
                ]
              : [
                  {
                    type: "text",
                    text: "Agent harness restarted with unfinished work; recovery is resuming.",
                  },
                ],
          custom: {
            customType: kind === "s" ? "pi-orb.sleep-wake" : "pi-orb.harness-restarted",
            display: true,
          },
        },
      ];
    if (kind === "n")
      return [
        {
          ...base,
          type: "event",
          eventType: "pi.custom_message",
          content: [],
          custom: { customType: "subagent-notification", display: true },
          subagent: {
            id: "5944:c2",
            description: "Stabilize resume-budget DST",
            kind: "notification",
            message: text,
          },
        },
      ];
    const callId = `${id}-call`;
    return [
      {
        ...base,
        type: "message",
        role: "assistant",
        content: [{ type: "tool_call", callId, name: "codemode", arguments: { code: text } }],
      },
      {
        ...base,
        id: `${id}-result`,
        type: "message",
        role: "tool",
        content: [
          {
            type: "tool_result",
            callId,
            ...(kind === "f" ? { isError: true } : {}),
            content: [
              {
                type: "text",
                text: kind === "f" ? "could not read .context/pr267-body.md" : "ok",
              },
            ],
          },
        ],
      },
    ];
  });
}

function prose(id: string, role: "user" | "assistant", text: string, at: string): HistoryRecord {
  return {
    id,
    parentId: null,
    timestamp: at,
    type: "message",
    role,
    content: [{ type: "text", text }],
    overflow: {},
  };
}

/** A babysitting turn whose interleaved activity exercises the strip, a 300-step overflow, and restarts. */
export function activityFixtureRecords(createdAt: string): HistoryRecord[] {
  const long = Array.from({ length: 300 }, (_, index) => RUN[(index * 7) % RUN.length] as Step);
  const records = [
    prose("activity-ask", "user", "babysit PR 267", createdAt),
    prose(
      "activity-start",
      "assistant",
      "CI failed on the resume-budget DST. Delegating root cause.",
      createdAt,
    ),
    ...stepRecords("activity-run", RUN, createdAt),
    prose("activity-done", "assistant", "PR 267 merged.", createdAt),
    prose("activity-ask-long", "user", "keep watching main", createdAt),
    ...stepRecords("activity-long", long, createdAt),
    prose("activity-long-done", "assistant", "Main stayed green.", createdAt),
    prose("activity-ask-restarts", "user", "watch the deploy overnight", createdAt),
    ...stepRecords("activity-restarts", RESTARTS, createdAt),
    prose("activity-restarts-done", "assistant", "The deploy finished green.", createdAt),
  ];
  // Tool results pair with their calls through the parent chain.
  return records.map((record, index) => ({ ...record, parentId: records[index - 1]?.id ?? null }));
}
