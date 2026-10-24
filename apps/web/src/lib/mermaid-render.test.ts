import { expect, it, vi } from "vitest";

const { initialize } = vi.hoisted(() => ({ initialize: vi.fn() }));
vi.mock("mermaid", () => ({ default: { initialize } }));

it("fixes security and presentation independently of Mermaid's upstream defaults", async () => {
  await import("./mermaid-render.ts");
  expect(initialize).toHaveBeenCalledWith(
    expect.objectContaining({
      securityLevel: "strict",
      theme: "base",
      look: "classic",
      layout: "dagre",
      flowchart: expect.objectContaining({ wrappingWidth: 200, minNodeWidth: 0 }),
    }),
  );
});
