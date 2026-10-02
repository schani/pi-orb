import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const expected = { cloudflare: 3, datadog: 33 };
const model = "openai-codex/gpt-6.1-sol";
export function approvedWorkerTools(tools, authenticated) {
  const names = tools.map((tool) => tool.name).filter((name) => name.startsWith("mcp__"));
  const counts = Object.fromEntries(
    Object.keys(expected).map((server) => [
      server,
      names.filter((name) => name.startsWith(`mcp__${server}__`)).length,
    ]),
  );
  if (
    names.some((name) => !/^mcp__(cloudflare|datadog)__[A-Za-z0-9_-]+$/.test(name)) ||
    names.length !== (authenticated ? 36 : 0) ||
    new Set(names).size !== names.length ||
    Object.entries(expected).some(
      ([server, count]) => counts[server] !== (authenticated ? count : 0),
    )
  )
    return undefined;
  return ["codemode", ...names.sort()];
}
export async function writeWorkerProfile(cwd, names) {
  const directory = join(cwd, ".pi", "agents");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "owned-context-worker.md"),
    `---\nname: owned-context-worker\ndescription: Qualification child\nmodel: ${model}\ntools: ${names.join(",")}\n---\nOnly answer the given prompt.\n`,
    { mode: 0o600 },
  );
}
