import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession, defineDoc, type Storage } from "@earendil-works/pi-durable";
import { ResultAsync } from "neverthrow";
import { type ResourceError, resourceError } from "../../domain/resources.ts";
import type { ManagedResourceInstructions, PersistedPlatformContext } from "./resource-context.ts";

const ContextSnapshot = defineDoc<{
  platform: {
    version: string;
    files: Array<{ path: string; base64: string; sha256: string }>;
  } | null;
  managed: {
    personal: { content: string; revision: number };
    project: { content: string; revision: number };
  } | null;
}>({
  kind: "orb.resource-context",
  version: 1,
  scope: "session",
  initial: () => ({ platform: null, managed: null }),
});

/** One private native mutation captures managed prompts and the exact bundled resource version. */
export class NativeResourceContext {
  private readonly session;
  private readonly check: () => ResultAsync<void, ResourceError>;
  constructor(storage: Storage, check: () => ResultAsync<void, ResourceError>) {
    this.session = createSession(storage);
    this.check = check;
  }
  platform() {
    return this.check()
      .andThen(() =>
        ResultAsync.fromPromise(this.session.snapshot(ContextSnapshot, BACKGROUND_CONTEXT), () =>
          resourceError("storage", "Private resource context unavailable"),
        ),
      )
      .map((value) => value?.platform ?? null);
  }
  managed() {
    return this.check()
      .andThen(() =>
        ResultAsync.fromPromise(this.session.snapshot(ContextSnapshot, BACKGROUND_CONTEXT), () =>
          resourceError("storage", "Private resource context unavailable"),
        ),
      )
      .map((value) => value?.managed ?? null);
  }
  save(platform: PersistedPlatformContext, managed: ManagedResourceInstructions) {
    return this.check().andThen(() =>
      ResultAsync.fromPromise(
        this.session.commit(async (tx) => {
          const doc = await tx.doc(ContextSnapshot);
          doc.platform = {
            version: platform.version,
            files: platform.files.map((file) => ({ ...file })),
          };
          doc.managed = { personal: { ...managed.personal }, project: { ...managed.project } };
        }, BACKGROUND_CONTEXT),
        () => resourceError("storage", "Private resource context commit failed"),
      ),
    );
  }
}
