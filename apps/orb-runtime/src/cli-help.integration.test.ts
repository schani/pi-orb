import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { ALERT_USAGE } from "./alert/command.ts";
import { ARCHIVE_USAGE } from "./archive/command.ts";
import { DELETE_USAGE } from "./delete/command.ts";
import { HOSTING_USAGE } from "./hosting/command.ts";
import { USAGE as ID_TOKEN_USAGE } from "./id-token/token.ts";
import { INSPECTION_USAGE } from "./inspection/command.ts";
import { SEND_USAGE } from "./send/command.ts";
import { SLEEP_USAGE } from "./sleep/command.ts";
import { SPAWN_USAGE } from "./spawn/command.ts";

import { runCli } from "./testkit/cli.ts";

const commands = [
  "self",
  "orbs",
  "transcript",
  "search",
  "spawn",
  "archive",
  "delete",
  "sleep",
  "send",
  "alert",
  "host",
  "id-token",
];

function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  return runCli(args, { env: { PATH: process.env.PATH, ...env } });
}

async function help(args: string[]) {
  const result = await run(args);
  expect(result).toMatchObject({ code: 0, stderr: "" });
  return result.stdout;
}

describe("public pi-orb help", () => {
  let rootHelp: Promise<string> | undefined;
  it("prints root help to stdout without an orb environment", async () => {
    rootHelp ??= help(["--help"]);
    const root = await rootHelp;
    expect(await help(["-h"])).toBe(root);
    expect(await help(["help"])).toBe(root);
    expect(root).toContain("pi-orb help [command]");
    expect(root).toContain("pi-orb <command> --help");
    const usages = [
      SPAWN_USAGE,
      ARCHIVE_USAGE,
      DELETE_USAGE,
      SLEEP_USAGE,
      SEND_USAGE,
      ALERT_USAGE,
      HOSTING_USAGE,
      ID_TOKEN_USAGE,
      INSPECTION_USAGE,
    ];
    for (const usage of usages) {
      for (const line of usage.split("\n")) {
        const syntax = line.replace(/^usage:\s*/, "").trim();
        if (syntax) expect(root).toContain(syntax);
      }
    }
  });

  it.each(commands)(
    "supports all explicit help forms for %s without credentials",
    async (command) => {
      const output = await help([command, "--help"]);
      expect(output).toContain(`pi-orb ${command}`);
      if (command === "search") {
        expect(INSPECTION_USAGE).toContain(
          "pi-orb search QUERY [--orb ID | --project | --all] [--limit N] [--json]",
        );
        expect(output).toBe(
          "usage: pi-orb search QUERY [--orb ID | --project | --all] [--limit N] [--json]\n\nSearch your committed public history with BM25.\n",
        );
      } else {
        expect(output).toContain("Examples:");
        expect(output).toContain("Output:");
        expect(output).toContain("Retry:");
        expect(output).toContain("Exit:");
      }
      rootHelp ??= help(["--help"]);
      expect(await rootHelp).toContain(output.trimEnd());

      expect(await help([command, "-h"])).toBe(output);
      expect(await help([command, "--help", "--request-id", "help-test"])).toBe(output);
      expect(await help([command, "-h", "--json"])).toBe(output);
      expect(await help(["help", command])).toBe(output);
    },
  );

  it.each(
    Object.entries({
      self: [
        "identity",
        "dashboard",
        "project",
        "repository",
        "creation time",
        "spawning parent",
        "direct children",
        "preview hostname",
        "--json",
      ],
      orbs: [/list.*search.*account.*orbs/i, "[query]"],
      transcript: [
        /read.*conversation/i,
        /very long/i,
        /--json.*lossless structured/i,
        /active.*replicated snapshot.*briefly lag.*live/i,
      ],
      spawn: [
        SPAWN_USAGE,
        "--prompt",
        "--prompt-file",
        /independent.*same project/i,
        /fresh.*default.branch checkout/i,
        /own conversation.*separate filesystem/i,
        /no shared checkout.*local subagents/i,
        /keeps running.*this orb stops/i,
        /stdin/i,
        /acceptance.*not.*completion/i,
        /--name.*name/i,
        /--model.*provider\/id/i,
        /omission.*harness.*not.*model/is,
        /--id.*UUID.*retry key/i,
        /reuse.*identical arguments/is,
        /--json.*response.*instead.*URL/i,
      ],
      archive: [
        /only.*explicit user request/i,
        /push or export.*before/i,
        /permanently deletes.*workspace/i,
        /retains.*transcript.*conversation/i,
      ],
      delete: [
        /only.*explicit user request/i,
        /push or export.*before/i,
        /permanently deletes.*workspace.*conversation.*hosted files/i,
        /interrupt.*turn.*before.*acknowledg/i,
        /does not.*wait.*children.*uploads/is,
        /not.*project.*siblings/i,
      ],
      alert: [
        /transcript alert/i,
        /flag.*until.*user opens.*issuing orb/i,
        /not.*parent orb/i,
        /--request-id.*128/i,
        /retry.*same.*message/is,
        /4,096/,
      ],
      sleep: [
        "pi-orb sleep 1h",
        /absolute wake deadline/i,
        /stops.*after.*admitted work finishes/i,
        /successful.*return.*durable acceptance.*not.*already asleep/is,
        /deferred sleep.*not.*code.mode.*timers.*shell sleep/i,
        /not idempotent.*new deadline/is,
      ],
      send: [
        /same owner and project/i,
        /non-human.*not.*consent/i,
        /no shared filesystem/i,
        /wake.*stopped.*sleeping/i,
        /--request-id.*128/i,
        /retry.*same.*target.*message/is,
        /queue.*message.*orb/i,
        /acceptance.*not.*reply/i,
      ],
      host: [
        /path defaults.*basename/i,
        /--request-id.*UUID.*generated/i,
        /unknown.*same.*file.*path.*request/is,
        /rm.*no.*stdout/i,
        /32 MiB/,
        /UUID.*versions 1.5/is,
        /five.minute.*deadline/i,
        /publish.*file/i,
        /ls.*list/i,
        /rm.*remove/i,
      ],
      "id-token": [
        /--audience.*recipient.*512/i,
        /--ttl-seconds.*60.*3600.*600/i,
        /--flag=value/i,
        /retry.*10 seconds/is,
        "PI_ORB_ID_TOKEN_DIAGNOSTICS=1",
        /token.free.*stderr/i,
        /short.lived.*OIDC/i,
        /stdout.*bearer credential/i,
        /tracing.*logs/i,
      ],
    }),
  )("explains %s semantics, options and retry contract", async (command, matches) => {
    const output = await help([command, "--help"]);
    for (const match of matches) expect(output).toMatch(match);
  });

  it("never contacts the runtime/control plane for help, including destructive commands", async () => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      response.writeHead(500).end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing test listener");
      const env = {
        PI_ORB_CONTROL_PLANE_URL: `http://127.0.0.1:${address.port}`,
        PI_ORB_RUNTIME_PORT: String(address.port),
        PI_ORB_RUNTIME_TOKEN: "help-test-token",
      };
      const alertHelp = await run(["alert", "--help", "--request-id", "help-test"], env);
      expect(requests).toEqual([]);
      expect(alertHelp).toMatchObject({ code: 0, stderr: "" });
      for (const command of commands) {
        for (const args of [
          [command, "--help"],
          [command, "--help", "--json"],
          [command, "-h", "--request-id", "help-test"],
        ]) {
          expect(await run(args, env)).toMatchObject({ code: 0, stderr: "" });
        }
      }
      for (const args of [
        ["help", "missing"],
        ["missing", "--help"],
        ["archive", "extra"],
        ["delete", "extra"],
      ]) {
        expect(await run(args, env)).toMatchObject({ code: 2, stdout: "" });
      }
      expect(requests).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each([
    [],
    ["unknown"],
    ["unknown", "--help"],
    ["help", "unknown"],
    ["help", "archive", "extra"],
    ["--help", "extra"],
    ["-h", "extra"],
  ])("rejects invalid root/help arguments %j with usage on stderr", async (...args) => {
    const result = await run(args);
    expect(result).toMatchObject({ code: 2, stdout: "" });
    expect(result.stderr).toContain("usage:");
    expect(result.stderr).toContain("Run pi-orb --help");
    expect(result.stderr).not.toContain("Examples:");
  });

  it.each([
    ["spawn", "--prompt", "--help"],
    ["spawn", "--prompt-file", "--help"],
    ["send", "123e4567-e89b-42d3-a456-426614174000", "--help"],
    ["alert", "message", "--request-id", "--help"],
    ["host", "file.html", "--help"],
    ["orbs", "search --help text"],
    ["transcript", "orb", "--json"],
  ])("preserves normal dispatch and does not scan argument data %j", async (...args) => {
    const result = await run(args);
    expect(result).toMatchObject({ code: 2, stdout: "" });
    expect(result.stderr).toContain("orb runtime environment missing");
  });
});
