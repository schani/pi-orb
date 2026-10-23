import { NoSimulationTask } from "determined";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_USER_ID } from "../../testkit/fixtures.ts";
import type { StoreContractSubject } from "../../testkit/store-contract.ts";
import { jsonParam } from "./client.ts";

const task = new NoSimulationTask("history search", false);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [project, otherProject, foreignProject, orb, claude, otherOrb, foreignOrb, foreignOwner] = [
  11, 12, 13, 21, 22, 23, 24, 2,
].map(id) as [string, string, string, string, string, string, string, string];
const message = (text: string, extra: Record<string, unknown> = {}) => ({
  type: "message",
  role: "assistant",
  content: [{ type: "text", text }],
  overflow: {},
  ...extra,
});

export function historySearchContractTests(
  label: string,
  open: () => Promise<StoreContractSubject>,
) {
  describe(label + " history search", () => {
    let subject: StoreContractSubject;
    const sql = async (query: string, values: unknown[] = []) => {
      const result = await subject.client.query(query, values);
      expect(result.isOk(), result.isErr() ? JSON.stringify(result.error) : query).toBe(true);
      return result._unsafeUnwrap();
    };
    const text = async (record: unknown) =>
      (await sql("SELECT history_search_public_text($1::json) AS text", [jsonParam(record)]))
        .rows[0]?.["text"];
    const add = async (
      recordId: string,
      record: Record<string, unknown>,
      orbId = orb,
      parent: string | null = null,
    ) => {
      const value = {
        id: recordId,
        parentId: parent,
        timestamp: "2026-10-23T00:00:00Z",
        ...record,
      };
      await sql(
        "INSERT INTO history_records (orb_id,record_id,parent_id,record) VALUES ($1,$2,$3,$4::json)",
        [orbId, recordId, parent, jsonParam(value)],
      );
      await sql("UPDATE orbs SET replication_cursor=$2,replicated_head_id=$2 WHERE id=$1", [
        orbId,
        recordId,
      ]);
      return value;
    };
    const search = (
      query: string,
      extra: { projectId?: string; orbId?: string; limit?: number } = { orbId: orb },
    ) =>
      subject.database.store.searchHistory(task, {
        ownerUserId: TEST_USER_ID,
        query,
        limit: 50,
        ...extra,
      });

    beforeAll(async () => {
      subject = await open();
      (await subject.database.migrate())._unsafeUnwrap();
      for (const owner of [TEST_USER_ID, foreignOwner])
        await sql(
          "INSERT INTO users(id,identity_issuer,identity_subject,created_at,updated_at) VALUES ($1::uuid,'test',$1::uuid::text,now(),now())",
          [owner],
        );
      for (const [projectId, owner] of [
        [project, TEST_USER_ID],
        [otherProject, TEST_USER_ID],
        [foreignProject, foreignOwner],
      ])
        await sql(
          "INSERT INTO projects(id,owner_user_id,name,repository_url) VALUES ($1::uuid,$2::uuid,$1::uuid::text,'https://example.test/repo')",
          [projectId, owner],
        );
      for (const [orbId, projectId, harness] of [
        [orb, project, "pi"],
        [claude, project, "claude"],
        [otherOrb, otherProject, "claude"],
        [foreignOrb, foreignProject, "claude"],
      ])
        await sql(
          `INSERT INTO orbs(id,project_id,state,host_kind,harness,harness_session_id,harness_session_header)
         VALUES ($1,$2,'stopped','fake',$3,'session','{"id":"session","overflow":{}}'::json)`,
          [orbId, projectId, harness],
        );
    });
    beforeEach(async () => {
      await sql("UPDATE orbs SET replication_cursor=NULL,replicated_head_id=NULL");
      await sql("DELETE FROM history_records");
    });
    afterAll(async () => {
      (await subject.database.close())._unsafeUnwrap();
    });

    it("selects public text without private configuration, reasoning, images or artifacts", async () => {
      const blocks = [
        { type: "text", text: "public" },
        { type: "reasoning", text: "private-reasoning" },
        { type: "image", data: "private-image", url: "https://private.invalid" },
        { type: "other", contentType: "artifact", data: { text: "private-artifact" } },
      ];
      const event = {
        type: "event",
        eventType: "custom",
        content: blocks,
        overflow: { native: { text: "private-native", children: ["private-child"] } },
      };
      for (const [record, expected] of [
        [message("", { content: blocks, overflow: event.overflow }), "public"],
        ...["system", "developer"].map((role) => [message("private-config", { role }), ""]),
        ...["claude.auth", "claude.task_notification", "claude.compact_command", "custom"].map(
          (eventType) => [{ ...event, eventType }, ""],
        ),
        [{ ...event, custom: { customType: "shown", display: true } }, "public"],
        ...["orb.message", "agent.settings_fallback", "agent.compaction"].map((eventType) => [
          { ...event, eventType },
          "public",
        ]),
        [{ type: "compaction", summary: blocks, overflow: event.overflow }, "public"],
        [
          message("public", {
            failure: { message: "failure", diagnostics: ["private-diagnostic"] },
          }),
          "public\nfailure",
        ],
        [
          {
            ...event,
            eventType: "orb.alert",
            alert: { message: "alert", requestId: "private-id" },
          },
          "alert",
        ],
      ])
        expect(await text(record), JSON.stringify(record)).toBe(expected);
    });

    it("applies native delivery visibility and public child-notice precedence", async () => {
      const native = { type: "user", isMeta: true };
      for (const [origin, expected] of [
        [undefined, ""],
        ...[undefined, "scheduled-trigger", "peer-send-message", "session-inbox"].map((subkind) => [
          { kind: "task-notification", subkind },
          "delivery",
        ]),
        [{ kind: "task-notification", subkind: "unknown" }, ""],
      ])
        expect(
          await text(
            message("delivery", { role: "user", overflow: { native: { ...native, origin } } }),
          ),
        ).toBe(expected);
      const echo = "<local-command-stdout>Compacted</local-command-stdout>";
      const record = message(echo, {
        role: "user",
        overflow: { native: { type: "user", message: { role: "user", content: echo } } },
      });
      expect(await text(record)).toBe("");
      expect(await text({ ...record, inboxMessageIds: ["human"] })).toBe(echo);
      const event = {
        type: "event",
        eventType: "custom",
        content: [{ type: "text", text: "private-child-content" }],
        subagentTask: { prompt: "private-task" },
        overflow: { children: ["private-child"] },
      };
      for (const [subagent, expected] of [
        [{ kind: "notification", message: "notice" }, "notice"],
        [
          {
            kind: "notification",
            description: "description",
            status: "failed",
            message: "private-message",
            error: "error",
            resultPreview: "private-preview",
          },
          "description\nfailed\nerror",
        ],
        [{ kind: "notification", resultPreview: "preview" }, "preview"],
        [
          {
            kind: "notification",
            status: "failed",
            error: "\n\t",
            resultPreview: "public-preview",
          },
          "failed\npublic-preview",
        ],
        [
          { kind: "notification", error: "\u00a0\uFEFF", resultPreview: "public-preview" },
          "public-preview",
        ],
        [{ kind: "update", message: "\t\n\uFEFF" }, ""],
        [{ kind: "update", message: "update", resultPreview: "private-preview" }, "update"],
        [
          { kind: "workspace_notice", notice: "workspace", message: "private-message" },
          "workspace",
        ],
      ])
        expect(await text({ ...event, subagent }), JSON.stringify(subagent)).toBe(expected);
    });

    it("bounds public tool excerpts and excludes bash metadata, nested calls and nontext result leaves", async () => {
      const value = await text(
        message("", {
          content: [
            {
              type: "tool_call",
              name: "bash",
              callId: "c",
              arguments: { command: "echo visible", private: "private-bash" },
            },
            {
              type: "tool_call",
              name: "read",
              callId: "r",
              arguments: { path: "visible/path", nested: { value: "argument" } },
            },
            {
              type: "tool_result",
              callId: "c",
              content: [
                { type: "text", text: "result" },
                { type: "reasoning", text: "private-result" },
                { type: "image", data: "private-image" },
                { type: "other", contentType: "artifact", data: "private-artifact" },
              ],
              nestedCalls: { calls: [{ arguments: { path: "private-child" } }] },
              overflow: { private: "private-overflow" },
            },
          ],
        }),
      );
      for (const part of ["bash", "echo visible", "read", "visible/path", "argument", "result"])
        expect(value).toContain(part);
      expect(value).not.toContain("private");
      const bounded = await text(
        message("", {
          content: [
            {
              type: "tool_result",
              callId: "c",
              content: [{ type: "text", text: "a".repeat(2000) + "excluded" }],
            },
          ],
        }),
      );
      expect(bounded).toBe("a".repeat(2000));
      const argumentsText = await text(
        message("", {
          content: [
            {
              type: "tool_call",
              name: "read",
              callId: "r",
              arguments: { path: "a".repeat(3000) + "excluded" },
            },
          ],
        }),
      );
      expect(argumentsText).toHaveLength(2000);
      expect(argumentsText).not.toContain("excluded");
      expect(await text(message("a".repeat(3000)))).toHaveLength(3000);
    });

    it("uses exact scoped corpus statistics, Pi cursor ancestry, all committed Claude branches and ranks before limit", async () => {
      await add("a1", message("needle ".repeat(600)));
      await add("a2", message("needle other x"), orb, "a1");
      await add("a3", message("other other other other"), orb, "a2");
      await add("orphan", message("needle ".repeat(100)));
      await sql("UPDATE orbs SET replication_cursor='a3',replicated_head_id='a3' WHERE id=$1", [
        orb,
      ]);
      await add("b1", message("needle"), claude);
      await add("b2", message("other"), claude);
      await add("c1", message("needle"), otherOrb);
      await add("d1", message("needle"), foreignOrb);
      for (const [scope, n, ids] of [
        [{ orbId: orb }, 3, ["a1", "a2"]],
        [{ projectId: project }, 5, ["a1", "b1", "a2"]],
        [{}, 6, ["a1", "b1", "c1", "a2"]],
      ] as const) {
        const result = (await search("needle needle", scope))._unsafeUnwrap();
        expect(result.documentCount).toBe(n);
        expect(result.candidateCount).toBe(ids.length);
        expect(result.hits.map((hit) => hit.recordId)).toEqual(ids);
      }
      expect((await search("needle", { orbId: foreignOrb }))._unsafeUnwrap().hits).toEqual([]);
      expect((await search("!!!"))._unsafeUnwrap().hits).toEqual([]);
      const all = (await search("needle other absent needle"))._unsafeUnwrap();
      expect(all.documentCount).toBe(3);
      expect(all.candidateCount).toBe(3);
      for (const [recordId, dl, needleTf, otherTf] of [
        ["a1", 600, 600, 0],
        ["a2", 3, 1, 1],
        ["a3", 4, 0, 4],
      ] as const) {
        const termScore = (tf: number, df: number) =>
          tf === 0
            ? 0
            : (Math.log(1 + (3 - df + 0.5) / (df + 0.5)) * tf * 2.2) /
              (tf + 1.2 * (0.25 + (0.75 * dl) / (607 / 3)));
        expect(all.hits.find((hit) => hit.recordId === recordId)?.score).toBeCloseTo(
          termScore(needleTf, 2) + termScore(otherTf, 2),
          12,
        );
      }
      expect((await search("needle other", { orbId: orb, limit: 2 }))._unsafeUnwrap().hits).toEqual(
        all.hits.slice(0, 2),
      );
    });

    it("indexes lossless NUL/surrogate source and query JSON consistently across languages and long tokens", async () => {
      const content = "Ａ é ﬁ ١ १२ 你好 ไทย क् before\u0000after literal\\u0000 😀 \uD800";
      const record = await add(
        "unicode",
        message(content, { overflow: { private: "\u0000\uD800" } }),
      );
      const tokens = (
        await sql(
          "SELECT history_search_tokens(history_search_public_text(record)) AS tokens FROM history_records",
        )
      ).rows[0]?.["tokens"];
      expect(tokens).toEqual([
        "a",
        "é",
        "fi",
        "١",
        "१२",
        "你好",
        "ไทย",
        "क",
        "before",
        "after",
        "literal",
        "u0000",
      ]);
      expect(
        (await search("before\u0000after \uD800"))._unsafeUnwrap().hits.map((hit) => hit.recordId),
      ).toEqual(["unicode"]);
      expect((await sql("SELECT record FROM history_records")).rows[0]?.["record"]).toEqual(record);
      for (const [source, expected] of [
        ['"\\ud800\\udc00"', "𐀀"],
        ['"\\uD801\\uDC00"', "𐐀"],
        ['"before\\u0000after"', "before after"],
        ['"\\ud800"', " "],
        ['"\\udc00"', " "],
        ['"\\\\u0000"', "\\u0000"],
        ['"\\\\ud800"', "\\ud800"],
      ])
        expect(
          (await sql("SELECT history_search_safe_json($1::text::json)#>>'{}' AS text", [source]))
            .rows[0]?.["text"],
        ).toBe(expected);
      const long = "a".repeat(100000);
      expect(
        (await sql("SELECT history_search_keys($1::json) AS keys", [jsonParam(message(long))]))
          .rows[0]?.["keys"],
      ).toEqual([expect.stringMatching(/^[0-9a-f]{32}$/)]);
      await add("long", message(long), orb, "unicode");
      expect((await search(long))._unsafeUnwrap().hits.map((hit) => hit.recordId)).toEqual([
        "long",
      ]);
      const snippet = (await search("after"))._unsafeUnwrap().hits[0]?.snippet ?? "";
      expect(snippet.length).toBeLessThanOrEqual(500);
      expect(snippet).toContain("after");
      expect(await text(message("\\\u0000"))).toBe("\\ ");
      await add("snippet", message(`${"😀".repeat(300)}needle${"😀".repeat(300)}`), orb, "long");
      const centered = (await search("needle"))._unsafeUnwrap().hits[0]?.snippet ?? "";
      expect(centered).toContain("needle");
      expect(centered.length).toBeLessThanOrEqual(500);
      expect(centered).not.toMatch(/[\uD800-\uDFFF]/u);
    });

    it("indexes existing and future source-only writes without application hooks", async () => {
      await sql("DROP INDEX history_records_search_idx");
      await add("old", message("existing"));
      await sql(
        "CREATE INDEX history_records_search_idx ON history_records USING gin(history_search_keys(record))",
      );
      expect((await search("existing"))._unsafeUnwrap().hits.map((hit) => hit.recordId)).toEqual([
        "old",
      ]);
      await sql("SET enable_seqscan=off");
      try {
        const plan = await sql(
          "EXPLAIN (COSTS OFF) SELECT record_id FROM history_records WHERE history_search_keys(record) && ARRAY[md5('existing')]",
        );
        expect(JSON.stringify(plan.rows)).toContain("history_records_search_idx");
      } finally {
        await sql("RESET enable_seqscan");
      }
      await add("new", message("future"), orb, "old");
      expect((await search("future"))._unsafeUnwrap().hits.map((hit) => hit.recordId)).toEqual([
        "new",
      ]);
    });
  });
}
