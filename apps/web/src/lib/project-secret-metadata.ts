export function formatProjectSecretCount(count: number | null | undefined): string {
  if (count === undefined) return "secrets";
  if (count === null) return "secrets unavailable";
  return `${count} ${count === 1 ? "secret" : "secrets"} configured`;
}
