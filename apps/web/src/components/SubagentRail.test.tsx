import type { ActiveSubagent } from "@pi-orb/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SubagentRail } from "./SubagentRail.tsx";

describe("SubagentRail", () => {
  const agents: ActiveSubagent[] = [
    { id: "child", description: "Review changes", phase: "running" },
    { id: "shell-a", kind: "shell", description: "Run tests", phase: "running" },
    { id: "shell-b", kind: "shell", description: "Build frontend", phase: "running" },
    { id: "shell-c", kind: "shell", description: "Finish upload", phase: "finishing" },
  ];
  const context = { orbId: "orb", sessionId: "session" };

  it.each(["subagent", "shell"] as const)("shows only %s work and its phase counts", (kind) => {
    const html = renderToStaticMarkup(
      <SubagentRail agents={agents} context={context} kind={kind} />,
    );
    expect(html).toContain(kind === "shell" ? ">shell</span>" : ">subagents</span>");
    expect(html.match(/<li\b/g)).toHaveLength(kind === "shell" ? 3 : 1);
    expect(html).toContain(kind === "shell" ? "2 running" : "1 running");
    expect(html.includes("1 finishing")).toBe(kind === "shell");
    expect(html.includes("Review changes")).toBe(kind === "subagent");
    expect(html.includes("Run tests")).toBe(kind === "shell");
  });

  it.each(["subagent", "shell"] as const)("hides an empty %s folder independently", (kind) => {
    for (const roster of [
      [],
      agents.filter((agent) => (agent.kind === "shell") !== (kind === "shell")),
    ]) {
      expect(
        renderToStaticMarkup(<SubagentRail agents={roster} context={context} kind={kind} />),
      ).toBe("");
    }
  });

  it("expands once to a flat description-and-phase roster without ID-only disclosures", () => {
    const html = renderToStaticMarkup(
      <SubagentRail
        context={{ orbId: "orb", sessionId: "session" }}
        agents={[
          { id: "internal-running-id", description: "Check services", phase: "running" },
          { id: "internal-queued-id", description: "Check deployment", phase: "queued" },
          { id: "internal-finishing-id", description: "Finish cleanup", phase: "finishing" },
        ]}
      />,
    );
    expect(html.match(/<details\b/g)).toHaveLength(1);
    expect(html.match(/<summary\b/g)).toHaveLength(1);
    expect(html.match(/<li\b/g)).toHaveLength(3);
    expect(html).toContain("Check services");
    expect(html).toContain("Check deployment");
    expect(html).toContain("Finish cleanup");
    expect(html).toContain("1 running");
    expect(html).toContain("1 queued");
    expect(html).toContain("1 finishing");
    expect(html).not.toContain("internal-");
  });
});
