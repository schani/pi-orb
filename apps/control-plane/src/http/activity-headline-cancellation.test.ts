import { NoSimulationTask } from "determined";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { ok, ResultAsync } from "neverthrow";
import { expect, it } from "vitest";
import { makeHarness, makeOrbRow, makeProjectRow, TEST_SYSTEM_VIEW } from "../testkit/fixtures.ts";
import { registerRoutes } from "./routes.ts";

it("bodyless POST survives normal IncomingMessage close; premature response close cancels only its inference", async () => {
  const task = new NoSimulationTask("response cancellation", false);
  const h = makeHarness();
  h.store.seedProject(makeProjectRow("project"));
  h.store.seedOrb(makeOrbRow("orb", "project", "stopped"));
  await h.store.commitPullBatch(task, {
    orbId: "orb",
    expectedCursor: null,
    session: { id: "session", overflow: {} },
    records: [
      {
        id: "record",
        parentId: null,
        overflow: {},
        timestamp: "2026-10-04T00:00:00Z",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "tool_call",
            callId: "call",
            name: "codemode",
            arguments: { code: "Inspect configuration" },
          },
        ],
      },
    ],
    nextCursor: "record",
    nextHeadId: "record",
  });
  const signals: AbortSignal[] = [];
  const requests: FastifyRequest[] = [];
  const replies: FastifyReply[] = [];
  const gate = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  const started = [gate(), gate()];
  const finished = [gate(), gate()];
  const app = Fastify({ logger: false });
  app.addHook("onRequest", async (request, reply) => {
    requests.push(request);
    replies.push(reply);
  });
  registerRoutes(
    app,
    task,
    {
      ...h.deps,
      headlineGenerator: {
        generate: (_task, _input, context) => {
          const index = signals.length;
          signals.push(context.signal);
          started[index]!.resolve();
          return new ResultAsync(finished[index]!.promise.then(() => ok(`Headline ${index}`)));
        },
      },
    },
    TEST_SYSTEM_VIEW,
  );
  try {
    const first = app
      .inject({
        method: "POST",
        url: "/api/v1/orbs/orb/headlines/record/record%3A0?sessionId=session",
      })
      .then(
        (value) => value,
        (error) => error as Error,
      );
    await started[0]!.promise;
    requests[0]!.raw.emit("close");
    expect(signals[0]!.aborted).toBe(false);
    const second = app.inject({
      method: "POST",
      url: "/api/v1/orbs/orb/headlines/record/record%3A0?sessionId=session",
    });
    await started[1]!.promise;
    replies[0]!.raw.emit("close");
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
    finished[0]!.resolve();
    finished[1]!.resolve();
    expect(await first).toMatchObject({ message: "response destroyed before completion" });
    expect((await second).statusCode).toBe(200);
    expect(requests[1]!.raw.listenerCount("aborted")).toBe(0);
  } finally {
    for (const finish of finished) finish.resolve();
    await app.close();
  }
});
