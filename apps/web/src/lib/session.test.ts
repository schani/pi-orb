import { beforeEach, describe, expect, it } from "vitest";
import {
  beginSessionRequest,
  readBrowserSession,
  reportApplicationReached,
  reportAuthenticationRequired,
  resetBrowserSessionForTest,
} from "./session.ts";

describe("browser session state", () => {
  beforeEach(resetBrowserSessionForTest);

  it("enters auth-required state and recovers after a newer request reaches the app", () => {
    const failed = beginSessionRequest();
    reportAuthenticationRequired(failed);
    expect(readBrowserSession().status).toBe("auth_required");

    const probe = beginSessionRequest();
    reportApplicationReached(probe);
    expect(readBrowserSession()).toEqual({ status: "active" });
  });

  it("does not let an older concurrent success erase a later auth failure", () => {
    const oldRequest = beginSessionRequest();
    const failedRequest = beginSessionRequest();
    reportAuthenticationRequired(failedRequest);
    reportApplicationReached(oldRequest);
    expect(readBrowserSession().status).toBe("auth_required");
  });

  it("does not let an older concurrent 401 erase a later application response", () => {
    const oldRequest = beginSessionRequest();
    const newRequest = beginSessionRequest();
    reportApplicationReached(newRequest);
    reportAuthenticationRequired(oldRequest);
    expect(readBrowserSession()).toEqual({ status: "active" });
  });
});
