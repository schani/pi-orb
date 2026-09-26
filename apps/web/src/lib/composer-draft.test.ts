import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadComposerDraft, saveComposerDraft } from "./composer-draft.ts";
import {
  beginSessionRequest,
  reportSessionPrincipal,
  resetBrowserSessionForTest,
} from "./session.ts";

function storageFake() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  } as unknown as Storage;
}

describe("composer draft storage", () => {
  let storage: Storage;

  beforeEach(() => {
    resetBrowserSessionForTest();
    reportSessionPrincipal(beginSessionRequest(), "user:alice");
    storage = storageFake();
    vi.stubGlobal("window", { sessionStorage: storage });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("round-trips text, mode, and attachments per orb", () => {
    const draft = {
      text: "keep this",
      mode: "message" as const,
      images: [{ id: "image-1", mediaType: "image/png", data: "cG5n" }],
    };

    expect(saveComposerDraft("orb-1", draft).isOk()).toBe(true);
    expect(loadComposerDraft("orb-1")._unsafeUnwrap()).toEqual(draft);
    expect(loadComposerDraft("orb-2")._unsafeUnwrap()).toBeNull();
  });

  it("isolates account drafts and recovers the original account's draft", () => {
    const draft = { text: "Alice private draft", mode: "message" as const, images: [] };
    saveComposerDraft("orb-1", draft);
    reportSessionPrincipal(beginSessionRequest(), "user:bob");
    expect(loadComposerDraft("orb-1")._unsafeUnwrap()).toBeNull();
    saveComposerDraft("orb-1", draft, "user:alice");
    expect(loadComposerDraft("orb-1")._unsafeUnwrap()).toBeNull();
    reportSessionPrincipal(beginSessionRequest(), "user:alice");
    expect(loadComposerDraft("orb-1")._unsafeUnwrap()).toEqual(draft);
  });

  it("removes an empty message draft", () => {
    saveComposerDraft("orb-1", { text: "old", mode: "message", images: [] });
    saveComposerDraft("orb-1", { text: "", mode: "message", images: [] });
    expect(loadComposerDraft("orb-1")._unsafeUnwrap()).toBeNull();
  });

  it("contains unavailable storage as a typed failure", () => {
    vi.stubGlobal("window", {
      get sessionStorage(): Storage {
        throw new DOMException("blocked", "SecurityError");
      },
    });
    const result = saveComposerDraft("orb-1", { text: "draft", mode: "message", images: [] });
    expect(result.isErr() && result.error.type).toBe("composer_draft_storage_error");
  });
});
