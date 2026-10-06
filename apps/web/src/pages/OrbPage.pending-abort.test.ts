import type { OrbMessageView } from "@pi-orb/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Composer } from "../components/Composer.tsx";
import { canAbortComposer, initialState, pendingAbortOperation } from "./OrbPage.tsx";

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
