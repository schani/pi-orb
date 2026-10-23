import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  defineTool,
  Harness,
  type TaskId,
  type ToolTaskInput,
} from "@earendil-works/pi-durable";
import {
  CODEMODE_MODULE_VERSION,
  CodemodeJournalDoc,
  CodemodeRunDoc,
} from "@earendil-works/pi-durable/codemode";
import { errAsync, okAsync } from "neverthrow";
import { Check } from "typebox/value";
import { assert, describe, expect, it, vi } from "vitest";
import { MemoryAgentPersistence } from "../memory-persistence.testkit.ts";
import { PiCodemodeSandbox } from "./codemode-sandbox.ts";
import { createDurableTools } from "./index.ts";

const context = BACKGROUND_CONTEXT;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("native codemode interrupted journal recovery", () => {
  for (const alteration of [
    "none",
    "authorization",
    "unsafe",
    "version",
    "fingerprint",
    "deadline",
    "divergence",
    "argument-mismatch",
    "pending-argument-mismatch",
  ] as const) {
    it(`reopens actual interrupted Harness tasks: ${alteration}`, async () => {
      const tracing = process.env.PI_NATIVE_REPLAY_TRACE === alteration;
      const events: unknown[] = [];
      const trace = (event: string, fields: object = {}) => {
        if (tracing && events.length < 160)
          events.push({ event, reopening, records, holds, ...fields });
      };
      const vmStarts: boolean[] = [];
      const start = PiCodemodeSandbox.prototype.start;
      const sandboxTrace = vi
        .spyOn(PiCodemodeSandbox.prototype, "start")
        .mockImplementation(function (this: PiCodemodeSandbox, code, options) {
          vmStarts.push(reopening);
          trace("vm-start");
          return start.call(this, code, {
            ...options,
            onCall: (call) => {
              trace("vm-call", { id: call.id, target: call.target, name: call.name });
              options.onCall(call);
            },
          });
        });
      const authority = new MemoryAgentPersistence();
      const held = deferred<TaskId>();
      const resumedHold = deferred<void>();
      const completed = deferred<void>();
      const recordAttempts: TaskId[] = [];
      const holdAttempts: {
        taskId: TaskId;
        parent: number;
        key: string;
        signal: AbortSignal | undefined;
        abortedAtEntry: boolean | undefined;
      }[] = [];
      const authorizations: { name: string; taskId: TaskId; reopening: boolean }[] = [];
      const callbacks: { name: string; key: string | undefined; reopening: boolean }[] = [];
      const offeredTools: string[][] = [];
      const callableTools: string[][] = [];
      const children = new Map<
        TaskId,
        { taskId: TaskId; parent: TaskId; key: string; name: string }
      >();
      let records = 0,
        holds = 0,
        sentinels = 0;
      let reopening = false;
      let holdTaskId: TaskId | undefined;
      let result: { output?: unknown; details?: unknown; isError?: boolean } | undefined;
      const bundle = createDurableTools({
        authorize: (name, _args, api) => {
          authorizations.push({ name, taskId: api.taskId, reopening });
          trace("authorize", { name, taskId: api.taskId });
          if (reopening && name === "hold_restart" && alteration === "authorization") {
            resumedHold.resolve();
            return errAsync({ code: "forbidden", message: "Current authorization denied" });
          }
          return okAsync(undefined);
        },
        additionalTools: [
          defineTool({
            name: "record_once",
            description: "record",
            parameters: Type.Object({ secret: Type.String() }),
            replay: "safe",
            execute: async (_args, api) => {
              records++;
              recordAttempts.push(api.taskId);
              trace("record-execute", { taskId: api.taskId });
              return { output: [{ type: "text", text: "recorded" }] };
            },
          }),
          defineTool({
            name: "hold_restart",
            description: "hold",
            parameters: Type.Object({ secret: Type.String() }),
            replay: alteration === "unsafe" ? "unsafe" : "safe",
            execute: async (_args, api, ctx) => {
              holds++;
              const task = await api.getTask(api.taskId, ctx);
              const input = task?.input;
              assert(input !== null && typeof input === "object" && !Array.isArray(input));
              assert(input.kind === "nested");
              assert(typeof input.parent === "number");
              assert(typeof input.key === "string");
              assert(task?.owner !== undefined && task.owner === input.parent);
              const checkpoint = task?.state.checkpoint;
              holdAttempts.push({
                taskId: api.taskId,
                parent: input.parent,
                key: input.key,
                signal: ctx.abortSignal,
                abortedAtEntry: ctx.abortSignal?.aborted,
              });
              trace("hold-execute", {
                taskId: api.taskId,
                parent: input.parent,
                owner: task?.owner,
                key: input.key,
                status: task?.state.status,
                phase:
                  checkpoint && typeof checkpoint === "object" && "phase" in checkpoint
                    ? checkpoint.phase
                    : undefined,
                aborted: ctx.abortSignal?.aborted,
              });
              if (holds === 1) {
                holdTaskId = api.taskId;
                held.resolve(task.owner);
                await new Promise<void>((resolve) => {
                  if (ctx.abortSignal?.aborted) resolve();
                  else ctx.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
                });
              } else {
                resumedHold.resolve();
              }
              trace("hold-return", { taskId: api.taskId, aborted: ctx.abortSignal?.aborted });
              return { output: [{ type: "text", text: "continued" }] };
            },
          }),
        ],
      });
      const native = bundle.extension.tools!.find((tool) => tool.name === "codemode")!;
      const sentinel = defineTool({
        name: "post_hold",
        description: "continuation sentinel",
        parameters: Type.Object({}),
        callers: ["tools"],
        execute: async () => {
          sentinels++;
          return { output: [{ type: "text", text: "sentinel" }] };
        },
      });
      const registry = createRegistry();
      const extension = {
        ...bundle.extension,
        tools: [
          ...bundle.extension.tools!.map((tool) =>
            tool.name !== "codemode"
              ? tool
              : defineTool({
                  ...native,
                  execute: async (args, api, ctx) => {
                    assert(Check(Type.Object({ code: Type.String() }), args));
                    const agent = await api.agent(ctx);
                    offeredTools.push(agent.tools.map((tool) => tool.name));
                    callableTools.push(agent.callable.map((tool) => tool.name));
                    let code = args.code;
                    if (reopening && alteration === "argument-mismatch")
                      code = code.replace("REPLAY_CANARY", "CHANGED_CANARY");
                    if (reopening && alteration === "pending-argument-mismatch")
                      code = code.replace("PENDING_CANARY", "CHANGED_PENDING_CANARY");
                    // Already-admitted safe children resume independently, even if replay is refused.
                    // Wait for that entry before validation, rather than racing parent cleanup.
                    if (reopening && alteration !== "unsafe") await resumedHold.promise;
                    trace("parent-execute", {
                      taskId: api.taskId,
                      aborted: ctx.abortSignal?.aborted,
                    });
                    const value = await native.execute(
                      { ...args, code },
                      {
                        ...api,
                        executeTool: (name, value, callContext, options) => {
                          callbacks.push({ name, key: options?.key, reopening });
                          trace("parent-executeTool", {
                            taskId: api.taskId,
                            name,
                            key: options?.key,
                          });
                          return api.executeTool(name, value, callContext, options);
                        },
                      },
                      ctx,
                    );
                    trace("parent-return", {
                      taskId: api.taskId,
                      aborted: ctx.abortSignal?.aborted,
                      isError: value.isError,
                    });
                    if (!ctx.abortSignal?.aborted) {
                      result = value;
                      completed.resolve();
                    }
                    return value;
                  },
                }),
          ),
          sentinel,
        ],
      };
      registry.install(extension);
      let first = true;
      const open = async () => {
        const faux = fauxProvider();
        faux.setResponses(
          first
            ? [
                fauxAssistantMessage(
                  fauxToolCall("codemode", {
                    code: 'await chart({kind:"bar",title:"private chart",bars:[{label:"one",value:1}]}); text(await tools.record_once({secret:"REPLAY_CANARY"})); await tools.hold_restart({secret:"PENDING_CANARY"}); await tools.post_hold({}); text("continued");',
                  }),
                  { stopReason: "toolUse" },
                ),
                fauxAssistantMessage("done"),
              ]
            : [fauxAssistantMessage("done")],
        );
        first = false;
        const models = createModels();
        models.setProvider(faux.provider);
        const storage = (await authority.openOrb("recovery", false))._unsafeUnwrap().storage;
        const opened = await Harness.open(storage, { models, registry }, context);
        opened.subscribeClose(() => trace("harness-close"));
        opened.subscribeCommits((publication) => {
          for (const change of publication.changes) {
            if (change.type === "task") {
              const task = change.value;
              const input = task.kind === "pi.tool" ? (task.input as ToolTaskInput) : undefined;
              const checkpoint = task.state.checkpoint;
              if (input?.kind === "nested")
                children.set(task.id, {
                  taskId: task.id,
                  parent: input.parent,
                  key: input.key,
                  name: input.call.name,
                });
              trace("task-commit", {
                seq: publication.seq,
                taskId: task.id,
                owner: task.owner,
                kind: task.kind,
                version: task.version,
                parent: input?.kind === "nested" ? input.parent : undefined,
                key: input?.kind === "nested" ? input.key : undefined,
                status: task.state.status,
                phase:
                  checkpoint && typeof checkpoint === "object" && "phase" in checkpoint
                    ? checkpoint.phase
                    : undefined,
                abortRequested: task.abortRequested,
              });
            }
            if (
              change.type === "document" &&
              (change.record.kind.startsWith("pi.codemode.") ||
                change.record.kind === "pi.tool.nested-call")
            ) {
              const value = change.value;
              const runStart = value?.start;
              trace("codemode-commit", {
                seq: publication.seq,
                kind: change.record.kind,
                scope: change.record.scope,
                key: change.record.key,
                taskId: value?.taskId,
                runVersion:
                  runStart && typeof runStart === "object" && "version" in runStart
                    ? runStart.version
                    : undefined,
                entries: Array.isArray(value?.entries) ? value.entries.length : undefined,
                firstIssued: value?.firstIssued,
                decided: value?.result !== undefined,
                retired: value === null,
              });
            }
          }
        });
        trace("harness-open");
        return opened;
      };
      let harness = await open();
      try {
        let root = await harness.root(context, {
          agent: { model: { provider: "faux", modelId: "faux-1" }, extensions: [extension] },
        });
        harness.resume();
        await root.submit({ type: "input", content: "run" }, context);
        const outer = await held.promise;
        expect(records).toBe(1);
        expect(holds).toBe(1);
        expect(sentinels).toBe(0);
        const inventory = () => [...children.values()].filter((child) => child.parent === outer);
        const admitted = inventory();
        expect(admitted.map(({ name, key }) => ({ name, key }))).toEqual([
          { name: "record_once", key: "c2" },
          { name: "hold_restart", key: "c3" },
        ]);
        expect(recordAttempts).toEqual([admitted[0]!.taskId]);
        trace("before-first-close", { outer });
        await harness.close(context);
        trace("after-first-close", { outer });
        expect(holdAttempts[0]!.signal?.aborted).toBe(true);
        reopening = true;
        harness = await open();
        root = await harness.root(context);
        await root.commit(async (tx) => {
          const task = await tx.task(outer);
          trace("reopened-parent", { taskId: outer, status: task?.state.status });
          assert(holdTaskId !== undefined);
          const child = await tx.task(holdTaskId);
          expect(child?.owner).toBe(outer);
          expect(child?.state).toMatchObject({
            status: "pending",
            checkpoint: { phase: "execute" },
          });
          expect((await tx.task(admitted[0]!.taskId))?.state.status).toBe("terminal");
          trace("reopened-child", {
            taskId: holdTaskId,
            owner: child?.owner,
            status: child?.state.status,
          });
          const run = await tx.doc(CodemodeRunDoc, outer);
          expect(run.start).toBeDefined();
          const { deadline, startedAt } = run.start!;
          expect(deadline).toBeDefined();
          expect(deadline! - startedAt).toBe(300_000);
          expect(run.result).toBeUndefined();
          const journal = await tx.doc(CodemodeJournalDoc, outer);
          expect(journal.entries.some((entry) => entry.global?.name === "chart")).toBe(true);
          if (alteration === "version") run.start!.version++;
          if (alteration === "fingerprint") run.start!.fingerprint = "changed-engine";
          if (alteration === "deadline") run.start!.deadline = 1;
          if (alteration === "divergence") journal.firstIssued = (journal.firstIssued ?? 0) + 1;
        }, context);
        harness.resume();
        await completed.promise;
        expect(records).toBe(1);
        expect(recordAttempts).toEqual([admitted[0]!.taskId]);
        const denied = alteration === "authorization" || alteration === "unsafe";
        expect(holds).toBe(denied ? 1 : 2);
        expect(
          holdAttempts.map(({ taskId, parent, key, abortedAtEntry }) => ({
            taskId,
            parent,
            key,
            abortedAtEntry,
          })),
        ).toEqual(
          (denied ? [1] : [1, 2]).map(() => ({
            taskId: admitted[1]!.taskId,
            parent: outer,
            key: "c3",
            abortedAtEntry: false,
          })),
        );
        if (!denied) expect(holdAttempts[1]!.signal).not.toBe(holdAttempts[0]!.signal);
        expect(authorizations.filter(({ name }) => name === "hold_restart")).toEqual(
          (alteration === "unsafe" ? [false] : [false, true]).map((reopening) => ({
            name: "hold_restart",
            taskId: admitted[1]!.taskId,
            reopening,
          })),
        );
        expect(authorizations.filter(({ name }) => name === "record_once")).toEqual([
          { name: "record_once", taskId: admitted[0]!.taskId, reopening: false },
        ]);
        expect(offeredTools).toEqual([["codemode"], ["codemode"]]);
        expect(callableTools.every((names) => names.includes("post_hold"))).toBe(true);
        expect(sentinels).toBe(alteration === "none" ? 1 : 0);
        expect(result?.isError, JSON.stringify(result)).toBe(alteration !== "none");
        expect(JSON.stringify(result?.details)).not.toContain("REPLAY_CANARY");
        expect(JSON.stringify(result?.output)).not.toContain("REPLAY_CANARY");
        expect(JSON.stringify(result)).not.toContain("CHANGED_CANARY");
        expect(JSON.stringify(result)).not.toContain("PENDING_CANARY");
        expect(JSON.stringify(result)).not.toContain("CHANGED_PENDING_CANARY");
        expect(result?.details).toMatchObject({
          charts: [{ kind: "bar", title: "private chart", bars: [{ label: "one", value: 1 }] }],
        });
        if (alteration === "none") {
          expect(inventory().slice(0, 2)).toEqual(admitted);
          expect(inventory().slice(2)).toEqual([
            { taskId: expect.any(Number), parent: outer, key: "c4", name: "post_hold" },
          ]);
          expect(JSON.stringify(result?.output)).toContain("continued");
        } else {
          expect(inventory()).toEqual(admitted);
          // Existing-key executeTool calls can reject changed arguments without admitting a task.
          for (const call of callbacks.filter(({ reopening }) => reopening))
            expect(admitted.some(({ name, key }) => name === call.name && key === call.key)).toBe(
              true,
            );
          const output = result?.output;
          if (alteration === "authorization")
            expect(JSON.stringify(output)).toContain("Current authorization denied");
          else if (alteration === "unsafe")
            expect(JSON.stringify(output)).toMatch(/interrupted.*may have partially run/);
          else if (alteration === "version")
            expect(output).toEqual([
              {
                type: "text",
                text: `The script cannot resume: it started under code mode version ${CODEMODE_MODULE_VERSION + 1}, this is ${CODEMODE_MODULE_VERSION}.`,
              },
            ]);
          else if (alteration === "deadline")
            expect(output).toEqual([
              {
                type: "text",
                text: "Script timed out: its deadline passed while it was interrupted.",
              },
            ]);
          else if (alteration === "fingerprint")
            expect(output).toEqual([
              {
                type: "text",
                text: expect.stringMatching(
                  /^The script cannot resume: the sandbox changed since it started \(changed-engine -> .+\)\.$/,
                ),
              },
            ]);
          else
            expect(output).toEqual([
              { type: "text", text: "The script cannot resume: its call history changed." },
            ]);
          if (alteration === "version" || alteration === "deadline") {
            expect(vmStarts.filter(Boolean)).toHaveLength(0);
            expect(callbacks.filter(({ reopening }) => reopening)).toEqual([]);
          }
        }
      } finally {
        await harness.close(context);
        await bundle.close();
        await authority.close();
        sandboxTrace.mockRestore();
        if (tracing) console.info("native-replay-trace", JSON.stringify({ alteration, events }));
      }
    });
  }
});
