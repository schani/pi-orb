import { afterEach, describe, expect, it, vi } from "vitest";
import { generateUuid } from "./uuid.ts";

const originalCrypto = globalThis.crypto;

afterEach(() => vi.stubGlobal("crypto", originalCrypto));

describe("generateUuid", () => {
  it("falls back to getRandomValues on plain-HTTP non-secure origins", () => {
    let next = 0;
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => {
        for (let index = 0; index < bytes.length; index++) bytes[index] = next++;
        return bytes;
      },
    });

    const id = generateUuid();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/u);
  });
});
