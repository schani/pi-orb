import { describe, expect, it } from "vitest";
import { DEFAULT_PAGE_TITLE, orbPageTitle, setPageTitle } from "./page-title.ts";

describe("orbPageTitle", () => {
  it("identifies the project and orb in the browser tab", () => {
    expect(orbPageTitle("compiler", "repair-parser")).toBe("compiler · repair-parser");
    expect(orbPageTitle("compiler", null)).toBe("compiler · untitled orb");
  });
});

describe("setPageTitle", () => {
  it("updates and restores the document title", () => {
    const target = { title: DEFAULT_PAGE_TITLE };
    setPageTitle("compiler · repair-parser", target);
    expect(target.title).toBe("compiler · repair-parser");
    setPageTitle(DEFAULT_PAGE_TITLE, target);
    expect(target.title).toBe("pi-orb");
  });
});
