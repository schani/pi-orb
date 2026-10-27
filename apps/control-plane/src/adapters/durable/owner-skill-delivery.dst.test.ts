import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { FileError } from "@earendil-works/pi-durable/env";
import { expect, it } from "vitest";
import { runDst } from "../../testkit/sim.ts";
import { ownerSkillBundle } from "./owner-skill-bundle.ts";
import { installOwnerSkills } from "./owner-skill-delivery.ts";

it("DST publishes only complete adopted bundles across concurrent bindings/settings edits", async () => {
  await runDst({ name: "owner-skill-delivery", iterations: 25 }, async (sim) => {
    const skill = {
      name: "mine",
      content: "adopted",
      files: [{ path: "script.sh", base64: "AP8=", executable: true }],
      source: null,
    };
    const captured = ownerSkillBundle([skill])._unsafeUnwrap();
    const dirs = new Set<string>();
    const bytes = new Map<string, Uint8Array>();
    const publications: string[][] = [];
    const tasks = [0, 1].map((index) => ({
      name: `binding-${index}`,
      f: async (task: Parameters<Parameters<typeof sim.runTasks>[0][number]["f"]>[0]) => {
        const checkpoint = async () => {
          await task.checkpoint("installation operation");
        };
        const env = {
          fileInfo: async (path: string) => {
            await checkpoint();
            return dirs.has(path)
              ? { ok: true, value: { kind: "directory" } }
              : { ok: false, error: new FileError("not_found", "missing") };
          },
          createDir: async (path: string, options: { recursive?: boolean }) => {
            await checkpoint();
            if (dirs.has(path) && !options?.recursive)
              return { ok: false, error: new FileError("unknown", "exists") };
            dirs.add(path);
            return { ok: true, value: undefined };
          },
          writeFile: async (path: string, value: string | Uint8Array) => {
            await checkpoint();
            bytes.set(path, typeof value === "string" ? Buffer.from(value) : value);
            return { ok: true, value: undefined };
          },
          remove: async (path: string) => {
            await checkpoint();
            for (const key of bytes.keys()) if (key.startsWith(path + "/")) bytes.delete(key);
            for (const key of dirs)
              if (key === path || key.startsWith(path + "/")) dirs.delete(key);
            return { ok: true, value: undefined };
          },
          exec: async (args: string[], options: { onOutput: (text: string) => void }) => {
            await checkpoint();
            const root = args[3]!,
              stage = args[4]!,
              phase = args[5]!;
            const complete = captured.files.every((f) => bytes.has(f.path));
            if (phase === "verify") options.onOutput(complete ? "verified" : "missing");
            else if (complete) options.onOutput("verified");
            else {
              const manifest = JSON.parse(
                Buffer.from(bytes.get(stage + "/.manifest.json")!).toString(),
              ) as Array<{ path: string }>;
              expect(manifest.every((f) => bytes.has(stage + "/" + f.path))).toBe(true);
              for (const f of manifest)
                bytes.set(root + "/" + f.path, bytes.get(stage + "/" + f.path)!);
              dirs.add(root);
              publications.push([...bytes.keys()].filter((p) => p.startsWith(root + "/")));
              options.onOutput("installed");
            }
            return { ok: true, value: { exitCode: 0 } };
          },
        } as unknown as ExecutionEnv;
        const installed = await installOwnerSkills(env, captured, BACKGROUND_CONTEXT, checkpoint);
        expect(installed.isOk()).toBe(true);
      },
    }));
    const result = await sim.runTasks([
      ...tasks,
      {
        name: "owner-edit",
        f: async (task) => {
          await task.checkpoint("edit latest settings");
          skill.content = "latest";
          skill.files = [];
        },
      },
    ]);
    expect(result.isErr() ? result.error : null).toBeNull();
    expect(publications.length).toBe(1);
    expect(publications[0]?.sort()).toEqual(captured.files.map((f) => f.path).sort());
    for (const f of captured.files)
      expect(Buffer.from(bytes.get(f.path)!)).toEqual(Buffer.from(f.bytes));
    expect([...dirs].filter((p) => p.includes(".stage-"))).toEqual([]);
  });
});
