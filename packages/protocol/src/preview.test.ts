import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import { PreviewAdmissionSchema } from "./preview.ts";

describe("preview admission wire", () => {
  const admission = {
    v: 1,
    target: {
      orbId: "orb-a",
      port: 5173,
      registrationId: "r1",
      incarnation: 2,
      executionId: "boot-1",
      runtimeInstanceId: "runtime-1",
    },
    origin: "https://p5173-oorb-a.preview.test",
    expiresAt: 1000,
  };
  it("requires exact identity and an integer target port", () => {
    expect(Check(PreviewAdmissionSchema, admission)).toBe(true);
    for (const field of [
      "orbId",
      "registrationId",
      "incarnation",
      "executionId",
      "runtimeInstanceId",
    ]) {
      const target = { ...admission.target };
      Reflect.deleteProperty(target, field);
      expect(Check(PreviewAdmissionSchema, { ...admission, target })).toBe(false);
    }
    for (const port of [0, 65536, 1.5, "5173"])
      expect(
        Check(PreviewAdmissionSchema, { ...admission, target: { ...admission.target, port } }),
      ).toBe(false);
  });
  it("rejects additional admission and target properties", () => {
    expect(Check(PreviewAdmissionSchema, { ...admission, url: "http://metadata" })).toBe(false);
    expect(
      Check(PreviewAdmissionSchema, {
        ...admission,
        target: { ...admission.target, host: "metadata" },
      }),
    ).toBe(false);
  });
});
