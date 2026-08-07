import { err, ok, type Result } from "neverthrow";

export interface CopyError {
  type: "clipboard_unavailable";
}

interface CopyAdapters {
  writeText?: (text: string) => Promise<void>;
  fallbackWrite: (text: string) => boolean;
}

function copyUsingTextarea(text: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, text.length);
  const copied = document.execCommand("copy");
  textarea.remove();
  return copied;
}

function browserAdapters(): CopyAdapters {
  const writeText = navigator.clipboard?.writeText.bind(navigator.clipboard);
  return { ...(writeText === undefined ? {} : { writeText }), fallbackWrite: copyUsingTextarea };
}

/** Copies exact text, including on trusted-development HTTP origins without Clipboard API access. */
export async function copyToClipboard(
  text: string,
  adapters: CopyAdapters = browserAdapters(),
): Promise<Result<void, CopyError>> {
  if (adapters.writeText !== undefined) {
    try {
      await adapters.writeText(text);
      return ok(undefined);
    } catch {
      // Permission and secure-context failures fall through to the legacy,
      // user-gesture-driven path used by the local plain-HTTP deployment.
    }
  }

  try {
    return adapters.fallbackWrite(text) ? ok(undefined) : err({ type: "clipboard_unavailable" });
  } catch {
    return err({ type: "clipboard_unavailable" });
  }
}
