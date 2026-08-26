/** Removes right-side blank cells from the browser text for selected terminal rows. */
export function normalizeTerminalSelection(text: string): string {
  return text.replace(/ +(?=\n|$)/g, "");
}
