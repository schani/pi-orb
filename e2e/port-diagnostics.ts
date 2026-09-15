import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ResultAsync } from "neverthrow";

interface ProbeError {
  readonly type: "probe_failed";
  readonly code: string | number | null;
}

type Probe = (file: string, args: string[]) => ResultAsync<string, ProbeError>;
const execFileAsync = promisify(execFile);

const executeProbe: Probe = ResultAsync.fromThrowable(
  async (file: string, args: string[]) => {
    const result = await execFileAsync(file, args, {
      timeout: 3_000,
      killSignal: "SIGKILL",
      maxBuffer: 256_000,
    });
    return result.stdout.trim();
  },
  (cause): ProbeError => ({
    type: "probe_failed",
    code:
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      (typeof cause.code === "string" || typeof cause.code === "number")
        ? cause.code
        : null,
  }),
);

/** Read-only, bounded, token-free evidence; missing tools never replace the test failure. */
export async function capturePortDiagnostics(
  port: number,
  phase: "before-bind" | "run-failed",
  probe: Probe = executeProbe,
) {
  const filter = `( sport = :${port} or dport = :${port} )`;
  const socketArgs = ["-Htanpeo", filter];
  const commands = [
    { name: "tcp-sockets", file: "ss", args: socketArgs },
    // Hosted runners permit passwordless sudo. Never prompt; unavailable is explicit elsewhere.
    { name: "tcp-socket-owners", file: "sudo", args: ["-n", "ss", ...socketArgs] },
    {
      name: "ephemeral-port-policy",
      file: "sysctl",
      args: ["net.ipv4.ip_local_port_range", "net.ipv4.ip_local_reserved_ports"],
    },
    {
      name: "docker-port-owners",
      file: "docker",
      args: [
        "ps",
        "--all",
        "--no-trunc",
        "--format",
        "{{.ID}}\t{{.Names}}\t{{.Ports}}\t{{.Status}}",
      ],
    },
  ];
  const observations = await Promise.all(
    commands.map(async ({ name, file, args }) => {
      const observedAt = new Date().toISOString();
      const result = await probe(file, args);
      return result.match(
        (output) => ({ name, observedAt, status: "ok" as const, output }),
        (error) => ({ name, observedAt, status: "unavailable" as const, code: error.code }),
      );
    }),
  );
  return { event: "postgres-port-diagnostic", port, phase, observations };
}
