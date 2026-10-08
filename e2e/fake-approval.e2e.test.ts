import { expect, it, vi } from "vitest";
import { createFakeSession, deleteFakeSession, fakeControl, fakeRequest } from "./harness.ts";

it.each([false, true])(
  "replays device approval safely after transport loss (accepted=%s)",
  async (accepted) => {
    const session = await createFakeSession("approval-replay-contract", {
      auth: { device: { manualApprove: true } },
    });
    const oauth = `/oai/${session.sessionKey}`;
    try {
      const response = await fakeRequest("POST", `${oauth}/api/accounts/deviceauth/usercode`, {
        body: { client_id: "approval-contract" },
        retryTransport: false,
      });
      expect(response.status).toBe(200);
      const code = (await response.json()) as Record<string, string>;
      const originalFetch = globalThis.fetch;
      let approvalCalls = 0;
      let acceptedStatus: number | undefined;
      let acceptedBody: unknown;
      const intercepted = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        if (String(url).endsWith("/deviceauth/approve")) {
          approvalCalls += 1;
          if (approvalCalls === 1) {
            if (accepted) {
              const approval = await originalFetch(url, init);
              acceptedStatus = approval.status;
              acceptedBody = await approval.json();
            }
            throw new DOMException("controlled approval response loss", "TimeoutError");
          }
        }
        return originalFetch(url, init);
      });
      try {
        expect(
          await fakeControl(session.sessionKey, "/deviceauth/approve", {
            user_code: code["user_code"],
          }),
        ).toEqual({ approved: true });
        expect(approvalCalls).toBe(2);
        if (accepted) {
          expect(acceptedStatus).toBe(200);
          expect(acceptedBody).toEqual({ approved: true });
        }
      } finally {
        intercepted.mockRestore();
      }

      const approvedState = await fakeControl(session.sessionKey, "/state");
      expect(Array.isArray(approvedState["deviceAuths"]) && approvedState["deviceAuths"].length).toBe(1);
      expect(approvedState["tokens"]).toEqual([]);

      const poll = await fakeRequest("POST", `${oauth}/api/accounts/deviceauth/token`, {
        body: code,
        retryTransport: false,
      });
      expect(poll.status).toBe(200);
      const grant = (await poll.json()) as Record<string, string>;
      const exchange = await originalFetch(`${session.oauthBaseUrl}/oauth/token`, {
        method: "POST",
        signal: AbortSignal.timeout(15_000),
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: grant["authorization_code"] ?? "",
          code_verifier: grant["code_verifier"] ?? "",
        }),
      });
      expect(exchange.status).toBe(200);
      await exchange.arrayBuffer();
      expect(
        await fakeControl(session.sessionKey, "/deviceauth/approve", {
          user_code: code["user_code"],
        }),
      ).toEqual({ approved: true });
      const state = await fakeControl(session.sessionKey, "/state");
      expect(Array.isArray(state["deviceAuths"]) && state["deviceAuths"].length).toBe(1);
      expect(Array.isArray(state["tokens"]) && state["tokens"].length).toBe(1);
    } finally {
      await deleteFakeSession(session.sessionKey);
    }
  },
);
