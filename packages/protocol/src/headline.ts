/** UTF-8 byte bound, including ellipsis; avoids splitting surrogate pairs. */
export function capHeadline(value: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).length <= 1024) return value;
  let prefix = "";
  let bytes = 0;
  for (const char of value) {
    const size = encoder.encode(char).length;
    if (bytes + size > 1021) break;
    prefix += char;
    bytes += size;
  }
  return `${prefix}…`;
}

/** A subagent's rail and timeline label: its description, else its ID. */
export function subagentLabel(task: { readonly id: string; readonly description: string }): string {
  return task.description.trim() !== "" ? capHeadline(task.description) : `Subagent ${task.id}`;
}
