import { errAsync, ResultAsync } from "neverthrow";
import { parseRenderInput, renderInitialSystem } from "./render.ts";
import type { Definition, Entry, PromptError, Source } from "./types.ts";
import { MAX_CONTENT_BYTES } from "./types.ts";

export class PromptService {
  private readonly source: Source;
  private readonly catalog: readonly Definition[];

  constructor(source: Source, catalog: readonly Definition[]) {
    this.source = source;
    this.catalog = catalog;
  }

  list(): ResultAsync<Entry[], PromptError> {
    return ResultAsync.combine(this.catalog.map((definition) => this.source.read(definition)));
  }

  save(id: string, input: unknown): ResultAsync<Entry, PromptError> {
    const definition = this.catalog.find((entry) => entry.id === id);
    if (!definition) return errAsync({ code: "not_found", message: "Prompt doesn't exist." });
    if (!definition.editable)
      return errAsync({ code: "read_only", message: "This prompt is read-only." });
    if (
      !input ||
      typeof input !== "object" ||
      !("content" in input) ||
      !("revision" in input) ||
      typeof input.content !== "string" ||
      typeof input.revision !== "string" ||
      !/^[a-f0-9]{64}$/.test(input.revision)
    ) {
      return errAsync({
        code: "invalid_request",
        message: "Expected content and a SHA-256 revision.",
      });
    }
    if (Buffer.byteLength(input.content, "utf8") > MAX_CONTENT_BYTES) {
      return errAsync({ code: "too_large", message: "Content exceeds the 1 MiB limit." });
    }
    return this.source.save(definition, input.content, input.revision);
  }

  render(input: unknown): ResultAsync<{ text: string }, PromptError> {
    const parsed = parseRenderInput(input);
    if (parsed.isErr()) return errAsync(parsed.error);
    if (!this.source.snapshot)
      return errAsync({ code: "unsupported", message: "Source snapshots are unavailable." });
    return this.source
      .snapshot(this.catalog, parsed.value.drafts)
      .andThen((snapshot) => renderInitialSystem(snapshot, parsed.value))
      .map((text) => ({ text }));
  }

  asset(path: string): ResultAsync<Buffer, PromptError> {
    return this.source.asset(path);
  }
}
