import type { ProjectInstructions } from "@pi-orb/protocol";
import type { RefObject } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import {
  type ProjectInstructionsDraft,
  ProjectInstructionsEditor,
} from "./ProjectInstructions.tsx";

it("gates a clean retained snapshot during the activation render before its refresh effect", () => {
  const snapshot: ProjectInstructions = { content: "saved", revision: 1 };
  const retained: RefObject<ProjectInstructionsDraft | null> = {
    current: { snapshot, content: snapshot.content },
  };

  const html = renderToStaticMarkup(
    <ProjectInstructionsEditor
      projectId="project-1"
      active
      saving={false}
      setSaving={() => {}}
      retained={retained}
    />,
  );

  expect(html).toMatch(/<textarea[^>]* disabled=""/);
  expect(html).toContain("Loading…");
  expect(html).toContain('<button type="submit" disabled="">Save</button>');
});
