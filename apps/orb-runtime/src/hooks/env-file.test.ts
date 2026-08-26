import { describe, expect, it } from "vitest";
import { HOOK_ENV_DENIED, hookEnvPath, parseHookEnvFile } from "./env-file.ts";

const parse = (...lines: string[]): ReturnType<typeof parseHookEnvFile> =>
  parseHookEnvFile(lines.join("\n"));

describe("the hook env file's path", () => {
  it("lives in the persistent home, so it survives compute replacement", () => {
    expect(hookEnvPath("/workspace/home")).toBe("/workspace/home/.pi-orb/env");
  });
});

describe("parsing the hook env file", () => {
  it("reads one KEY=VALUE per line", () => {
    const parsed = parse("FOO=bar", "BAZ=qux");
    expect([...parsed.entries]).toEqual([
      ["FOO", "bar"],
      ["BAZ", "qux"],
    ]);
    expect(parsed.malformed).toEqual([]);
    expect(parsed.ignored).toEqual([]);
  });

  it("ignores blank lines and comments", () => {
    const parsed = parse("", "   ", "# a comment", "  # indented comment", "FOO=bar");
    expect([...parsed.entries]).toEqual([["FOO", "bar"]]);
    expect(parsed.malformed).toEqual([]);
  });

  it("takes a value literally, expanding and interpreting nothing", () => {
    const parsed = parse(
      "URL=https://example.test/a?b=c&d=e",
      "MONEY=$HOME and $(whoami)",
      "SPACED=one two  three",
      "EMPTY=",
      "HASH=value # not a comment",
    );
    expect(parsed.entries.get("URL")).toBe("https://example.test/a?b=c&d=e");
    expect(parsed.entries.get("MONEY")).toBe("$HOME and $(whoami)");
    expect(parsed.entries.get("SPACED")).toBe("one two  three");
    expect(parsed.entries.get("EMPTY")).toBe("");
    expect(parsed.entries.get("HASH")).toBe("value # not a comment");
  });

  it("strips one matching pair of quotes and nothing more", () => {
    const parsed = parse(
      `DOUBLE="quoted value"`,
      "SINGLE='quoted value'",
      `INNER="outer 'inner' outer"`,
      `MISMATCHED="not closed`,
      `LONE="`,
      `TWICE=""wrapped""`,
    );
    expect(parsed.entries.get("DOUBLE")).toBe("quoted value");
    expect(parsed.entries.get("SINGLE")).toBe("quoted value");
    expect(parsed.entries.get("INNER")).toBe("outer 'inner' outer");
    expect(parsed.entries.get("MISMATCHED")).toBe(`"not closed`);
    expect(parsed.entries.get("LONE")).toBe(`"`);
    // Exactly one pair: the inner quotes are part of the value.
    expect(parsed.entries.get("TWICE")).toBe(`"wrapped"`);
  });

  it("keeps the last value when a name repeats", () => {
    expect(parse("FOO=first", "FOO=second").entries.get("FOO")).toBe("second");
  });

  it("reports a line it cannot parse by number, never by content", () => {
    const parsed = parse("FOO=bar", "PLAIN_NONSENSE", "export BAZ=qux", "9LIVES=cat", "OK=yes");
    expect(parsed.malformed).toEqual([
      `line 2: no "=" separator`,
      "line 3: not a variable name",
      "line 4: not a variable name",
    ]);
    for (const reason of parsed.malformed) {
      for (const secret of ["PLAIN_NONSENSE", "qux", "cat"]) {
        expect(reason).not.toContain(secret);
      }
    }
    // A bad line costs only itself; everything around it still applies.
    expect([...parsed.entries.keys()]).toEqual(["FOO", "OK"]);
  });

  it("refuses every name the runtime owns", () => {
    const parsed = parseHookEnvFile(
      [...HOOK_ENV_DENIED.map((name) => `${name}=stolen`), "MINE=ok"].join("\n"),
    );
    expect(parsed.ignored).toEqual([...HOOK_ENV_DENIED]);
    expect([...parsed.entries.keys()]).toEqual(["MINE"]);
  });

  it("owns the variables that would break the runtime's own contract", () => {
    for (const name of [
      "PI_ORB_RUNTIME_TOKEN",
      "PI_ORB_CONTROL_PLANE_URL",
      "PI_ORB_ID",
      "PI_ORB_HOST_INCARNATION",
      "PI_ORB_WORK_DIR",
      "PI_ORB_TAILSCALE_AUTH_KEY",
      "PI_ORB_TAILSCALE_HOSTNAME",
      "PI_ORB_PREVIEW_HOST",
      "PI_ORB",
      "HOME",
      "PATH",
    ]) {
      expect(HOOK_ENV_DENIED, `${name} must not be overridable by a hook`).toContain(name);
    }
  });

  it("is a no-op on an empty file", () => {
    const parsed = parseHookEnvFile("");
    expect(parsed.entries.size).toBe(0);
    expect(parsed.malformed).toEqual([]);
  });
});
