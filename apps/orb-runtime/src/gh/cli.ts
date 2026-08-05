import { NoSimulationTask } from "determined";
import { HttpBrokerEndpoint, readBrokerEnv } from "../broker/endpoint.ts";
import {
  credentialOutput,
  fetchGithubToken,
  parseCredentialRequest,
  shouldServeCredential,
} from "./token.ts";

/**
 * One-shot CLI behind the `gh` shim and the git credential helper
 * (docs/credentials.md):
 *
 *   cli.ts print             print a fresh GitHub access token to stdout
 *   cli.ts credential get    answer git's credential-helper protocol
 *
 * Exit codes: 0 with output on success (or on a request this helper does not
 * serve), 1 with a stderr message when a token was needed and unavailable.
 * This is a process boundary: outcomes leave as exit codes, not exceptions.
 */

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<number> {
  const mode = process.argv[2];
  const env = readBrokerEnv(process.env);
  if (env === null) {
    process.stderr.write("pi-orb: broker environment missing (not inside an orb?)\n");
    return 1;
  }
  const task = new NoSimulationTask("gh-token-cli", false);
  const endpoint = new HttpBrokerEndpoint(env, "github");

  if (mode === "print") {
    const token = await fetchGithubToken(task, endpoint);
    if (token.isErr()) {
      process.stderr.write(`pi-orb: ${token.error}\n`);
      return 1;
    }
    process.stdout.write(token.value);
    return 0;
  }

  if (mode === "credential") {
    // git invokes the helper as `<helper> get|store|erase`; only get answers.
    if (process.argv[3] !== "get") return 0;
    const attrs = parseCredentialRequest(await readStdin());
    if (!shouldServeCredential(attrs)) return 0;
    const token = await fetchGithubToken(task, endpoint);
    if (token.isErr()) {
      process.stderr.write(`pi-orb: ${token.error}\n`);
      return 1;
    }
    process.stdout.write(credentialOutput(token.value));
    return 0;
  }

  process.stderr.write("usage: cli.ts print | cli.ts credential get\n");
  return 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`pi-orb: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
