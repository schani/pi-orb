# Local delegation routed to an orb; tool details hidden — 2026-09-14

## Observed behavior

In the local process-provider preview, orb `4d412633-0c7e-4b0a-9731-9aaeabbeb024` was asked to use separate subagents for project-purpose and service-count investigations. Its root history shows:

- 21:19:23 UTC: `subagent` starts local Explore child `2a70b104-a824-498` for project purpose.
- 21:19:30: root `bash` invokes `pi-orb spawn`, creating independent orb `1859ac57-e07e-4bfb-b5b5-597f7cfe8767` for service count.
- 21:19:54: the local child completes successfully; `get_subagent_result` returns its result.
- The root subsequently polls the independent orb's transcript and produces its combined answer.

There was no local child failure preceding the independent spawn. No hidden reasoning is needed to establish the sequence. Investigation did not stop, restart, steer or archive these orbs.

## Routing cause and correction

`apps/orb-runtime/src/pi/environment-prompt.ts` still instructed: “For requested delegation, use `pi-orb spawn`.” This predated local subagent integration and contradicted the intended distinction. The fork and runtime ownership machinery worked; first-party agent guidance was wrong.

The initial correction directed delegation to local tools and reserved independent orbs for explicit requests. **Rejected by the user later on 2026-09-14:** this was overly prescriptive, and the delegation wording tests were unnecessary. The selected approach is one factual sentence describing independent orbs (fresh default-branch checkout, separate conversation, lifetime independent of the parent), leaving selection to the agent. The extension already supplies a `subagent` prompt snippet and detailed tool guidance for background/parallel execution, results, resume, steering, model selection and context inheritance; child profiles supply their own prompts. No duplicate selection policy is added. Existing runtime sessions retain their loaded prompt until restarted; no running preview service was restarted during these corrections.

## Tool disclosure cause and correction

The replicated history contained both argument objects and tool results (284 text characters for launch, 2,693 for result retrieval). The actual browser DOM contained those values in a `<pre>` beneath a second, closed `<details>`. The user had expanded the category, but the inner disclosure repeated the tool name with a plain dot and no visible disclosure triangle.

A category containing one generic tool call now shows its input/output immediately when the category is opened, without a redundant inner label/fold. Grouped multiple calls keep their individual disclosures. No private child transcript is fetched or newly replicated; these are existing root tool inputs/results.

## Validation and rollout boundary

Before repair, the prompt regression failed and all three generic-tool rendering cases failed. A browser regression reproduced the invisible output after opening the category. After the initial repair, 30 focused unit tests and all 42 frontend browser tests passed. The two delegation wording tests were subsequently removed at the user's request; the UI regressions remain. Private investigation snapshots and before/after logs remain under `.context/subagent-user-incident/`; no live credentials, raw session dumps or encrypted reasoning are exported.

The preview's built static directory was not rebuilt in place, and its controller/runtimes were not restarted. Source fixes do not silently update already loaded runtime prompts or an already served static build. A safe preview refresh must account for the user's current work. The original WebKit crash and other release gates are unchanged.
