import { ok } from "neverthrow";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ClaudeAuthController } from "../lib/claude-auth.ts";
import { ClaudeAuthButton, ClaudeAuthViewPanel } from "./ClaudeAuth.tsx";

it("labels dashboard management without promising a new connection", () => {
  const html = renderToStaticMarkup(<ClaudeAuthButton label="Claude" />);
  expect(html).toContain('class="text-action"');
  expect(html).toContain('title="Claude connection"');
  expect(html).toContain(">Claude</button>");
  expect(html).not.toContain("Connect Claude");
  expect(html).not.toContain("<svg");
});

const props = {
  pending: false,
  error: null,
  code: "",
  onCode: () => {},
  onAction: () => {},
  onRetry: () => {},
};
it("unknown status is read-only until a successful status read", () => {
  const html = renderToStaticMarkup(<ClaudeAuthViewPanel {...props} view={null} />);
  expect(html).toContain("Loading…");
  expect(html).not.toContain("Connect Claude subscription");
});
it("shows subscription connection without token provisioning", () => {
  const html = renderToStaticMarkup(
    <ClaudeAuthViewPanel {...props} view={{ status: "disconnected" }} />,
  );
  expect(html).toContain("Connect Claude subscription");
  expect(html).not.toContain("token");
});
it("shows browser consent and an ephemeral completion-code form", () => {
  const html = renderToStaticMarkup(
    <ClaudeAuthViewPanel
      {...props}
      view={{
        status: "connecting",
        challenge: { url: "https://claude.ai/consent", needsCode: true },
      }}
    />,
  );
  expect(html).toContain('href="https://claude.ai/consent"');
  expect(html).toContain('aria-label="Claude completion code"');
  expect(html).toContain('autoComplete="off"');
  expect(html).toContain("Cancel connection");
});
it("shows accepted completion as waiting, not another empty code prompt", () => {
  const html = renderToStaticMarkup(
    <ClaudeAuthViewPanel
      {...props}
      completing
      view={{
        status: "connecting",
        challenge: { url: "https://claude.ai/consent", needsCode: true },
      }}
    />,
  );
  expect(html).toContain("Completing connection…");
  expect(html).not.toContain("Claude completion code");
  expect(html).not.toContain("Sign in with Anthropic");
  expect(html).not.toContain("Claude connected");
  expect(html).toContain("Cancel connection");
});
it("shows generic waiting for server-side connection without a challenge", () => {
  const html = renderToStaticMarkup(
    <ClaudeAuthViewPanel {...props} view={{ status: "connecting" }} />,
  );
  expect(html).toContain('<div role="status">Connecting…</div>');
  expect(html).toContain("Cancel connection");
  expect(html).not.toContain("Completing connection…");
  expect(html).not.toContain("Claude completion code");
});
it("shows server-side waiting on initial read and dialog remount without inventing completion", async () => {
  const dependencies = {
    read: async () => ok({ status: "connecting" } as const),
    write: async () => ok({ status: "connecting" } as const),
    visible: () => true,
    schedule: () => () => {},
  };
  const render = (controller: ClaudeAuthController) =>
    renderToStaticMarkup(<ClaudeAuthViewPanel {...props} {...controller.snapshot} />);
  const initial = new ClaudeAuthController(dependencies);
  await initial.start();
  expect(initial.snapshot.completing).toBe(false);
  expect(render(initial)).toContain("Connecting…");
  await initial.act("code", "synthetic-completion-code");
  expect(render(initial)).toContain("Completing connection…");
  initial.dispose();
  const reopened = new ClaudeAuthController(dependencies);
  await reopened.start();
  expect(reopened.snapshot.completing).toBe(false);
  expect(render(reopened)).toContain("Connecting…");
  expect(render(reopened)).not.toContain("Completing connection…");
  reopened.dispose();
});
it("keeps safe errors visible while completion is waiting", () => {
  const html = renderToStaticMarkup(
    <ClaudeAuthViewPanel
      {...props}
      completing
      error="Status unavailable"
      view={{ status: "connecting", challenge: { needsCode: true } }}
    />,
  );
  expect(html).toContain("Status unavailable");
  expect(html).toContain("Retry");
  expect(html).toContain("Completing connection…");
});
it("accepts the native claude.com consent host", () => {
  const html = renderToStaticMarkup(
    <ClaudeAuthViewPanel
      {...props}
      view={{
        status: "connecting",
        challenge: { url: "https://claude.com/cai/oauth/authorize?state=opaque" },
      }}
    />,
  );
  expect(html).toContain('href="https://claude.com/cai/oauth/authorize?state=opaque"');
});
it("does not render an empty or unsafe consent link", () => {
  for (const url of ["", "javascript:alert(1)", "https://example.com"]) {
    const html = renderToStaticMarkup(
      <ClaudeAuthViewPanel {...props} view={{ status: "connecting", challenge: { url } }} />,
    );
    expect(html).not.toContain("href=");
  }
});
it("shows popup failures beside the direct native consent fallback", () => {
  const html = renderToStaticMarkup(
    <ClaudeAuthViewPanel
      {...props}
      launchError={{ type: "popup_blocked" }}
      view={{
        status: "connecting",
        challenge: { url: "https://claude.ai/consent", needsCode: true },
      }}
    />,
  );
  expect(html).toContain("Sign-in tab was blocked");
  expect(html).toContain('href="https://claude.ai/consent"');
  expect(html).toContain("Claude completion code");
});
it("exposes safe failure, retry, reconnect, and disconnect", () => {
  expect(
    renderToStaticMarkup(
      <ClaudeAuthViewPanel {...props} view={{ status: "failed", error: "Sign-in failed" }} />,
    ),
  ).toContain("Sign-in failed");
  const html = renderToStaticMarkup(
    <ClaudeAuthViewPanel {...props} view={{ status: "connected" }} />,
  );
  expect(html).toContain("Reconnect Claude");
  expect(html).toContain("Disconnect Claude");
});
