import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kill as killProcess } from "node:process";
import { err, ok, Result, ResultAsync } from "neverthrow";
import { spawn } from "node-pty";
import type {
  ClaudeAuthError,
  ClaudeAuthSession,
  ClaudeAuthTransport,
} from "../domain/claude-auth.ts";
import { ClaudeSetupTokenParser } from "./claude-auth-parser.ts";

const failure = (): ClaudeAuthError => ({
  code: "unavailable",
  message: "Claude sign-in unavailable",
});
/** No checkout, ambient provider configuration, browser launch, or persistent HOME. */
export class ClaudePtyAuthTransport implements ClaudeAuthTransport {
  start: ClaudeAuthTransport["start"] = (emit) =>
    ResultAsync.fromPromise(
      (async () => {
        const require = createRequire(import.meta.url);
        const pkg = require("@anthropic-ai/claude-code/package.json") as { version: string };
        if (pkg.version !== "2.1.289") return err(failure());
        const root = await mkdtemp(join(tmpdir(), "pi-orb-claude-auth-"));
        const cleanup = () =>
          ResultAsync.fromPromise(rm(root, { recursive: true, force: true }), failure);
        const spawned = Result.fromThrowable(
          () =>
            spawn(
              process.execPath,
              [require.resolve("@anthropic-ai/claude-code/cli-wrapper.cjs"), "setup-token"],
              {
                name: "xterm-256color",
                cols: 1024,
                rows: 40,
                cwd: root,
                env: {
                  HOME: root,
                  CLAUDE_CONFIG_DIR: root,
                  PATH: "/usr/local/bin:/usr/bin:/bin",
                  TERM: "xterm-256color",
                  BROWSER: "/bin/true",
                  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
                },
              },
            ),
          failure,
        )();
        if (spawned.isErr()) {
          const cleaned = await cleanup();
          if (cleaned.isErr()) {
            emit({ error: "Claude sign-in cleanup failed", stage: "cleanup" });
            return err({ ...cleaned.error, stage: "cleanup" as const });
          }
          return err(spawned.error);
        }
        const child = spawned.value;
        const kill = Result.fromThrowable((signal: NodeJS.Signals = "SIGTERM") => {
          // forkpty makes the helper a group leader; the CLI wrapper starts a native child.
          if (process.platform === "win32") child.kill(signal);
          else killProcess(-child.pid, signal);
        }, failure);
        let settled = false;
        let resolveDrain!: (result: Result<void, ClaudeAuthError>) => void;
        const drained = new ResultAsync<void, ClaudeAuthError>(
          new Promise((resolve) => {
            resolveDrain = resolve;
          }),
        );
        const settleDrain = (result: Result<void, ClaudeAuthError>) => {
          if (settled) return;
          settled = true;
          resolveDrain(result);
        };
        let escalation: ReturnType<typeof setTimeout> | undefined;
        let exitDeadline: ReturnType<typeof setTimeout> | undefined;
        let groupExited = false;
        const terminate = () => {
          if (groupExited || escalation !== undefined) return ok(undefined);
          const result = kill();
          escalation = setTimeout(() => {
            kill("SIGKILL");
            exitDeadline = setTimeout(() => {
              settleDrain(err({ ...failure(), stage: "exit" }));
            }, 5_000);
          }, 5_000);
          return result;
        };
        const waitForGroupExit = () =>
          new ResultAsync<void, ClaudeAuthError>(
            new Promise((resolve) => {
              let retry: ReturnType<typeof setTimeout> | undefined;
              const deadline = setTimeout(() => {
                clearTimeout(retry);
                resolve(err({ ...failure(), stage: "exit" }));
              }, 10_000);
              const inspect = () => {
                const probe = Result.fromThrowable(
                  () => killProcess(-child.pid, 0),
                  (cause) =>
                    cause !== null && typeof cause === "object" && "code" in cause
                      ? cause.code
                      : undefined,
                )();
                if (process.platform === "win32" || (probe.isErr() && probe.error === "ESRCH")) {
                  groupExited = true;
                  clearTimeout(deadline);
                  resolve(ok(undefined));
                } else if (probe.isErr()) {
                  clearTimeout(deadline);
                  resolve(err({ ...failure(), stage: "exit" }));
                } else {
                  terminate();
                  retry = setTimeout(inspect, 25);
                }
              };
              inspect();
            }),
          );
        const parser = new ClaudeSetupTokenParser();
        let cancelled = false;
        let exited = false;
        let prior = "";
        let submitted = false;
        let inputCompleted = false;
        const timer = setTimeout(() => {
          cancelled = true;
          terminate();
          emit({ error: "Claude sign-in timed out", stage: "timeout" });
        }, 600_000);
        const onData = (chunk: string) => {
          if (cancelled || exited) return;
          parser.feed(chunk);
          if (submitted) {
            const nativeFailure = parser.nativeFailure();
            if (nativeFailure) {
              cancelled = true;
              clearTimeout(timer);
              terminate();
              emit({
                ...nativeFailure,
                stage:
                  nativeFailure.reason === "code_rejected" ? "native_input" : "native_exchange",
              });
            } else if (!inputCompleted && parser.inputAccepted()) {
              // Ink treats text plus CR in one input chunk as paste, not Enter.
              // Submit only after the secure input's redraw acknowledges the paste.
              const entered = Result.fromThrowable(() => child.write("\r"), failure)();
              if (entered.isErr()) {
                cancelled = true;
                clearTimeout(timer);
                terminate();
                emit({ error: "Claude sign-in input failed", stage: "native_input" });
              } else {
                inputCompleted = true;
                emit({ progress: "input_completed" });
              }
            }
            return;
          }
          const challenge = parser.challenge();
          const encoded = JSON.stringify(challenge);
          if (encoded !== prior && encoded !== "{}") {
            prior = encoded;
            emit({ challenge });
          }
        };
        const onExit = ({ exitCode }: { exitCode: number }) => {
          if (exited) return;
          exited = true;
          clearTimeout(timer);
          // Failed native output is useful before cleanup; credentials are not published until it succeeds.
          const parsed = cancelled ? undefined : parser.finish(exitCode);
          if (parsed && "error" in parsed)
            emit({ ...parsed, stage: exitCode === 0 ? "parser" : "transport" });
          void waitForGroupExit().then((exit) => {
            clearTimeout(escalation);
            clearTimeout(exitDeadline);
            if (exit.isErr()) {
              emit({ error: "Claude sign-in exit could not be confirmed", stage: "exit" });
              settleDrain(err(exit.error));
              return;
            }
            const cleanupDeadline = setTimeout(() => {
              emit({ error: "Claude sign-in cleanup failed", stage: "cleanup" });
              settleDrain(err({ ...failure(), stage: "cleanup" }));
            }, 5_000);
            void cleanup().then((result) => {
              clearTimeout(cleanupDeadline);
              if (result.isErr()) {
                emit({ error: "Claude sign-in cleanup failed", stage: "cleanup" });
                settleDrain(err({ ...result.error, stage: "cleanup" }));
              } else {
                if (!cancelled && !settled && parsed && "token" in parsed) emit(parsed);
                settleDrain(ok(undefined));
              }
            });
          });
        };
        const observed = Result.fromThrowable(() => {
          child.onExit(onExit);
          child.onData(onData);
        }, failure)();
        if (observed.isErr()) {
          cancelled = true;
          clearTimeout(timer);
          terminate();
          const result = await drained;
          return err(result.isErr() ? result.error : observed.error);
        }
        return ok<ClaudeAuthSession, ClaudeAuthError>({
          sendCode: (code: string) => {
            if (submitted || cancelled || exited) return err(failure());
            submitted = true;
            parser.redactInput(code);
            const pasted = Result.fromThrowable(
              () => child.write(`\u001b[200~${code}\u001b[201~`),
              failure,
            )();
            if (pasted.isErr()) {
              cancelled = true;
              clearTimeout(timer);
              terminate();
            }
            return pasted;
          },
          cancel: () => {
            cancelled = true;
            clearTimeout(timer);
            return terminate();
          },
          drain: () => drained,
        });
      })(),
      failure,
    ).andThen((result) => result);
}
