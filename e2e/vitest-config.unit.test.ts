import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

interface ProbeEvent {
  readonly event:
    | "frontend-start"
    | "frontend-end"
    | "lifecycle-setup-start"
    | "lifecycle-setup-end"
    | "lifecycle-start"
    | "lifecycle-end";
  readonly fixture?: string;
}

const deadlineMs = 10_000;

async function waitFor<T>(probe: () => T | undefined): Promise<T> {
  const deadline = Date.now() + deadlineMs;
  return await new Promise<T>((resolveValue, reject) => {
    const check = () => {
      const value = probe();
      if (value !== undefined) {
        clearInterval(interval);
        resolveValue(value);
      } else if (Date.now() >= deadline) {
        clearInterval(interval);
        reject(new Error("timed out waiting for Vitest sequencing probe barrier"));
      }
    };
    const interval = setInterval(check, 10);
    check();
  });
}

function readEvents(path: string): ProbeEvent[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as ProbeEvent);
}

it("orders the actual E2E projects and gives lifecycle files one worker", async () => {
  const root = resolve(import.meta.dirname, "..");
  const directory = mkdtempSync(join(root, ".vitest-sequence-probe-"));
  const eventsPath = join(directory, "events.jsonl");
  const lockPath = join(directory, "lifecycle.lock");
  const frontendRelease = join(directory, "release-frontend");
  const setupRelease = join(directory, "release-setup");
  const releasePath = (fixture: string) => join(directory, `release-${fixture}`);
  const helperPath = join(directory, "barrier.ts");
  const frontendPath = join(directory, "probe-frontend.e2e.test.ts");
  const lifecycleAPath = join(directory, "probe-lifecycle-a.e2e.test.ts");
  const lifecycleBPath = join(directory, "probe-lifecycle-b.e2e.test.ts");
  const setupPath = join(directory, "global-setup.ts");
  const configPath = join(directory, "vitest.config.ts");

  writeFileSync(
    helperPath,
    `import { appendFileSync, existsSync } from "node:fs";\n` +
      `export const record = (event: object) => appendFileSync(process.env.PI_ORB_SEQUENCE_EVENTS!, JSON.stringify(event) + "\\n");\n` +
      `export const barrier = async (path: string) => {\n` +
      `  const deadline = Date.now() + 10000;\n` +
      `  while (!existsSync(path)) {\n` +
      `    if (Date.now() >= deadline) throw new Error("probe barrier timed out: " + path);\n` +
      `    await new Promise<void>((resolve) => setTimeout(resolve, 10));\n` +
      `  }\n` +
      `};\n`,
  );
  writeFileSync(
    frontendPath,
    `import { it } from "vitest";\n` +
      `import { barrier, record } from ${JSON.stringify(helperPath)};\n` +
      `it("frontend owner", async () => {\n` +
      `  record({ event: "frontend-start" });\n` +
      `  await barrier(${JSON.stringify(frontendRelease)});\n` +
      `  record({ event: "frontend-end" });\n` +
      `});\n`,
  );
  const lifecycleSource = (fixture: string) =>
    `import { openSync, closeSync, unlinkSync } from "node:fs";\n` +
    `import { it } from "vitest";\n` +
    `import { barrier, record } from ${JSON.stringify(helperPath)};\n` +
    `it("lifecycle owner ${fixture}", async () => {\n` +
    `  const lock = openSync(${JSON.stringify(lockPath)}, "wx");\n` +
    `  record({ event: "lifecycle-start", fixture: ${JSON.stringify(fixture)} });\n` +
    `  try { await barrier(${JSON.stringify(releasePath(fixture))}); } finally {\n` +
    `    closeSync(lock); unlinkSync(${JSON.stringify(lockPath)});\n` +
    `  }\n` +
    `  record({ event: "lifecycle-end", fixture: ${JSON.stringify(fixture)} });\n` +
    `});\n`;
  writeFileSync(lifecycleAPath, lifecycleSource("a"));
  writeFileSync(lifecycleBPath, lifecycleSource("b"));
  writeFileSync(
    setupPath,
    `import { barrier, record } from ${JSON.stringify(helperPath)};\n` +
      `export default async function setup() {\n` +
      `  record({ event: "lifecycle-setup-start" });\n` +
      `  await barrier(${JSON.stringify(setupRelease)});\n` +
      `  record({ event: "lifecycle-setup-end" });\n` +
      `}\n`,
  );
  writeFileSync(
    configPath,
    `import { defineConfig } from "vitest/config";\n` +
      `import actual from ${JSON.stringify(pathToFileURL(join(root, "e2e/vitest.config.ts")).href)};\n` +
      `const source = actual as any;\n` +
      `const [frontend, lifecycle] = source.test.projects;\n` +
      `export default defineConfig({ ...source, test: { ...source.test, projects: [\n` +
      `  { ...frontend, test: { ...frontend.test, include: [${JSON.stringify(frontendPath)}] } },\n` +
      `  { ...lifecycle, test: { ...lifecycle.test, include: [${JSON.stringify(lifecycleAPath)}, ${JSON.stringify(lifecycleBPath)}], exclude: [], globalSetup: [${JSON.stringify(setupPath)}] } },\n` +
      `] } });\n`,
  );

  const child = spawn(resolve(root, "node_modules/.bin/vitest"), ["run", "--config", configPath], {
    cwd: root,
    env: { ...process.env, PI_ORB_SEQUENCE_EVENTS: eventsPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const exited = new Promise<number | null>((resolveExit) => child.once("exit", resolveExit));

  try {
    const firstEvent = await waitFor(() => readEvents(eventsPath)[0]);
    if (firstEvent.event === "lifecycle-setup-start") {
      expect(readEvents(eventsPath)).toEqual([{ event: "lifecycle-setup-start" }]);
      writeFileSync(setupRelease, "release");
      await waitFor(() =>
        readEvents(eventsPath).find((event) => event.event === "lifecycle-setup-end"),
      );
      await waitFor(() => readEvents(eventsPath).find((event) => event.event === "frontend-start"));
    } else {
      expect(firstEvent.event).toBe("frontend-start");
    }
    const beforeFrontendRelease = readEvents(eventsPath);
    expect(beforeFrontendRelease.some((event) => event.event === "lifecycle-start")).toBe(false);
    writeFileSync(frontendRelease, "release");
    await waitFor(() => readEvents(eventsPath).find((event) => event.event === "frontend-end"));
    if (!beforeFrontendRelease.some((event) => event.event === "lifecycle-setup-start")) {
      await waitFor(() =>
        readEvents(eventsPath).find((event) => event.event === "lifecycle-setup-start"),
      );
      writeFileSync(setupRelease, "release");
      await waitFor(() =>
        readEvents(eventsPath).find((event) => event.event === "lifecycle-setup-end"),
      );
    }

    const first = await waitFor(() =>
      readEvents(eventsPath).find((event) => event.event === "lifecycle-start"),
    );
    expect(first.fixture).toMatch(/^[ab]$/u);
    writeFileSync(releasePath(first.fixture as string), "release");
    await waitFor(() =>
      readEvents(eventsPath).find(
        (event) => event.event === "lifecycle-end" && event.fixture === first.fixture,
      ),
    );

    const second = await waitFor(() =>
      readEvents(eventsPath).find(
        (event) => event.event === "lifecycle-start" && event.fixture !== first.fixture,
      ),
    );
    writeFileSync(releasePath(second.fixture as string), "release");
    expect(await exited).toBe(0);

    const events = readEvents(eventsPath);
    const frontendStart = events.findIndex((event) => event.event === "frontend-start");
    const frontendEnd = events.findIndex((event) => event.event === "frontend-end");
    const setupStart = events.findIndex((event) => event.event === "lifecycle-setup-start");
    const setupEnd = events.findIndex((event) => event.event === "lifecycle-setup-end");
    const firstLifecycle = events.findIndex((event) => event.event === "lifecycle-start");
    expect(frontendEnd).toBeGreaterThan(frontendStart);
    expect(setupEnd).toBeGreaterThan(setupStart);
    expect(setupEnd < frontendStart || setupStart > frontendEnd).toBe(true);
    expect(firstLifecycle).toBeGreaterThan(frontendEnd);
    let activeLifecycleFiles = 0;
    let peakLifecycleFiles = 0;
    for (const event of events) {
      if (event.event === "lifecycle-start") activeLifecycleFiles += 1;
      if (event.event === "lifecycle-end") activeLifecycleFiles -= 1;
      peakLifecycleFiles = Math.max(peakLifecycleFiles, activeLifecycleFiles);
      expect(activeLifecycleFiles).toBeGreaterThanOrEqual(0);
    }
    expect(activeLifecycleFiles).toBe(0);
    expect(peakLifecycleFiles).toBe(1);
    expect(events.filter((event) => event.event === "lifecycle-end")).toHaveLength(2);
  } catch (error) {
    child.kill("SIGKILL");
    await exited;
    throw new Error(`${String(error)}\nVitest probe output:\n${output}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
