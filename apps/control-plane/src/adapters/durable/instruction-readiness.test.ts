import { describe, expect, it } from "vitest";
import { InstructionReadiness } from "./instruction-readiness.ts";

describe("host instruction boundary", () => {
  it("reports discovery and generation adoption once using only revision digests", () => {
    const instructions = new InstructionReadiness("CP pending");
    const first = instructions.offer("PRIVATE CONTENT");
    expect(first.changed).toBe(true);
    expect(first.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(instructions.offer("PRIVATE CONTENT").changed).toBe(false);
    const adopted: string[] = [];
    instructions.prompt("root", (revision) => adopted.push(revision));
    instructions.prompt("root", (revision) => adopted.push(revision));
    instructions.prompt("child", (revision) => adopted.push(revision));
    expect(adopted).toEqual([first.revision, first.revision]);
    expect(JSON.stringify({ first, adopted })).not.toContain("PRIVATE CONTENT");
  });

  it("keeps resources explicitly pending, adopts privately at a generation and rejects every older child decision", () => {
    const instructions = new InstructionReadiness("CP instructions; host resources pending.");
    expect(instructions.prompt("root")).toContain("pending");
    instructions.prompt("child");
    const root = instructions.admission("root");
    const child = instructions.admission("child");
    instructions.offer("private repository instructions");
    expect(root().isErr()).toBe(true);
    expect(child().isErr()).toBe(true);
    expect(root()._unsafeUnwrapErr().message).not.toContain("private repository");
    expect(instructions.prompt("root")).toBe("private repository instructions");
    expect(instructions.admission("root")().isOk()).toBe(true);
    expect(child().isErr()).toBe(true);
    expect(instructions.prompt("child")).toBe("private repository instructions");
    expect(instructions.admission("child")().isOk()).toBe(true);
  });
  it("requires re-evaluation after recovery without generation authorization", () => {
    const instructions = new InstructionReadiness("CP; pending");
    instructions.offer("private");
    expect(instructions.admission("recovered")().isErr()).toBe(true);
    instructions.prompt("recovered");
    expect(instructions.admission("recovered")().isOk()).toBe(true);
  });
});
