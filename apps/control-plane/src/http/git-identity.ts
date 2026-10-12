import type { GitIdentity } from "@pi-orb/protocol";
import type { FastifyReply } from "fastify";
import type { Result } from "neverthrow";
import type { GitIdentityError } from "../domain/git-identity.ts";

export function sendGitIdentity(
  reply: FastifyReply,
  result: Result<GitIdentity, GitIdentityError>,
) {
  reply.header("cache-control", "no-store");
  if (result.isOk()) return reply.send(result.value);
  const { code, message } = result.error;
  return reply.status({ invalid: 400, unavailable: 503, internal: 500 }[code]).send({
    error: {
      code: code === "invalid" ? "invalid_request" : code,
      message,
      retryable: code === "unavailable",
    },
  });
}
