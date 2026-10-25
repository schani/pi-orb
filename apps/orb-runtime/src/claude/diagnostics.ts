import type { SDKAssistantMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { Result } from "neverthrow";

export interface ClaudeQueryError {
  readonly message: string;
  readonly diagnostics?: string;
}

/** Per-query, bounded diagnostics; arbitrary error payload fields are never serialized. */
export class ClaudeDiagnostics {
  private tail = "";
  private exit = "";
  private processExit: { code: number | null; signal: string | null } | null = null;
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
    this.processExit = { code, signal };
    this.exit = `exitCode=${code ?? "null"} signal=${signal ?? "none"}`;
  }

  isFailedResultExit(error: unknown): boolean {
    if (this.processExit?.code !== 1 || this.processExit.signal !== null) return false;
    return Result.fromThrowable(
      () => {
        const value = error as {
          errorClass?: unknown;
          exitCode?: unknown;
          signal?: unknown;
        } | null;
        return (
          value?.signal == null &&
          ((value?.errorClass === "process_exited_nonzero" && value.exitCode === 1) ||
            value?.errorClass === "error_result")
        );
      },
      () => false,
    )().unwrapOr(false);
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

  assistant(message: SDKAssistantMessage) {
    const text = this.redact(
      message.message.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n"),
    );
    return {
      category: message.error ?? "unknown",
      errorText: text.slice(0, 8192),
      apiErrorStatus: null,
      truncated: text.length > 8192,
    };
  }

  result(message: SDKResultMessage) {
    const errors = message.subtype === "success" ? [] : message.errors;
    const redactedErrors = errors.slice(0, 16).map((error) => this.redact(error));
    const text = message.subtype === "success" ? this.redact(message.result) : null;
    return {
      category: message.subtype === "success" ? "api_error" : message.subtype,
      errors: redactedErrors.map((error) => error.slice(0, 1024)),
      errorCount: errors.length,
      errorText: text === null ? null : text.slice(0, 8192),
      apiErrorStatus: message.subtype === "success" ? (message.api_error_status ?? null) : null,
      truncated:
        errors.length > 16 ||
        redactedErrors.some((error) => error.length > 1024) ||
        (text !== null && text.length > 8192),
    };
  }

  capture(error: unknown, context?: string): { message: string; diagnostics: string } {
    const extracted = Result.fromThrowable(
      () => {
        const messages: string[] = [];
        const details: string[] = [];
        let current = error;
        for (let depth = 0; current !== undefined && depth < 4; depth++) {
          const value = current as { message?: unknown; code?: unknown } | null;
          const messageValue = value?.message,
            code = value?.code;
          const stack = current instanceof Error ? current.stack : undefined;
          const message =
            typeof current === "string"
              ? current
              : typeof messageValue === "string"
                ? messageValue
                : "Unknown error";
          messages.push(message);
          details.push(typeof stack === "string" ? stack : message);
          if (typeof code === "string" || typeof code === "number") details.push(`code=${code}`);
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
    const prefix = context === undefined ? "" : `${this.redact(context).slice(0, 1024)}\n`;
    return {
      message: this.redact(extracted.message + (stderrLine ? `; stderr: ${stderrLine}` : ""))
        .replace(/\s+/g, " ")
        .slice(0, 1024),
      diagnostics:
        `${prefix}${this.redact(extracted.diagnostics).slice(0, 8192)}\n${this.exit}\nstderr:\n${stderr.slice(-8192)}`.slice(
          0,
          16384,
        ),
    };
  }
}
