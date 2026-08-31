export function formatProjectSecretCount(count: number | null | undefined): string {
  if (count === undefined) return "secrets";
  if (count === null) return "secrets unavailable";
  if (count === 0) return "no secrets configured";
  return `${count} ${count === 1 ? "secret" : "secrets"} configured`;
}
