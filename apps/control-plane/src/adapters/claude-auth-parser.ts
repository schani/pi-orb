import type { ClaudeAuthView } from "@pi-orb/protocol";

/** Output grammar pinned to Claude Code 2.1.289; raw output remains private. */
export class ClaudeSetupTokenParser {
  private raw = "";
  private submittedInput = "";
  redactInput(code: string): void {
    this.submittedInput = code;
    this.raw = "";
  }
  inputAccepted(): boolean {
    if (this.submittedInput === "") return false;
    // Native diff rendering may omit unchanged masks. A cursor-positioned
    // masked redraw acknowledges the paste; mask counts are not input length.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Native terminal cursor positioning accompanies the masked redraw.
    return /\x1b\[\d*A[\s\S]*\*+|\*+[\s\S]*\x1b\[\d*A/.test(this.raw);
  }
  nativeFailure():
    | { error: string; reason: "network" | "code_rejected" | "authentication" }
    | undefined {
    const text = this.text();
    if (/\b(?:EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EPERM|EACCES)\b/.test(text))
      return { error: "Claude sign-in network request failed", reason: "network" };
    if (text.includes("Invalid code. Please make sure the full code was copied"))
      return { error: "Claude sign-in code was rejected", reason: "code_rejected" };
    if (
      text.includes("Token exchange failed") ||
      text.includes("Failed to exchange authorization code")
    )
      return { error: "Claude sign-in authentication failed", reason: "authentication" };
    return undefined;
  }
  feed(chunk: string): void {
    this.raw = (this.raw + chunk).slice(-65536);
  }
  private text(): string {
    const text = this.raw
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Terminal CSI bytes are the parser input.
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Terminal OSC bytes are the parser input.
      .replace(/\x1b\][^\x07]*?(?:\x07|\x1b\\)/g, "");
    return this.submittedInput === "" ? text : text.split(this.submittedInput).join("");
  }
  challenge(): NonNullable<ClaudeAuthView["challenge"]> {
    const text = this.text();
    const needsCode = text.replace(/\s/g, "").includes("Pastecodehereifprompted>");
    let candidate: string | undefined;
    if (needsCode) {
      // Lookahead also finds a URL following an ANSI cursor redraw without whitespace.
      for (const match of text.matchAll(
        // biome-ignore lint/suspicious/noControlCharactersInRegex: An escape terminates a terminal URL.
        /(?=(https:\/\/(?:claude\.ai\/oauth|claude\.com\/cai\/oauth)\/authorize\?[^\s\x1b]+(?=[\s\x1b])))/g,
      )) {
        const matchedUrl = match[1];
        if (matchedUrl === undefined) continue;
        const url = new URL(matchedUrl);
        const p = url.searchParams;
        const fields = [
          "client_id",
          "response_type",
          "redirect_uri",
          "scope",
          "code_challenge",
          "code_challenge_method",
          "state",
        ];
        if (
          fields.every((field) => p.getAll(field).length === 1) &&
          p.get("code") === "true" &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            p.get("client_id") ?? "",
          ) &&
          p.get("response_type") === "code" &&
          p.get("redirect_uri") === "https://platform.claude.com/oauth/code/callback" &&
          p.get("scope") === "user:inference" &&
          p.get("code_challenge_method") === "S256" &&
          /^[A-Za-z0-9_-]{43}$/.test(p.get("code_challenge") ?? "") &&
          /^[A-Za-z0-9_-]{43}$/.test(p.get("state") ?? "")
        )
          candidate = match[1];
      }
    }
    return {
      ...(candidate === undefined ? {} : { url: candidate }),
      ...(needsCode ? { needsCode: true } : {}),
    };
  }
  finish(exitCode: number): { token: string } | { error: string } {
    if (exitCode !== 0) {
      this.raw = "";
      return { error: "Claude sign-in failed" };
    }
    const text = this.text();
    const token = text.replace(/\s/g, "").includes("YourOAuthtoken(validfor")
      ? text.match(/sk-ant-oat01-[A-Za-z0-9_-]+/)?.[0]
      : undefined;
    this.raw = "";
    return token === undefined ? { error: "Claude sign-in output was not recognized" } : { token };
  }
}
