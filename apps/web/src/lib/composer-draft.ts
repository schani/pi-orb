import { ok, Result } from "neverthrow";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";

const ComposerDraftSchema = Type.Object(
  {
    text: Type.String(),
    mode: Type.Union([
      Type.Literal("message"),
      Type.Literal("shell"),
      Type.Literal("excluded_shell"),
    ]),
    images: Type.Array(
      Type.Object({
        id: Type.String(),
        mediaType: Type.String(),
        data: Type.String(),
      }),
    ),
  },
  { additionalProperties: false },
);

export type ComposerDraft = Static<typeof ComposerDraftSchema>;
export interface ComposerDraftStorageError {
  readonly type: "composer_draft_storage_error";
  readonly message: string;
}

const storageKey = (orbId: string) => `pi-orb:composer-draft:${orbId}`;
const storageFailure = (): ComposerDraftStorageError => ({
  type: "composer_draft_storage_error",
  message: "The browser could not preserve this draft across sign-in.",
});

export function loadComposerDraft(
  orbId: string,
): Result<ComposerDraft | null, ComposerDraftStorageError> {
  if (typeof window === "undefined") return ok(null);
  return Result.fromThrowable(() => {
    const storage = window.sessionStorage;
    const encoded = storage.getItem(storageKey(orbId));
    if (encoded === null) return null;
    const value: unknown = JSON.parse(encoded);
    if (!Check(ComposerDraftSchema, value)) {
      storage.removeItem(storageKey(orbId));
      return null;
    }
    return value;
  }, storageFailure)();
}

export function saveComposerDraft(
  orbId: string,
  draft: ComposerDraft,
): Result<void, ComposerDraftStorageError> {
  if (typeof window === "undefined") return ok(undefined);
  return Result.fromThrowable(() => {
    const storage = window.sessionStorage;
    if (draft.text === "" && draft.images.length === 0 && draft.mode === "message") {
      storage.removeItem(storageKey(orbId));
    } else {
      storage.setItem(storageKey(orbId), JSON.stringify(draft));
    }
  }, storageFailure)();
}
