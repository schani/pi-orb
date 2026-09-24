import { describe, expect, it } from "vitest";
import {
  dropHint,
  isFileDrag,
  preventFileNavigation,
  splitComposerFiles,
  transcriptDropBounds,
} from "./orb-file-drop.ts";

const transfer = (types: string[], items: { kind: string; type: string }[] = []) =>
  ({ types, items }) as unknown as DataTransfer;

describe("orb file drops", () => {
  it("does not intercept text and links; accepts obscured file drags", () => {
    expect(isFileDrag(transfer(["text/plain"]))).toBe(false);
    expect(isFileDrag(transfer(["Files"]))).toBe(true);
    expect(isFileDrag(transfer([], [{ kind: "file", type: "" }]))).toBe(true);
  });

  it("admits file dragover and prevents navigation on a missed drop without intercepting text", () => {
    let prevented = 0;
    const file = { dataTransfer: transfer(["Files"]), preventDefault: () => prevented++ };
    const text = { dataTransfer: transfer(["text/plain"]), preventDefault: () => prevented++ };
    expect(preventFileNavigation(file)).toBe(true);
    expect(preventFileNavigation(file)).toBe(true);
    expect(preventFileNavigation(text)).toBe(false);
    expect(prevented).toBe(2);
  });

  it("describes only known image types as images", () => {
    expect(
      dropHint("composer", transfer(["Files"], [{ kind: "file", type: "image/png" }]), true),
    ).toBe("Attach images to message");
    expect(dropHint("composer", transfer(["Files"], [{ kind: "file", type: "" }]), true)).toBe(
      "Drop files to check for images",
    );
    expect(
      dropHint("composer", transfer(["Files"], [{ kind: "file", type: "text/plain" }]), true),
    ).toBe("Non-images can only be uploaded as files to the orb.");
    expect(dropHint("transcript", transfer(["Files"]), true)).toBe("Upload files to orb");
    expect(dropHint("composer", transfer(["Files"]), false)).toBe("Uploads need a running orb.");
  });

  it("bounds desktop transcript to main column between header and composer, and phone to scroll pane", () => {
    const main = { left: 236, right: 1280, top: 0, bottom: 3000 };
    const header = { left: 236, right: 1280, top: 0, bottom: 24 };
    const composer = { left: 236, right: 1280, top: 430, bottom: 520 };
    const scroll = { left: 0, right: 0, top: 0, bottom: 0 };
    expect(transcriptDropBounds(main, header, composer, scroll, false, 500)).toEqual({
      left: 244,
      top: 32,
      width: 1028,
      height: 390,
    });
    expect(
      transcriptDropBounds(
        main,
        header,
        composer,
        { left: 0, right: 390, top: 50, bottom: 420 },
        true,
        500,
      ),
    ).toEqual({
      left: 8,
      top: 58,
      width: 374,
      height: 354,
    });
  });

  it("attaches images from a mixed drop and rejects the rest", () => {
    const image = new File(["x"], "a.png", { type: "image/png" });
    const text = new File(["x"], "a.txt", { type: "text/plain" });
    expect(splitComposerFiles([image, text])).toEqual({ images: [image], rejected: true });
    expect(splitComposerFiles([text])).toEqual({ images: [], rejected: true });
  });
});
