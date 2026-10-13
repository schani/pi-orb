import { Result } from "neverthrow";

export interface ClaudeQueryError {
  readonly message: string;
  readonly diagnostics?: string;
}

/** Per-query, bounded diagnostics; arbitrary error payload fields are never serialized. */
export class ClaudeDiagnostics {
  private tail = "";
  private exit = "";
  private readonly secrets: readonly string[];
  constructor(secrets: readonly string[]) {
    this.secrets = secrets;
  }

  stderr(chunk: string): void {
    this.tail += chunk;
    if (this.tail.length > 32768) {
      this.tail = this.tail.slice(-32768);
      // Drop a partial line, which could contain the suffix of a truncated credential.
      const newline = this.tail.indexOf("\n");
      this.tail = newline < 0 ? "" : this.tail.slice(newline + 1);
    }
  }

  exited(code: number | null, signal: string | null): void {
    this.exit = `exitCode=${code ?? "null"} signal=${signal ?? "none"}`;
  }

  private redact(text: string): string {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strip terminal escape sequences before matching credentials.
    let value = text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
    for (const secret of [...this.secrets].filter(Boolean).sort((a, b) => b.length - a.length)) {
      const encodedSecret = Result.fromThrowable(
        () => encodeURIComponent(secret),
        () => secret,
      )().unwrapOr(secret);
      for (const encoded of [secret, encodedSecret, JSON.stringify(secret).slice(1, -1)]) {
        value = value.split(encoded).join("[redacted]");
      }
    }
    return (
      value
        .replace(/(https?:\/\/)(?:[^/\s"'<>]*@)?([^?\s"'<>#]+)(?:[?#][^\s"'<>]*)?/gi, "$1$2")
        .replace(/\b(?:Bearer|Basic)\s+[^\s"',;}]+/gi, "[redacted]")
        .replace(
          /\bsk-[A-Za-z0-9_-]+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
          "[redacted]",
        )
        .replace(
          /((?:[\w-]{0,64}(?:token|secret|password|api[_-]?key|authorization)[\w-]{0,64})["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
          "$1[redacted]",
        )
        // biome-ignore lint/suspicious/noControlCharactersInRegex: remove control bytes while retaining newlines and tabs.
        .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    );
  }

  capture(error: unknown): { message: string; diagnostics: string } {
    const extracted = Result.fromThrowable(
      () => {
        const messages: string[] = [];
        const details: string[] = [];
        let current = error;
        for (let depth = 0; current !== undefined && depth < 4; depth++) {
          const value = current as { message?: unknown; code?: unknown } | null;
          const message =
            typeof current === "string"
              ? current
              : typeof value?.message === "string"
                ? value.message
                : "Unknown error";
          messages.push(message);
          details.push(current instanceof Error ? (current.stack ?? message) : message);
          if (typeof value?.code === "string" || typeof value?.code === "number")
            details.push(`code=${value.code}`);
          current = current instanceof Error ? current.cause : undefined;
        }
        return {
          message: messages.join(": caused by: ") || "Unknown error",
          diagnostics: details.join("\nCaused by:\n"),
        };
      },
      () => undefined,
    )().unwrapOr({ message: "Unknown error", diagnostics: "Unreadable error" });
    const stderr = this.redact(this.tail);
    const stderrLine = stderr.trim().split("\n").at(-1);
    return {
      message: this.redact(extracted.message + (stderrLine ? `; stderr: ${stderrLine}` : ""))
        .replace(/\s+/g, " ")
        .slice(0, 1024),
      diagnostics:
        `${this.redact(extracted.diagnostics).slice(0, 8192)}\n${this.exit}\nstderr:\n${stderr.slice(-8192)}`.slice(
          0,
          16384,
        ),
    };
  }
}
