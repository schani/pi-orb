import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  api,
  createFakeSession,
  deleteFakeSession,
  FatalProbeError,
  fakeControl,
  readReplicatedHistorySnapshot,
  startControlPlane,
  waitFor,
} from "./harness.ts";
import { committedToolOutput } from "./testkit/durable-wait-barriers.ts";
import { ownedControlPlaneIngress } from "./testkit/owned-control-plane-ingress.ts";

it.runIf(process.env["PI_ORB_E2E_BACKEND"] === "process")(
  "searches committed central Pi history through codemode and the authenticated pi-orb CLI",
  async () => {
    const runId = randomUUID();
    const root = mkdtempSync(join(tmpdir(), "pi-orb-history-search-"));
    const evidence = join(import.meta.dirname, "../test-failures", `history-search-${runId}`);
    const ingress = await ownedControlPlaneIngress();
    const stop = { type: "stop", status: "completed" };
    const marker = `searchneedle${runId.replaceAll("-", "")}`;
    const searchCode = `
const catalog = await describeNamespace('orb');
if (!catalog?.tools.includes('orb_search_history')) throw new Error('search absent from orb namespace');
const result = await tools.orb_search_history({query:${JSON.stringify(marker)}});
if (!Array.isArray(result.hits) || !result.hits.some(hit => hit.snippet.includes(${JSON.stringify(marker)}))) {
  throw new Error('committed marker absent: ' + JSON.stringify(result));
}
text('HISTORY_SEARCH_RESULT:' + JSON.stringify(result));`;
    const fake = await createFakeSession(`history-search-${runId}`, {
      model: {
        rules: [
          {
            match: { toolResultContains: { regex: "HISTORY_SEARCH_RESULT:" } },
            steps: [{ type: "text", content: "HISTORY_SEARCH_DONE" }, stop],
          },
          {
            match: { userMessage: { regex: "^SEARCH_HISTORY$" } },
            steps: [{ type: "toolCall", name: "codemode", arguments: { code: searchCode } }, stop],
          },
          {
            match: { userMessage: { regex: "^STORE_HISTORY$" } },
            steps: [{ type: "text", content: marker }, stop],
          },
          {
            match: { default: true },
            steps: [{ type: "text", content: "History search fixture" }, stop],
          },
        ],
      },
    });
    const project = randomUUID();
    const orb = randomUUID();
    let cp: Awaited<ReturnType<typeof startControlPlane>> | undefined;
    let failed = true;
    try {
      cp = await startControlPlane({
        port: 0,
        fake,
        pglitePath: join(root, "db"),
        authDir: join(root, "auth"),
        processStateDirectory: join(root, "hosts"),
        durableStateDirectory: join(root, "authority"),
        extraEnv: {
          PI_ORB_E2E_HISTORY_INSPECTION: "1",
          PI_ORB_APP_ORIGIN: ingress.baseUrl,
          PI_ORB_BROKER_URL: ingress.baseUrl,
        },
      });
      const active = cp;
      ingress.connect(active.baseUrl);
      expect(
        (
          await api(active.baseUrl, "POST", "/api/v1/projects", {
            id: project,
            name: "History search",
            repositoryUrl: null,
          })
        ).status,
      ).toBe(201);
      expect(
        (
          await api(active.baseUrl, "POST", `/api/v1/projects/${project}/orbs`, {
            id: orb,
          })
        ).status,
      ).toBe(202);
      const code = await waitFor(
        "published central Pi model login",
        async () => {
          const view = await api(active.baseUrl, "GET", `/api/v1/orbs/${orb}`);
          const action = view.body["actionRequired"] as
            | { type?: string; userCode?: string; verificationUri?: string }
            | undefined;
          return action?.type === "openai_codex_device_login" &&
            action.userCode &&
            action.verificationUri
            ? action.userCode
            : null;
        },
        { timeoutMs: 60_000 },
      );
      await fakeControl(fake.sessionKey, "/deviceauth/approve", { user_code: code });
      await waitFor(
        "process execution ready",
        async () => {
          const view = await api(active.baseUrl, "GET", `/api/v1/orbs/${orb}`);
          if (view.body["state"] === "failed" || active.process.exitCode !== null)
            throw new FatalProbeError(JSON.stringify(view));
          return view.body["state"] === "running" ? true : null;
        },
        { timeoutMs: 300_000 },
      );
      const submit = async (text: string) => {
        expect(
          (
            await api(active.baseUrl, "PUT", `/api/v1/orbs/${orb}/messages/${randomUUID()}`, {
              content: [{ type: "text", text }],
            })
          ).status,
        ).toBe(202);
      };
      await submit("STORE_HISTORY");
      const committed = await waitFor(
        "marker is in committed public history before any search",
        async () => {
          const snapshot = await readReplicatedHistorySnapshot(active, orb);
          const record = snapshot.records.find(
            (record) =>
              record.type === "message" &&
              record.role === "assistant" &&
              record.content.some((block) => block.type === "text" && block.text === marker),
          );
          return record && snapshot.session ? { record, sessionId: snapshot.session.id } : null;
        },
      );
      writeFileSync(join(root, "commit-barrier.json"), JSON.stringify(committed, null, 2));
      const metadata = JSON.parse(readFileSync(join(root, "hosts", orb, "host.json"), "utf8")) as {
        runtimeToken: string;
      };
      const cli = (args: string[]): Promise<string> =>
        new Promise((resolve, reject) => {
          execFile(
            join(import.meta.dirname, "../apps/orb-runtime/docker/pi-orb"),
            args,
            {
              env: {
                ...process.env,
                PI_ORB_CONTROL_PLANE_URL: active.baseUrl,
                PI_ORB_RUNTIME_TOKEN: metadata.runtimeToken,
              },
              timeout: 30_000,
            },
            (error, stdout, stderr) => {
              if (error)
                reject(new Error(`pi-orb ${args.join(" ")} failed: ${stderr}`, { cause: error }));
              else resolve(stdout);
            },
          );
        });
      const expectedHit = {
        orbId: orb,
        sessionId: committed.sessionId,
        recordId: committed.record.id,
        projectName: "History search",
        snippet: marker,
        orbUrl: `${ingress.baseUrl}/orbs/${orb}`,
      };
      for (const scope of [[], ["--orb", orb], ["--project"], ["--all"]]) {
        const result = JSON.parse(
          await cli(["search", marker, ...scope, "--limit", "1", "--json"]),
        );
        writeFileSync(
          join(root, `cli-${scope[0]?.slice(2) ?? "default"}.json`),
          JSON.stringify(result, null, 2),
        );
        expect(result).toMatchObject({ v: 1, hits: [expectedHit] });
        expect(result.hits).toHaveLength(1);
        expect(result.hits[0].score).toBeGreaterThan(0);
        expect(result.hits[0].name === null || typeof result.hits[0].name === "string").toBe(true);
      }
      expect(
        JSON.parse(await cli(["search", `absent${runId.replaceAll("-", "")}`, "--json"])),
      ).toEqual({ v: 1, hits: [] });
      const unauthorized = await fetch(`${active.baseUrl}/runtime/v1/history/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: marker }),
      });
      expect(unauthorized.status).toBe(401);

      await submit("SEARCH_HISTORY");
      const searched = await waitFor("real Pi codemode search result committed", async () => {
        const snapshot = await readReplicatedHistorySnapshot(active, orb);
        return committedToolOutput(snapshot.records, "HISTORY_SEARCH_RESULT:") ? snapshot : null;
      });
      const outputs = searched.records.flatMap((record) =>
        record.type === "message" && record.role === "tool"
          ? record.content.flatMap((block) =>
              block.type === "tool_result"
                ? block.content.flatMap((leaf) => (leaf.type === "text" ? [leaf.text] : []))
                : [],
            )
          : [],
      );
      expect(
        outputs.some(
          (output) =>
            output.includes("HISTORY_SEARCH_RESULT:") && output.includes(committed.record.id),
        ),
      ).toBe(true);
      writeFileSync(join(root, "searched-history.json"), JSON.stringify(searched, null, 2));
      failed = false;
    } finally {
      if (cp) {
        await cp.stop();
        writeFileSync(join(root, "control-plane.log"), cp.logs.join(""));
        writeFileSync(join(root, "model-requests.json"), JSON.stringify(cp.modelRequests, null, 2));
      }
      await ingress.close();
      await deleteFakeSession(fake.sessionKey);
      if (failed) {
        mkdirSync(evidence, { recursive: true });
        for (const name of [
          "commit-barrier.json",
          "control-plane.log",
          "model-requests.json",
          "searched-history.json",
          "cli-default.json",
          "cli-orb.json",
          "cli-project.json",
          "cli-all.json",
        ]) {
          if (existsSync(join(root, name)))
            writeFileSync(join(evidence, name), readFileSync(join(root, name)));
        }
        console.error(`History search E2E evidence: ${evidence}; fixture: ${root}`);
      } else {
        rmSync(root, { recursive: true, force: true });
      }
    }
  },
  420_000,
);
