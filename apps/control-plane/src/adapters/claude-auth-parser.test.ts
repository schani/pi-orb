import { describe, expect, it } from "vitest";
import { ClaudeSetupTokenParser } from "./claude-auth-parser.ts";

const nativeUrl = `https://claude.com/cai/oauth/authorize?code=true&client_id=00000000-0000-0000-0000-000000000000&response_type=code&redirect_uri=${encodeURIComponent("https://platform.claude.com/oauth/code/callback")}&scope=user%3Ainference&code_challenge=${"c".repeat(43)}&code_challenge_method=S256&state=${"s".repeat(43)}`;
const prompt = "\nPaste code here if prompted > ";

describe("Claude 2.1.289 setup-token parser", () => {
  it("publishes only a complete native consent URL after the code prompt", () => {
    const p = new ClaudeSetupTokenParser();
    p.feed(`${nativeUrl.slice(0, 240)}\n`);
    expect(p.challenge()).toEqual({});
    p.feed(nativeUrl.slice(240) + prompt);
    expect(p.challenge()).toEqual({ needsCode: true });
    p.feed(nativeUrl);
    expect(p.challenge()).toEqual({ needsCode: true });
    p.feed(prompt);
    expect(p.challenge()).toEqual({ url: nativeUrl, needsCode: true });
  });
  it("waits for the prompt and handles native ANSI cursor redraws", () => {
    const p = new ClaudeSetupTokenParser();
    p.feed(`${nativeUrl}\n`);
    expect(p.challenge()).toEqual({});
    p.feed(prompt);
    expect(p.challenge()).toEqual({ url: nativeUrl, needsCode: true });
    const redraw = new ClaudeSetupTokenParser();
    redraw.feed(`${nativeUrl}\u001b[1G${nativeUrl}${prompt}`);
    expect(redraw.challenge()).toEqual({ url: nativeUrl, needsCode: true });
  });
  it("rejects partial PKCE fields, wrong ports and foreign origins", () => {
    for (const url of [
      nativeUrl.replace("&code_challenge_method=S256", ""),
      nativeUrl.replace("claude.com/", "claude.com:444/"),
      nativeUrl.replace("claude.com/", "claude.com.evil/"),
      nativeUrl.replace("s".repeat(43), "s"),
    ]) {
      const p = new ClaudeSetupTokenParser();
      p.feed(url + prompt);
      expect(p.challenge()).toEqual({ needsCode: true });
    }
  });
  it("buffers split ANSI, URLs and tokens without exposing raw output", () => {
    const p = new ClaudeSetupTokenParser();
    p.feed("\u001b[");
    p.feed(`32mBrowser didn't open? Use the url below to sign in\n${nativeUrl}${prompt}\u001b[0m`);
    expect(p.challenge()).toEqual({
      url: nativeUrl,
      needsCode: true,
    });
    p.feed("Your OAuth token (valid for 1 year):\nsk-ant-oat01-secret\nStore this token securely.");
    expect(p.finish(0)).toEqual({ token: "sk-ant-oat01-secret" });
    expect(JSON.stringify(p.challenge())).not.toContain("secret");
  });
  it("rejects unknown output and untrusted URL origins", () => {
    const p = new ClaudeSetupTokenParser();
    p.feed("https://evil.example/?token=secret\nunknown secret");
    expect(p.challenge()).toEqual({});
    expect(p.finish(0)).toEqual({ error: "Claude sign-in output was not recognized" });
  });
  it("does not accept submitted input echoes as issued tokens", () => {
    const p = new ClaudeSetupTokenParser();
    p.redactInput("sk-ant-oat01-echo");
    p.feed("sk-ant-oat01-echo\nYour OAuth token (valid for 1 year):\nsk-ant-oat01-issued\n");
    expect(p.finish(0)).toEqual({ token: "sk-ant-oat01-issued" });
  });
  it("recognizes native redraw completion, not prompt text or partial masks", () => {
    const p = new ClaudeSetupTokenParser();
    p.feed(`**************${prompt}`);
    p.redactInput("synthetic#state");
    expect(p.inputAccepted()).toBe(false);
    p.feed("\u001b[32m*******");
    expect(p.inputAccepted()).toBe(false);
    p.feed("********\u001b[0m");
    expect(p.inputAccepted()).toBe(false);
    p.feed("\u001b[31C\u001b[");
    expect(p.inputAccepted()).toBe(false);
    p.feed("1A");
    expect(p.inputAccepted()).toBe(true);
  });
  it("accepts a diff redraw without assuming masks equal input length", () => {
    const p = new ClaudeSetupTokenParser();
    p.redactInput("synthetic".repeat(100));
    p.feed("*".repeat(43));
    expect(p.inputAccepted()).toBe(false);
    p.feed("\u001b[31C\u001b[1A");
    expect(p.inputAccepted()).toBe(true);
  });
  it("classifies native failures without retaining hostnames or echoed code", () => {
    const p = new ClaudeSetupTokenParser();
    p.redactInput("synthetic#state");
    p.feed("synthetic#state getaddrinfo EAI_AGAIN private-host\n");
    expect(p.nativeFailure()).toEqual({
      error: "Claude sign-in network request failed",
      reason: "network",
    });
    const invalid = new ClaudeSetupTokenParser();
    invalid.feed("Invalid code. Please make sure the full code was copied");
    expect(invalid.nativeFailure()).toEqual({
      error: "Claude sign-in code was rejected",
      reason: "code_rejected",
    });
  });
  it("never accepts a token on unsuccessful exit", () => {
    const p = new ClaudeSetupTokenParser();
    p.feed("Your OAuth token (valid for 1 year):\nsk-ant-oat01-secret\n");
    expect(p.finish(1)).toEqual({ error: "Claude sign-in failed" });
  });
});
