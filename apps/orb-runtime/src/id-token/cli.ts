import { NoSimulationTask } from "determined";
import { readBrokerEnv } from "../broker/endpoint.ts";
import { HttpIdTokenEndpoint } from "./endpoint.ts";
import {
  describeIdTokenFailure,
  EXIT_USAGE,
  exitCodeFor,
  fetchIdToken,
  parseIdTokenArgs,
  USAGE,
} from "./token.ts";

/**
 * One-shot CLI behind the `pi-orb` shim (docs/workload-identity.md):
 *
 *   pi-orb id-token --audience <audience> [--ttl-seconds <60..3600>]
 *
 * On success the signed JWT and one trailing newline are the only bytes ever
 * written to stdout, so `$(pi-orb id-token --audience …)` and executable
 * credential sources can consume it directly. Failures are one concise line on
 * stderr and an exit code naming the class:
 *
 *   0  a token was printed
 *   2  usage: bad arguments, or no orb runtime environment to authenticate with
 *   3  unauthorized: this incarnation's bearer was refused (replaced compute?)
 *   4  not mintable: the orb's lifecycle state forbids identity right now
 *   5  rate limited: the per-orb mint floor is still in force
 *   6  unavailable: control plane unreachable or transiently failing
 *   7  internal: a control-plane bug; retrying cannot help
 *
 * The token is never cached, logged, or written anywhere else. It is a bearer
 * credential for the audience it names: shell tracing around this command
 * (`set -x`, `bash -x`, a CI step that echoes commands and their output)
 * exposes it, as does any redirection of stdout into a file or log.
 *
 * This is a process boundary: outcomes leave as exit codes, not exceptions.
 */

async function main(): Promise<number> {
  // Argument validation happens before anything else: an invalid request must
  // never reach the network, and it needs no orb environment to be rejected.
  const parsed = parseIdTokenArgs(process.argv.slice(2));
  if (parsed.isErr()) {
    process.stderr.write(`pi-orb: ${describeIdTokenFailure(parsed.error)}\n`);
    return exitCodeFor(parsed.error);
  }
  const env = readBrokerEnv(process.env);
  if (env === null) {
    process.stderr.write(
      `pi-orb: orb runtime environment missing (not inside an orb?)\n${USAGE}\n`,
    );
    return EXIT_USAGE;
  }

  const task = new NoSimulationTask("id-token-cli", false);
  const token = await fetchIdToken(task, new HttpIdTokenEndpoint(env), parsed.value);
  if (token.isErr()) {
    process.stderr.write(`pi-orb: ${describeIdTokenFailure(token.error)}\n`);
    return exitCodeFor(token.error);
  }
  process.stdout.write(`${token.value}\n`);
  return 0;
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
