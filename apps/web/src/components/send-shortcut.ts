/** Cmd-enter (mac) or ctrl-enter sends; plain enter stays a newline. */
export function isSendShortcut(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
}): boolean {
  return event.key === "Enter" && (event.metaKey || event.ctrlKey);
}
