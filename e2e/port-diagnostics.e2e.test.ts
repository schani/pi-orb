import { errAsync, okAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { capturePortDiagnostics } from "./port-diagnostics.ts";

describe("PostgreSQL port evidence", () => {
  it("captures all TCP states and owners without commands, environments or container secrets", async () => {
    const calls: { file: string; args: string[] }[] = [];
    const snapshot = await capturePortDiagnostics(55434, "run-failed", (file, args) => {
      calls.push({ file, args });
      return okAsync(file === "ss" ? "TIME-WAIT 0 0 127.0.0.1:55434 127.0.0.1:8080" : "fixture");
    });
    expect(snapshot).toMatchObject({
      event: "postgres-port-diagnostic",
      port: 55434,
      phase: "run-failed",
    });
    expect(calls).toEqual([
      { file: "ss", args: ["-Htanpeo", "( sport = :55434 or dport = :55434 )"] },
      { file: "sudo", args: ["-n", "ss", "-Htanpeo", "( sport = :55434 or dport = :55434 )"] },
      {
        file: "sysctl",
        args: ["net.ipv4.ip_local_port_range", "net.ipv4.ip_local_reserved_ports"],
      },
      {
        file: "docker",
        args: [
          "ps",
          "--all",
          "--no-trunc",
          "--format",
          "{{.ID}}\t{{.Names}}\t{{.Ports}}\t{{.Status}}",
        ],
      },
    ]);
    expect(snapshot.observations[0]).toMatchObject({
      status: "ok",
      output: expect.stringContaining("TIME-WAIT"),
    });
    expect(
      snapshot.observations.every((entry) => !Number.isNaN(Date.parse(entry.observedAt))),
    ).toBe(true);
  });

  it("records unavailable probes independently rather than hiding the original failure", async () => {
    const snapshot = await capturePortDiagnostics(55434, "before-bind", (file) =>
      file === "ss" ? okAsync("") : errAsync({ type: "probe_failed", code: "ENOENT" }),
    );
    expect(snapshot.observations.map(({ status }) => status)).toEqual([
      "ok",
      "unavailable",
      "unavailable",
      "unavailable",
    ]);
    expect(snapshot.observations[1]).toMatchObject({ name: "tcp-socket-owners", code: "ENOENT" });
  });
});
