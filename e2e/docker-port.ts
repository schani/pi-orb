import { err, ok, type Result } from "neverthrow";

export function parseDockerLoopbackPort(
  output: string,
): Result<number, { readonly type: "invalid_docker_port" }> {
  const match = /^127\.0\.0\.1:([1-9]\d{0,4})$/.exec(output.trim());
  const port = Number(match?.[1]);
  return match !== null && port <= 65535 ? ok(port) : err({ type: "invalid_docker_port" });
}
