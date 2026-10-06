import { err, ok, type Result } from "neverthrow";

export type ConsentWindowError = {
  type: "popup_blocked" | "popup_closed" | "popup_unavailable" | "invalid_consent_url";
};
export interface ConsentWindow {
  navigate(url: string): Result<void, ConsentWindowError>;
  close(): Result<void, ConsentWindowError>;
}

export function consentUrl(value?: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      ["claude.ai", "claude.com", "console.anthropic.com", "platform.claude.com"].includes(
        url.hostname,
      ) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function describeConsentWindowError(error: ConsentWindowError): string {
  switch (error.type) {
    case "popup_blocked":
      return "Sign-in tab was blocked. Use the Anthropic link below.";
    case "popup_closed":
      return "Sign-in tab was closed. Use the Anthropic link below.";
    case "popup_unavailable":
      return "Could not open sign-in. Use the Anthropic link below.";
    case "invalid_consent_url":
      return "Claude returned an invalid sign-in link.";
  }
}

/** Called in the trusted click, before any owner-state request. */
export function reserveConsentWindow(
  open: () => Window | null = () => window.open("about:blank", "_blank"),
): Result<ConsentWindow, ConsentWindowError> {
  let tab: Window | null;
  try {
    tab = open();
  } catch {
    return err({ type: "popup_unavailable" });
  }
  if (tab === null) return err({ type: "popup_blocked" });
  const close = (): Result<void, ConsentWindowError> => {
    try {
      tab.close();
      return ok(undefined);
    } catch {
      return err({ type: "popup_unavailable" });
    }
  };
  try {
    tab.opener = null;
    tab.document.title = "Claude subscription";
    const body = tab.document.body;
    body.setAttribute("role", "status");
    body.textContent = "Connecting…";
    if (typeof document !== "undefined") {
      const appearance = window.getComputedStyle(document.body);
      body.style.fontFamily = appearance.fontFamily;
      body.style.fontSize = appearance.fontSize;
      body.style.lineHeight = appearance.lineHeight;
      body.style.color = appearance.color;
      body.style.backgroundColor = appearance.backgroundColor;
    }
  } catch {
    close();
    return err({ type: "popup_unavailable" });
  }
  return ok({
    close,
    navigate(value) {
      const url = consentUrl(value);
      if (url === null) return err({ type: "invalid_consent_url" });
      try {
        if (tab.closed) return err({ type: "popup_closed" });
        tab.location.replace(url);
        return ok(undefined);
      } catch {
        return err({ type: "popup_unavailable" });
      }
    },
  });
}
