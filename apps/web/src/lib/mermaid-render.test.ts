import { beforeEach, expect, it, vi } from "vitest";

const { initialize, parse } = vi.hoisted(() => ({
  initialize: vi.fn(),
  parse: vi.fn(() => Promise.reject(new Error("line 1"))),
}));
vi.mock("mermaid", () => ({ default: { initialize, parse } }));

beforeEach(() => {
  vi.resetModules();
  initialize.mockClear();
});

it("fixes security and presentation independently of Mermaid's upstream defaults", async () => {
  const { renderMermaid } = await import("./mermaid-render.ts");
  await renderMermaid("x", "light");
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

it("themes each render for the desktop scheme and reconfigures only on a change", async () => {
  const { renderMermaid } = await import("./mermaid-render.ts");
  await renderMermaid("x", "dark");
  await renderMermaid("y", "dark");
  expect(initialize).toHaveBeenCalledTimes(1);
  expect(initialize).toHaveBeenLastCalledWith(
    expect.objectContaining({
      themeVariables: expect.objectContaining({ background: "#000", textColor: "#fff" }),
    }),
  );
  await renderMermaid("z", "light");
  expect(initialize).toHaveBeenCalledTimes(2);
  expect(initialize).toHaveBeenLastCalledWith(
    expect.objectContaining({
      themeVariables: expect.objectContaining({ background: "#fff", textColor: "#000" }),
    }),
  );
});
