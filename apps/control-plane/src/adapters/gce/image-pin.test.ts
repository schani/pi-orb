import { describe, expect, it } from "vitest";
import { isExactGceImageResource, isNumericGceImageId, readGceImageIdentity } from "./image-pin.ts";

describe("GCE native image identity", () => {
  it("accepts only exact global image resources", () => {
    expect(isExactGceImageResource("projects/pi-orb-prod/global/images/pi-orb-20260905")).toBe(
      true,
    );
    expect(isExactGceImageResource("projects/pi-orb-prod/global/images/family/pi-orb")).toBe(false);
    expect(isExactGceImageResource("pi-orb-20260905")).toBe(false);
    expect(isExactGceImageResource("")).toBe(false);
  });

  it("accepts only positive numeric image IDs", () => {
    expect(isNumericGceImageId("1234567890123456789")).toBe(true);
    expect(isNumericGceImageId("0")).toBe(false);
    expect(isNumericGceImageId("123x")).toBe(false);
    expect(isNumericGceImageId("")).toBe(false);
  });

  it("composes both required environment values", () => {
    const values: Record<string, string> = {
      PI_ORB_GCE_IMAGE_RESOURCE: "projects/pi-orb-prod/global/images/pi-orb-20260905",
      PI_ORB_GCE_IMAGE_ID: "123456789",
    };
    expect(readGceImageIdentity((name) => values[name] ?? "")).toEqual({
      ok: true,
      imageResource: values["PI_ORB_GCE_IMAGE_RESOURCE"],
      imageId: values["PI_ORB_GCE_IMAGE_ID"],
    });
    expect(readGceImageIdentity((name) => (name === "PI_ORB_GCE_IMAGE_ID" ? "123" : "")).ok).toBe(
      false,
    );
  });
});
