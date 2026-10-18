import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { join } from "node:path";
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

const cli = join(import.meta.dirname, "../docker/pi-orb");
const commands = [
  "self",
  "orbs",
  "transcript",
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
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(cli, args, {
      env: { PATH: process.env.PATH, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function help(args: string[]) {
  const result = await run(args);
  expect(result).toMatchObject({ code: 0, stderr: "" });
  return result.stdout;
}

describe("public pi-orb help", () => {
  it("prints root help to stdout without an orb environment", async () => {
    const root = await help(["--help"]);
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
      expect(output).toContain("Examples:");
      expect(output).toContain("Output:");
      expect(output).toContain("Retry:");
      expect(output).toContain("Exit:");
      expect(await help(["--help"])).toContain(output.trimEnd());
      expect(await help([command, "-h"])).toBe(output);
      expect(await help([command, "--help", "--request-id", "help-test"])).toBe(output);
      expect(await help([command, "-h", "--json"])).toBe(output);
      expect(await help(["help", command])).toBe(output);
    },
  );

  it("explains account inspection and transcript fidelity, size and replication lag", async () => {
    const orbs = await help(["orbs", "--help"]);
    expect(orbs).toMatch(/list.*search.*account.*orbs/i);
    expect(orbs).toContain("[query]");
    const transcript = await help(["transcript", "--help"]);
    expect(transcript).toMatch(/read.*conversation/i);
    expect(transcript).toMatch(/very long/i);
    expect(transcript).toMatch(/--json.*lossless structured/i);
    expect(transcript).toMatch(/active.*replicated snapshot.*briefly lag.*live/i);
  });

  it("explains all self identity fields", async () => {
    const output = await help(["self", "--help"]);
    for (const field of [
      "identity",
      "dashboard",
      "project",
      "repository",
      "creation time",
      "spawning parent",
      "direct children",
      "preview hostname",
      "--json",
    ])
      expect(output).toContain(field);
  });

  it("explains independent spawning and every option", async () => {
    const output = await help(["spawn", "--help"]);
    expect(output).toContain(SPAWN_USAGE);
    expect(output).toMatch(/independent.*same project/i);
    expect(output).toMatch(/fresh.*default.branch checkout/i);
    expect(output).toMatch(/own conversation.*separate filesystem/i);
    expect(output).toMatch(/no shared checkout.*local subagents/i);
    expect(output).toMatch(/keeps running.*this orb stops/i);
    for (const flag of ["--prompt", "--prompt-file", "--name", "--model", "--id", "--json"]) {
      expect(output).toContain(flag);
    }
    expect(output).toMatch(/stdin/i);
    expect(output).toMatch(/acceptance.*not.*completion/i);
  });

  it.each(["archive", "delete"])(
    "requires explicit permission and export before %s",
    async (command) => {
      const output = await help([command, "--help"]);
      expect(output).toMatch(/only.*explicit user request/i);
      expect(output).toMatch(/push or export.*before/i);
      expect(output).toMatch(/permanently deletes.*workspace/i);
      if (command === "archive") {
        expect(output).toMatch(/retains.*transcript.*conversation/i);
      } else {
        expect(output).toMatch(/permanently deletes.*workspace.*conversation.*hosted files/i);
        expect(output).toMatch(/interrupt.*turn.*before.*acknowledg/i);
      }
    },
  );

  it("distinguishes user alerts from parent messaging", async () => {
    const output = await help(["alert", "--help"]);
    expect(output).toMatch(/transcript alert/i);
    expect(output).toMatch(/flag.*until.*user opens.*issuing orb/i);
    expect(output).toMatch(/not.*parent orb/i);
    expect(output).toContain("--request-id");
  });

  it("explains durable deferred sleep rather than timers", async () => {
    const output = await help(["sleep", "--help"]);
    expect(output).toContain("pi-orb sleep 1h");
    expect(output).toMatch(/absolute wake deadline/i);
    expect(output).toMatch(/stops.*after.*admitted work finishes/i);
    expect(output).toMatch(/successful.*return.*durable acceptance.*not.*already asleep/is);
    expect(output).toMatch(/deferred sleep.*not.*code.mode.*timers.*shell sleep/i);
  });

  it("explains option meanings, defaults, retry identity and peer effects", async () => {
    const spawn = await help(["spawn", "--help"]);
    expect(spawn).toMatch(/--name.*name/i);
    expect(spawn).toMatch(/--model.*provider\/id/i);
    expect(spawn).toMatch(/omission.*harness.*not.*model/is);
    expect(spawn).toMatch(/--id.*UUID.*retry key/i);
    expect(spawn).toMatch(/reuse.*identical arguments/is);
    expect(spawn).toMatch(/--json.*response.*instead.*URL/i);
    const send = await help(["send", "--help"]);
    expect(send).toMatch(/same owner and project/i);
    expect(send).toMatch(/non-human.*not.*consent/i);
    expect(send).toMatch(/no shared filesystem/i);
    expect(send).toMatch(/wake.*stopped.*sleeping/i);
    expect(send).toMatch(/--request-id.*128/i);
    expect(send).toMatch(/retry.*same.*target.*message/is);
    const host = await help(["host", "--help"]);
    expect(host).toMatch(/path defaults.*basename/i);
    expect(host).toMatch(/--request-id.*UUID.*generated/i);
    expect(host).toMatch(/unknown.*same.*file.*path.*request/is);
    expect(host).toMatch(/rm.*no.*stdout/i);
    expect(host).toMatch(/32 MiB/);
    expect(host).toMatch(/UUID.*versions 1.5/is);
    expect(host).toMatch(/five.minute.*deadline/i);
    const token = await help(["id-token", "--help"]);
    expect(token).toMatch(/--audience.*recipient.*512/i);
    expect(token).toMatch(/--ttl-seconds.*60.*3600.*600/i);
    expect(token).toMatch(/--flag=value/i);
    expect(token).toMatch(/retry.*10 seconds/is);
    expect(token).toContain("PI_ORB_ID_TOKEN_DIAGNOSTICS=1");
    expect(token).toMatch(/token.free.*stderr/i);
    const sleep = await help(["sleep", "--help"]);
    expect(sleep).toMatch(/not idempotent.*new deadline/is);
    const deletion = await help(["delete", "--help"]);
    expect(deletion).toMatch(/does not.*wait.*children.*uploads/is);
    expect(deletion).toMatch(/not.*project.*siblings/i);
    const alert = await help(["alert", "--help"]);
    expect(alert).toMatch(/--request-id.*128/i);
    expect(alert).toMatch(/retry.*same.*message/is);
    expect(alert).toMatch(/4,096/);
  });

  it("describes send, hosting actions and token security", async () => {
    const send = await help(["send", "--help"]);
    expect(send).toMatch(/queue.*message.*orb/i);
    expect(send).toMatch(/acceptance.*not.*reply/i);
    expect(send).toContain("--request-id");
    const host = await help(["host", "--help"]);
    expect(host).toMatch(/publish.*file/i);
    expect(host).toMatch(/ls.*list/i);
    expect(host).toMatch(/rm.*remove/i);
    expect(host).toContain("--request-id");
    const token = await help(["id-token", "--help"]);
    expect(token).toMatch(/short.lived.*OIDC/i);
    expect(token).toMatch(/stdout.*bearer credential/i);
    expect(token).toContain("--ttl-seconds");
    expect(token).toMatch(/tracing.*logs/i);
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
