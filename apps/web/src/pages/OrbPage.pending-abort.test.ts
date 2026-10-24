import type { OrbMessageView } from "@pi-orb/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Composer } from "../components/Composer.tsx";
import { canAbortComposer, initialState, pendingAbortOperation, reducer } from "./OrbPage.tsx";

const message = { id: "queued-user", status: "queued" } as OrbMessageView;
it("renders an enabled Abort control during initial resource preparation", () => {
  const state = {
    ...initialState("orb"),
    connection: "open" as const,
    welcome: { capabilities: ["abort"] } as NonNullable<ReturnType<typeof initialState>["welcome"]>,
  };
  const canAbort = canAbortComposer(state, [message], true);
  expect(canAbort).toBe(true);
  const noop = () => undefined;
  const html = renderToStaticMarkup(
    createElement(Composer, {
      text: "",
      mode: "message",
      onValueChange: noop,
      images: [],
      onImageAdd: noop,
      onImageRemove: noop,
      canSend: true,
      onSend: noop,
      canAbort,
      onAbort: noop,
    }),
  );
  expect(html).toMatch(/<button[^>]*aria-label="abort"/);
  expect(html).not.toMatch(/<button[^>]*disabled[^>]*aria-label="abort"/);
  expect(canAbortComposer({ ...state, connection: "closed" }, [message], true)).toBe(false);
});
it("offers the queued user identity before native root initialization without treating it as committed", () => {
  expect(pendingAbortOperation(null, [message], true)).toBe("inbox:queued-user");
  expect(pendingAbortOperation(null, [message], false)).toBeNull();
  expect(pendingAbortOperation("native", [message], true)).toBe("native");
  expect(pendingAbortOperation(null, [{ ...message, status: "failed" }], true)).toBeNull();
  expect(
    pendingAbortOperation(
      null,
      [{ ...message, system: { kind: "sleep_expired" } } as OrbMessageView],
      true,
    ),
  ).toBeNull();
});

it("keeps Abort available while a restored operation shows a parking notice", () => {
  const state = {
    ...initialState("orb"),
    connection: "open" as const,
    activity: "busy" as const,
    operationId: "restored-operation",
    serverError: {
      code: "central_agent_paused",
      message: "Agent paused; abort the interrupted turn to continue",
    },
    welcome: { capabilities: ["abort"] } as NonNullable<ReturnType<typeof initialState>["welcome"]>,
  };
  expect(canAbortComposer(state, [], true)).toBe(true);
  expect(pendingAbortOperation(state.operationId, [], true)).toBe("restored-operation");
});

it.each(["central_agent_paused", "central_agent_report"])(
  "settling the turn clears only a parking notice (%s)",
  (code) => {
    const state = {
      ...initialState("orb"),
      connection: "open" as const,
      activity: "busy" as const,
      operationId: "restored-operation",
      serverError: { code, message: "notice" },
    };
    const settled = reducer(state, {
      type: "frame",
      frame: {
        v: 1,
        type: "runtime.event",
        at: new Date(0).toISOString(),
        event: {
          type: "operation_finished",
          operationId: "restored-operation",
          outcome: "aborted",
        },
      },
    });
    expect(settled.serverError).toEqual(code === "central_agent_paused" ? null : state.serverError);
  },
);
