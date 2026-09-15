import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { mapPiEntry } from "../../../orb-runtime/src/pi/mapping.ts";
import { HistoryView } from "./HistoryView.tsx";

it("renders autonomous settings fallback durably without adding model context", () => {
  const native = {
    type: "custom",
    id: "fallback",
    parentId: null,
    timestamp: "now",
    customType: "pi-orb.settings-fallback",
    data: { message: "Saved model disappeared; using Astra." },
  };
  const mapped = mapPiEntry(native);
  expect(mapped.isOk()).toBe(true);
  if (mapped.isErr()) return;
  expect(mapped.value.type).toBe("event");
  expect(
    renderToStaticMarkup(
      <HistoryView records={[mapped.value]} liveBlocks={[]} tools={[]} busy={false} />,
    ),
  ).toContain("Saved model disappeared; using Astra.");
  expect(mapped.value.overflow["native"]).toEqual(native);
});
