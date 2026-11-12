import { join } from "node:path";
import { ok } from "neverthrow";
import { expect, it } from "vitest";
import { ComposedClaudeFixture, ScheduledClaudeQuery } from "../testkit/claude-composed.ts";
import { ClaudeOrbAgent } from "./agent.ts";
import { ClaudeHistory } from "./history.ts";

const request = { v: 1 as const, requestId: "alert-request", message: "<b>Attention</b>\nDetails" };

it("persists and publishes typed Claude alerts", async () => {
  const f = new ComposedClaudeFixture();
  try {
    expect((await f.attach()).isOk()).toBe(true);
    const response = f.agent.appendAlert(request)._unsafeUnwrap();
    expect(response).toEqual({ v: 1, id: expect.any(String), duplicate: false });
    const expected = {
      id: response.id,
      type: "event",
      eventType: "pi-orb.alert",
      alert: { requestId: request.requestId, message: request.message },
      content: [{ type: "text", text: request.message }],
    };
    expect(f.history.view.find((record) => record.id === response.id)).toMatchObject(expected);
    const reloaded = new ClaudeHistory(
      join(f.dir, "claude"),
      f.state.id,
      f.state.timestamp,
      f.files,
    );
    expect(reloaded.view.find((record) => record.id === response.id)).toMatchObject(expected);
    expect(
      f.frames.filter(
        (frame) => frame.type === "history.record" && frame.record.id === response.id,
      ),
    ).toMatchObject([{ record: expected, headId: response.id }]);
    expect(
      f.agent
        .snapshot()
        ._unsafeUnwrap()
        .records.find((record) => record.id === response.id),
    ).toMatchObject(expected);
  } finally {
    f.dispose();
  }
});

it.each([false, true])(
  "deduplicates Claude alerts and rejects conflicts (restart=%s)",
  async (restart) => {
    const f = new ComposedClaudeFixture();
    try {
      expect((await f.attach()).isOk()).toBe(true);
      const response = f.agent.appendAlert(request)._unsafeUnwrap();
      let agent = f.agent;
      let history = f.history;
      if (restart) {
        history = new ClaudeHistory(join(f.dir, "claude"), f.state.id, f.state.timestamp, f.files);
        agent = new ClaudeOrbAgent({
          orbId: "orb-a",
          repositoryUrl: "https://example.com/repo",
          workDir: f.dir,
          skillsDir: null,
          broker: null,
          files: f.files,
          sdkFactory: (input, options) => {
            const query = new ScheduledClaudeQuery(input, options, true);
            return ok({
              query,
              exited: query.processExit.promise,
              stdoutEnded: query.stdoutEnded,
              requestShutdown: () => query.requestShutdown(),
            });
          },
        });
        agent.subscribe((frame) => f.frames.push(frame));
        expect((await agent.attachSession(f.state, history, f.configDir, "commit-0")).isOk()).toBe(
          true,
        );
      }
      const before = f.frames.length;
      const recordsBefore = history.view.length;
      expect(agent.appendAlert(request)._unsafeUnwrap()).toEqual({ ...response, duplicate: true });
      expect(agent.appendAlert({ ...request, message: "different" })._unsafeUnwrapErr()).toEqual({
        code: "conflict",
        message: "Alert request id conflicts.",
      });
      expect(f.frames).toHaveLength(before);
      expect(history.view).toHaveLength(recordsBefore);
      expect(
        history.view.filter((record) => record.type === "event" && record.alert !== undefined),
      ).toMatchObject([
        { id: response.id, alert: { requestId: request.requestId, message: request.message } },
      ]);
    } finally {
      f.dispose();
    }
  },
);

it("does not acknowledge or publish a Claude alert when persistence fails", async () => {
  const f = new ComposedClaudeFixture();
  try {
    expect((await f.attach()).isOk()).toBe(true);
    const before = f.frames.length;
    const recordsBefore = f.history.view.length;
    f.failCommit = true;
    expect(f.agent.appendAlert(request)._unsafeUnwrapErr()).toMatchObject({ code: "unavailable" });
    expect(f.frames).toHaveLength(before);
    expect(f.history.view).toHaveLength(recordsBefore);
    f.failCommit = false;
    const response = f.agent.appendAlert(request)._unsafeUnwrap();
    expect(response.duplicate).toBe(false);
    expect(f.history.view.find((record) => record.id === response.id)).toMatchObject({
      alert: { requestId: request.requestId, message: request.message },
    });
  } finally {
    f.dispose();
  }
});

it("rejects Claude alerts before readiness", () => {
  const f = new ComposedClaudeFixture();
  try {
    expect(f.agent.appendAlert(request)._unsafeUnwrapErr()).toMatchObject({ code: "unavailable" });
    expect(f.history.view).toEqual([]);
    expect(f.frames).toEqual([]);
  } finally {
    f.dispose();
  }
});
