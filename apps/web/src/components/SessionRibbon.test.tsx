import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import {
  beginSessionRequest,
  reportAuthenticationRequired,
  resetBrowserSessionForTest,
} from "../lib/session.ts";
import { SessionRibbon } from "./SessionRibbon.tsx";

describe("SessionRibbon", () => {
  beforeEach(resetBrowserSessionForTest);

  it("is absent while the browser session is active", () => {
    expect(renderToStaticMarkup(<SessionRibbon />)).toBe("");
  });

  it("names the expired session and offers reauthentication, nothing more", () => {
    reportAuthenticationRequired(beginSessionRequest());
    const html = renderToStaticMarkup(<SessionRibbon />);

    expect(html).toContain('class="session-ribbon"');
    expect(html).toContain("session expired");
    expect(html).toContain("sign in again");
    expect(html).not.toContain("may be paused");
  });
});
