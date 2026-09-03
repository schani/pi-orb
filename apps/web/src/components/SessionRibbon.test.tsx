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

  it("persistently explains expired auth and offers reauthentication", () => {
    reportAuthenticationRequired(beginSessionRequest());
    const html = renderToStaticMarkup(<SessionRibbon />);

    expect(html).toContain('class="session-ribbon"');
    expect(html).toContain("Your pi-orb session expired.");
    expect(html).toContain("Changes and live updates may be paused.");
    expect(html).toContain("sign in again");
  });
});
