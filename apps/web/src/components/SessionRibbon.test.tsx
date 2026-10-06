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

  it("offers explicit sign-in for an unauthenticated public shell", () => {
    reportAuthenticationRequired(beginSessionRequest());
    const html = renderToStaticMarkup(<SessionRibbon />);

    expect(html).toContain('class="session-ribbon"');
    expect(html).toContain("sign in required");
    expect(html).toContain("sign in</button>");
    expect(html).not.toContain("may be paused");
  });
});
