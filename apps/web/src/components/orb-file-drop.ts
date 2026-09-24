export type DropZone = "transcript" | "composer";

export function isFileDrag(data: DataTransfer): boolean {
  return (
    Array.from(data.types).includes("Files") ||
    Array.from(data.items).some((item) => item.kind === "file")
  );
}

export function preventFileNavigation(
  event: Pick<DragEvent, "dataTransfer" | "preventDefault">,
): boolean {
  if (!event.dataTransfer || !isFileDrag(event.dataTransfer)) return false;
  event.preventDefault();
  return true;
}

export function dropHint(zone: DropZone, data: DataTransfer, running: boolean): string {
  if (!running) return "Uploads need a running orb.";
  if (zone === "transcript") return "Upload files to orb";
  const types = Array.from(data.items)
    .filter((item) => item.kind === "file")
    .map((item) => item.type);
  if (!types.length || types.some((type) => !type)) return "Drop files to check for images";
  if (types.some((type) => !type.startsWith("image/")))
    return "Non-images can only be uploaded as files to the orb.";
  return "Attach images to message";
}

type Bounds = Pick<DOMRect, "left" | "right" | "top" | "bottom">;

export function transcriptDropBounds(
  main: Bounds,
  header: Bounds,
  composer: Bounds | null,
  scroll: Bounds,
  phone: boolean,
  viewportHeight: number,
): { left: number; top: number; width: number; height: number } {
  const left = phone ? scroll.left : main.left;
  const right = phone ? scroll.right : main.right;
  const top = Math.max(phone ? scroll.top : header.bottom, 0);
  const bottom = Math.min(
    phone ? scroll.bottom : (composer?.top ?? viewportHeight),
    viewportHeight,
  );
  return {
    left: left + 8,
    top: top + 8,
    width: Math.max(0, right - left - 16),
    height: Math.max(0, bottom - top - 16),
  };
}

export function splitComposerFiles(files: File[]): { images: File[]; rejected: boolean } {
  return {
    images: files.filter((file) => file.type.startsWith("image/")),
    rejected: files.some((file) => !file.type.startsWith("image/")),
  };
}
