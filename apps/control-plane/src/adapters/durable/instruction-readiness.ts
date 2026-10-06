import { createHash } from "node:crypto";
import { err, ok, type Result } from "neverthrow";
import type { RuntimeClientError } from "../../domain/errors.ts";
import { durableError } from "./manager.ts";

/** Private prompt data and per-conversation authorization; never exposed in tool errors. */
export class InstructionReadiness {
  private offered: { digest: string; content: string } | undefined;
  private readonly generations = new Map<string, string>();
  private readonly initial: string;
  constructor(initial: string) {
    this.initial = initial;
  }
  offer(content: string): { revision: string; changed: boolean } {
    const digest = createHash("sha256").update(content).digest("hex");
    const changed = this.offered?.digest !== digest;
    this.offered = { digest, content };
    return { revision: digest, changed };
  }
  prompt(conversationId: string, adopted?: (revision: string) => void): string {
    const revision = this.offered?.digest ?? "pending";
    if (this.offered && this.generations.get(conversationId) !== revision) adopted?.(revision);
    this.generations.set(conversationId, revision);
    return this.offered?.content ?? this.initial;
  }
  admission(conversationId: string): () => Result<void, RuntimeClientError> {
    const revision = this.generations.get(conversationId);
    return () =>
      this.offered && revision === this.offered.digest
        ? ok(undefined)
        : err(
            durableError(
              "Host instructions adopted; re-evaluate the operation under the current instructions.",
            ),
          );
  }
}
