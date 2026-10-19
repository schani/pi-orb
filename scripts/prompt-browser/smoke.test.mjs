import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { test } from "node:test";
import { chromium, expect } from "@playwright/test";
import { chromiumExecutable } from "./browser.ts";
import { CATALOG } from "./catalog.ts";
import { start } from "./server.ts";
import { SourceAdapter } from "./source.ts";

const root = new URL("../../", import.meta.url);
const literal =
  "# Working in {{project}}\n\nHelp the user make small, tested changes. Treat <script> tags as text.";
const initial = () => [
  {
    id: "main",
    title: "Main prompt",
    category: "Runtime",
    scope: "Orb",
    editable: true,
    content: literal,
    revision: "1",
    variables: ["project"],
    note: "{{project}} is the current project name.",
  },
  {
    id: "tools",
    title: "orb_send",
    category: "Tools",
    scope: "Root and child",
    editable: true,
    content: "Send a message to another orb in this project.",
    revision: "1",
  },
  {
    id: "external",
    title: "Provider defaults",
    category: "External",
    scope: "Package",
    editable: false,
    content: "Follow the provider’s safety instructions.",
    revision: "1",
    note: "Provided by the model provider",
  },
  {
    id: "child-tool",
    title: "orb_alert",
    category: "Tools",
    scope: "Child",
    editable: true,
    content: "Notify the parent about a result or blocker.",
    revision: "1",
  },
  {
    id: "skill",
    title: "boot-hooks",
    category: "Skills",
    scope: "Root and child",
    editable: true,
    content: "Configure the environment before the agent starts.",
    revision: "1",
  },
];
const source = new SourceAdapter(root.pathname);
const overlapCorpus = await Promise.all(
  CATALOG.map(async (definition) => {
    const result = await source.read(definition);
    assert.ok(result.isOk(), definition.id);
    return result._unsafeUnwrap();
  }),
);
const auditedPairs = {
  positive: [
    ["system/child-restriction", "tool/subagent"],
    ["tool/orb_archive", "tool/orb_delete"],
    ["tool/orb_archive", "namespace/orb-instructions"],
    ["system/environment", "skill/boot-hooks/body"],
    ["lifecycle/restart-0", "lifecycle/restart-1"],
    ["aux/name-system", "aux/headline-system"],
    ["aux/name-user", "aux/headline-user"],
    ["aux/name-user", "aux/summary-user"],
    ["skill/codemode-quick-reference/body", "feedback/limit-callbacks"],
    ["skill/cloud-identity/description", "skill/cloud-identity/body"],
    ["codemode/policy", "feedback/shell-uncertain"],
  ],
  negative: [
    ["tool/orb_spawn", "tool/subagent"],
    ["tool/orb_alert", "feedback/alert-role"],
    ["tool/orb_sleep", "lifecycle/sleep-finished"],
    ["lifecycle/restart-0", "lifecycle/restart-2"],
    ["feedback/shell-timeout", "parameter/bash/timeout"],
    ["feedback/codemode-artifact", "feedback/codemode-truncated"],
    ["feedback/admission-stopped", "feedback/admission-revoked"],
    ["tool/list_subagents", "tool/orb_list"],
    ["feedback/shell-callback", "feedback/codemode-execution"],
    ["namespace/mcp-description", "tool/mcp-resource-read"],
    ["system/environment-pi", "dynamic/personal"],
    ["parameter/read/path", "parameter/edit/path"],
    ["system/environment", "codemode/policy"],
  ],
};
const redundancyCorpus = overlapCorpus.filter(({ id }) =>
  [
    "system/codemode",
    "codemode/policy",
    "codemode/inline-images",
    "skill/codemode-manual/description",
    "skill/codemode-manual/body",
    "upstream/durable/codemode-code-parameter",
    "system/preamble",
  ].includes(id),
);

test("public assets do not publish private prompt snapshots", async () => {
  for (const file of ["app.js", "index.html", "app.css"]) {
    const asset = await readFile(new URL(`scripts/prompt-browser/${file}`, root), "utf8");
    for (const entry of overlapCorpus.filter(({ content }) => content.trim().length > 220)) {
      const content = entry.content.trim();
      assert.ok(!asset.includes(content.slice(0, 220)), `${file}: ${entry.id} leaked`);
      assert.ok(!asset.includes(JSON.stringify(content).slice(1, -1)), `${file}: ${entry.id}`);
    }
  }
});

let entries;
let listFailure;
let saveFailure;
let validationFailure;
let payloads;
let pauseSave;
let requests;
let releaseSave;
let saveStarted;
let nextList;
let releaseList;

function holdList() {
  const waiting = new Promise((resolve) => {
    releaseList = resolve;
  });
  const started = new Promise((resolve) => {
    nextList = async (snapshot) => {
      resolve(snapshot);
      await waiting;
    };
  });
  return { started, release: () => releaseList() };
}

const sameFile = (left, right) =>
  left.id === right.id ||
  (["tools", "child-tool"].includes(left.id) && ["tools", "child-tool"].includes(right.id));

test("prompt browser smoke", async (t) => {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const json = (status, data) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (url.pathname.startsWith("/api/")) {
      requests.push({ url: req.url, authorization: req.headers.authorization });
      if (req.headers.authorization !== "Bearer smoke-token") {
        json(401, { error: { code: "unauthorized", message: "Access denied" } });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/prompts") {
        if (listFailure)
          json(503, { error: { code: "unavailable", message: "Cannot read prompts" } });
        else {
          const snapshot = structuredClone(entries);
          const barrier = nextList;
          nextList = undefined;
          res.writeHead(200, {
            "content-type": "application/json",
            "cache-control": "no-store",
          });
          res.flushHeaders();
          if (barrier) await barrier(snapshot);
          res.end(JSON.stringify({ entries: snapshot }));
        }
        return;
      }
      if (req.method === "PUT") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const payload = JSON.parse(body);
        payloads.push(payload);
        const entry = entries.find(
          (item) => item.id === decodeURIComponent(url.pathname.split("/").at(-1)),
        );
        if (pauseSave) {
          saveStarted();
          await new Promise((resolve) => {
            releaseSave = resolve;
          });
        }
        if (validationFailure) {
          json(422, {
            error: { code: "invalid_variables", message: "Keep the prompt variables unchanged." },
          });
        } else if (saveFailure) {
          json(500, { error: { code: "write_failed", message: "Prompt is not writable" } });
        } else if (entry.revision !== payload.revision) {
          json(409, { error: { code: "conflict", message: "Prompt changed" } });
        } else {
          entry.content = payload.content;
          const revision = String(Number(entry.revision) + 1);
          for (const sibling of entries) {
            if (sameFile(entry, sibling)) sibling.revision = revision;
          }
          json(200, entry);
        }
        return;
      }
      json(404, { error: { code: "not_found", message: "Prompt doesn't exist" } });
      return;
    }
    let path;
    if (url.pathname === "/neverthrow.js") path = "node_modules/neverthrow/dist/index.es.js";
    else if (url.pathname === "/styles.css") path = "apps/web/src/styles.css";
    else if (url.pathname.startsWith("/fonts/")) path = `apps/web/public${url.pathname}`;
    else if (["/app.js", "/app.css"].includes(url.pathname))
      path = `scripts/prompt-browser${url.pathname}`;
    else path = "scripts/prompt-browser/index.html";
    try {
      const content = await readFile(new URL(path, root));
      const type = path.endsWith(".js")
        ? "text/javascript"
        : path.endsWith(".css")
          ? "text/css"
          : path.endsWith(".woff2")
            ? "font/woff2"
            : "text/html";
      res.writeHead(200, { "content-type": type });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const browser = await chromium.launch({
    executablePath: chromiumExecutable(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE),
    headless: true,
    args: ["--no-sandbox"],
  });
  t.after(async () => {
    releaseSave?.();
    releaseList?.();
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function scenario(
    name,
    run,
    { width = 1280, path = "/#token=smoke-token", setup = () => {} } = {},
  ) {
    await t.test(name, async () => {
      entries = initial();
      listFailure = false;
      saveFailure = false;
      validationFailure = false;
      payloads = [];
      pauseSave = false;
      releaseSave = undefined;
      nextList = undefined;
      releaseList = undefined;
      requests = [];
      setup();
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      try {
        await page.goto(origin + path);
        await run(page);
        assert.deepEqual(errors, []);
        const expectedToken = new URLSearchParams(new URL(origin + path).hash.slice(1)).get(
          "token",
        );
        assert.ok(requests.every((request) => request.authorization === `Bearer ${expectedToken}`));
        assert.ok(requests.every((request) => !request.url.includes("smoke-token")));
      } finally {
        await context.close();
      }
    });
  }
  const item = (page, name) =>
    page
      .getByRole("navigation", { name: "Prompt inventory" })
      .getByRole("link", { name, exact: false });
  const editor = (page) => page.getByRole("textbox", { name: "Prompt", exact: true });

  const templateSetup = () => {
    const ids = [
      "system/preamble",
      "system/codemode",
      "system/timezone",
      "system/claude-timezone",
      "system/environment",
      "system/environment-pi",
      "system/environment-claude",
      "system/network",
      "system/child-restriction",
      "dynamic/personal",
      "dynamic/project",
      "dynamic/repository-resources",
      "dynamic/runtime-values",
      "dynamic/claude-native",
      "dynamic/mcp",
      "repository/instructions",
      "upstream/pi/skills-heading",
      "upstream/pi/skills-read",
      "upstream/pi/skills-relative-paths",
      "codemode/policy",
      "codemode/inline-images",
      "upstream/durable/codemode-intro",
      ...[0, 1, 2, 3].map((i) => `upstream/durable/codemode-globals-${i}`),
      "upstream/durable/codemode-closing",
      "namespace/orb-description",
      "namespace/orb-instructions",
      "namespace/mcp-description",
      "namespace/mcp-instructions",
      ...[
        "boot-hooks",
        "charts",
        "cloud-identity",
        "codemode-manual",
        "codemode-quick-reference",
        "hosting",
      ].map((name) => `skill/${name}/description`),
      "skill/codemode-manual/body",
      ...[
        "orb_self",
        "orb_list",
        "orb_transcript",
        "orb_send",
        "orb_sleep",
        "orb_archive",
        "orb_delete",
        "orb_spawn",
        "orb_alert",
        "subagent",
        "steer_subagent",
        "get_subagent_result",
        "list_subagents",
        "cancel_subagent",
        "notify_parent",
        "read",
        "mcp-status",
        "mcp-resource-read",
        "mcp-resource-list",
      ].map((name) => `tool/${name}`),
      ...["write", "edit", "bash"].map((name) => `upstream/durable/${name}-description`),
      "upstream/durable/codemode-code-parameter",
    ];
    entries = ids.map((id) => ({
      id,
      title: id,
      category: "Template fixtures",
      scope: "Test",
      content: id.startsWith("dynamic/") || id === "system/environment-pi" ? "" : `BODY ${id}`,
      editable: !id.startsWith("upstream/") && !id.startsWith("dynamic/"),
      revision: "1",
    }));
    entries.find((entry) => entry.id === "upstream/durable/codemode-globals-1").content =
      overlapCorpus.find((entry) => entry.id === "upstream/durable/codemode-globals-1").content;
    entries.find((entry) => entry.id === "system/child-restriction").content =
      "{{parent_instructions}} CHILD AFTER";
    entries.find((entry) => entry.id === "system/claude-timezone").content =
      "User's time zone: {{time_zone}}.";
    entries.find((entry) => entry.id === "system/claude-timezone").variables = ["time_zone"];
  };

  await scenario(
    "initial-context composer: four variants, order, channels and holes",
    async (page) => {
      await expect(page.locator("#workspace")).toBeVisible();
      const result = await page.evaluate(async (fixtures) => {
        const { composeInitialContext } = await import("/app.js");
        const copy = JSON.stringify(fixtures);
        const variants = Object.fromEntries(
          ["pi", "claude"].flatMap((harness) =>
            ["root", "subagent"].map((role) => [
              `${harness}/${role}`,
              composeInitialContext(fixtures, { harness, role }),
            ]),
          ),
        );
        return {
          variants,
          unchanged: copy === JSON.stringify(fixtures),
          missingPolicy: composeInitialContext(
            fixtures.filter((e) => e.id !== "codemode/policy"),
            { harness: "pi", role: "root" },
          ),
          missing: composeInitialContext(
            fixtures.filter((e) => e.id !== "system/environment"),
            { harness: "pi", role: "root" },
          ),
        };
      }, entries);
      assert.equal(result.unchanged, true);
      for (const [variant, sections] of Object.entries(result.variants)) {
        const parts = sections.flatMap((s) => s.parts);
        assert.ok(parts.some((p) => p.availability === "runtime"));
        assert.ok(parts.some((p) => /task|user input/i.test(p.text)));
        assert.ok(!parts.some((p) => /compaction|lifecycle|\/body$/.test(p.id ?? "")));
        if (variant.startsWith("pi")) {
          assert.equal(sections[0].channel, "system");
          assert.match(sections[0].parts.map((p) => p.text).join(""), /<codemode>/);
          assert.ok(
            !sections
              .filter((s) => s.channel === "system")
              .flatMap((s) => s.parts)
              .some((p) => p.id === "codemode/policy"),
          );
          const modelTool = sections.find((s) => s.channel === "tools");
          const modelText = modelTool.parts.map((p) => p.text).join("");
          assert.ok(modelText.includes("BODY codemode/policy"));
          assert.ok(modelText.includes("BODY codemode/inline-images"));
          assert.ok(!modelText.includes("also saves the image"));
          assert.deepEqual(
            [...new Set(modelTool.parts.map((p) => p.id).filter(Boolean))],
            [
              "upstream/durable/codemode-intro",
              "upstream/durable/codemode-globals-0",
              "upstream/durable/codemode-globals-1",
              "codemode/inline-images",
              "upstream/durable/codemode-globals-2",
              "upstream/durable/codemode-globals-3",
              "upstream/durable/codemode-closing",
              "codemode/policy",
            ],
          );
          assert.ok(
            !modelTool.parts.some((p) => p.id === "upstream/durable/codemode-code-parameter"),
          );
          assert.deepEqual(
            sections.filter((s) => s.channel === "system").map((s) => s.title),
            ["Tool catalogue", "orb-instructions"],
          );
          const catalogue = sections[0].parts;
          assert.match(catalogue.map((p) => p.text).join(""), /declarations.*schemas/i);
          assert.ok(catalogue.some((p) => p.id === "namespace/orb-description"));
          for (const id of [
            "codemode/namespaces",
            "namespace/mcp-description",
            "namespace/mcp-instructions",
            "dynamic/mcp",
          ])
            assert.ok(!catalogue.some((p) => p.id === id), id);
          assert.ok(catalogue.some((p) => p.id === "namespace/orb-instructions"));
          assert.match(
            catalogue.map((p) => p.text).join(""),
            /Namespace orb: discover with describeNamespace/,
          );
          assert.ok(!parts.some((p) => p.id === "skill/codemode-manual/body"));
          assert.equal(parts.filter((p) => p.id === "skill/codemode-manual/description").length, 1);
          const parent = sections.find((s) => s.title === "orb-instructions").parts;
          const ids = parent.map((p) => p.id).filter(Boolean);
          const ordered = [
            "system/preamble",
            "dynamic/personal",
            "dynamic/repository-resources",
            "dynamic/project",
            "system/codemode",
            "system/timezone",
            "system/environment",
            "system/environment-pi",
            "upstream/pi/skills-heading",
            "upstream/pi/skills-read",
            "upstream/pi/skills-relative-paths",
            "skill/boot-hooks/description",
          ];
          assert.deepEqual(
            ids.filter((id) => ordered.includes(id)),
            ordered,
          );
          const suffix = parent.find((p) => p.id === "system/environment-pi");
          assert.equal(suffix.text, "");
          assert.equal(suffix.availability, "empty");
          assert.doesNotMatch(parent.map((p) => p.text).join(""), /pending|adopted|<cwd>/i);
          assert.equal(parent.filter((p) => p.id === "system/preamble").length, 1);
          assert.doesNotMatch(parent.map((p) => p.text).join(""), /\{\{parent_instructions\}\}/);
          const available = sections
            .find((s) => s.channel === "availability")
            .parts.map((p) => p.id);
          for (const id of [
            "tool/orb_spawn",
            "tool/orb_alert",
            "tool/subagent",
            "tool/steer_subagent",
            "tool/get_subagent_result",
            "tool/list_subagents",
            "tool/cancel_subagent",
          ])
            assert.equal(available.includes(id), variant.endsWith("root"), id);
          assert.equal(available.includes("tool/notify_parent"), variant.endsWith("subagent"));
          assert.ok(!ids.includes("upstream/pi/preamble"));
          if (variant.endsWith("subagent")) {
            const text = parent.map((p) => p.text).join("");
            assert.ok(
              parent.findIndex((p) => p.id === "system/child-restriction") >
                parent.findIndex((p) => p.id === "system/preamble"),
            );
            assert.equal(
              parent.find((p) => p.id === "system/child-restriction").text,
              " CHILD AFTER",
            );
            assert.ok(text.indexOf("CHILD AFTER") > text.indexOf("BODY system/preamble"));
          }
        } else if (variant.endsWith("root")) {
          const ids = parts.map((p) => p.id).filter(Boolean);
          assert.ok(ids.includes("system/claude-timezone"));
          assert.deepEqual(
            ids.filter((id) => !id.startsWith("dynamic/")),
            [
              "system/environment",
              "system/environment-claude",
              "system/network",
              "system/claude-timezone",
            ],
          );
          assert.ok(ids.indexOf("dynamic/personal") > ids.indexOf("system/environment-claude"));
          assert.ok(ids.indexOf("dynamic/project") > ids.indexOf("dynamic/personal"));
          assert.match(parts.map((p) => p.text).join(""), /User's time zone: \{\{time_zone\}\}/);
        } else {
          assert.ok(parts.some((p) => p.id === "dynamic/claude-native"));
          assert.ok(!parts.some((p) => p.id === "system/environment"));
          assert.match(parts.map((p) => p.text).join(""), /inheritance|profile/i);
        }
      }
      assert.ok(
        result.missingPolicy
          .flatMap((s) => s.parts)
          .some((p) => p.id === "codemode/policy" && p.availability === "missing"),
      );
      assert.ok(
        result.missing
          .flatMap((s) => s.parts)
          .some(
            (p) =>
              p.id === "system/environment" &&
              p.availability === "missing" &&
              /missing/i.test(p.text),
          ),
      );
    },
    { setup: templateSetup },
  );

  await scenario(
    "current source recipe keeps schemas and initial namespace guides, separate model API and skill bodies",
    async (page) => {
      const result = await page.evaluate(async (corpus) => {
        const { composeInitialContext } = await import("/app.js");
        return ["root", "subagent"].map((role) =>
          composeInitialContext(corpus, { harness: "pi", role }),
        );
      }, overlapCorpus);
      for (const sections of result) {
        const system = sections.filter((s) => s.channel === "system").flatMap((s) => s.parts);
        const offered = sections.find((s) => s.title === "functions.codemode · description").parts;
        const { createDurableTools } = await import(
          "../../apps/control-plane/src/adapters/durable/tools/index.ts"
        );
        const bundle = createDurableTools();
        assert.equal(offered.map((p) => p.text).join(""), bundle.modelTools[0].description);
        assert.ok(offered.some((p) => p.id === "codemode/policy"));
        assert.ok(offered.some((p) => p.id === "codemode/inline-images"));
        assert.equal(system.filter((p) => p.id === "system/codemode").length, 1);
        assert.equal(
          system.find((p) => p.id === "system/codemode").text,
          "Use codemode to compose tool calls.",
        );
        assert.equal(
          system.find((p) => p.id === "upstream/pi/skills-read").text,
          "Use the read tool to load a skill's file when the task matches its description.",
        );
        assert.deepEqual(
          system.filter((p) => /^skill\//.test(p.id ?? "")).map((p) => p.id),
          [
            "skill/boot-hooks/description",
            "skill/charts/description",
            "skill/cloud-identity/description",
            "skill/codemode-manual/description",
            "skill/codemode-quick-reference/description",
            "skill/hosting/description",
          ],
        );
        assert.ok(system.some((p) => p.id === "namespace/orb-description"));
        for (const id of ["namespace/mcp-instructions", "dynamic/mcp", "codemode/namespaces"])
          assert.ok(!system.some((p) => p.id === id), id);
        const catalogue = sections[0];
        assert.equal(catalogue.title, "Tool catalogue");
        assert.match(
          catalogue.parts.map((p) => p.text).join(""),
          /^<codemode>[\s\S]*<\/codemode>$/,
        );
        assert.match(
          catalogue.parts.map((p) => p.text).join(""),
          /Namespace orb:.*describeNamespace/,
        );
        assert.ok(system.some((p) => p.id === "namespace/orb-instructions"));
        assert.ok(!system.some((p) => p.id === "codemode/policy" || p.id?.endsWith("/body")));
        const fallback = sections
          .find((s) => s.title === "functions.codemode · schema")
          .parts.find((p) => p.id === "upstream/durable/codemode-code-parameter");
        assert.equal(fallback.conditional, "function fallback only");
        assert.equal(fallback.text, overlapCorpus.find((e) => e.id === fallback.id).content);
      }
      await page.goto(`${origin}/?view=template&harness=pi&role=root#token=smoke-token`);
      await expect(
        page.getByRole("heading", { name: "System content · Tool catalogue", exact: true }),
      ).toBeVisible();
      await expect(page.locator("#initial-context")).toContainText("<codemode>");
      for (const id of [
        "namespace/orb-instructions",
        "namespace/mcp-instructions",
        "namespace/mcp-description",
      ]) {
        await page.goto(`${origin}/?id=${encodeURIComponent(id)}#token=smoke-token`);
        await expect(page.locator("#prompt-delivery")).toContainText("first Pi model request");
        await expect(page.locator("#prompt-delivery")).toContainText(
          id === "namespace/orb-instructions" ? "discovery response" : "when registered",
        );
      }
      await page.goto(`${origin}/?id=codemode%2Fpolicy#token=smoke-token`);
      await expect(page.locator("#prompt-delivery")).toContainText("first model request");
      await expect(page.locator("#prompt-delivery")).toContainText("separate API field");
      await page.goto(`${origin}/?id=skill%2Fcodemode-manual%2Fbody#token=smoke-token`);
      await expect(page.locator("#prompt-delivery")).toContainText("On demand");
      await expect(editor(page)).toHaveValue(
        overlapCorpus.find((e) => e.id === "skill/codemode-manual/body").content,
      );
      assert.deepEqual(payloads, []);
    },
    {
      setup: () => {
        entries = structuredClone(overlapCorpus);
      },
    },
  );

  await scenario(
    "atomic delivery labels cover triggers, separate requests and opaque boundaries",
    async (page) => {
      const labels = await page.evaluate(async (corpus) => {
        const { promptDelivery } = await import("/app.js");
        return Object.fromEntries(
          [...corpus, { id: "future/unknown" }].map((entry) => [entry.id, promptDelivery(entry)]),
        );
      }, overlapCorpus);
      for (const entry of overlapCorpus) assert.ok(labels[entry.id], entry.id);
      for (const [id, pattern] of [
        ["system/preamble", /first Pi model request.*retained/],
        ["system/environment-pi", /Empty.*nothing/],
        ["system/environment-claude", /query launch.*SDK.*opaque/],
        ["skill/charts/description", /context build.*selected.*native/],
        ["skill/charts/body", /On demand.*read or invoked/],
        ["feedback/shell-timeout", /matching tool outcome/],
        ["lifecycle/central-sleep-wake", /matching.*event/],
        ["aux/name-system", /separate model request.*not main-agent/],
        ["tool/orb_send", /budget-selected.*discovery/],
        ["codemode/policy", /first model request.*separate API field/],
        ["skill/codemode-manual/body", /On demand.*not included/],
        ["upstream/durable/codemode-code-parameter", /function fallback.*schema/],
        ["namespace/mcp-description", /first Pi model request.*when registered/],
        ["upstream/durable/compaction-system", /compacting.*separate model request/],
        ["upstream/durable/summary-prefix", /After compaction.*retained/],
        ["repository/instructions", /if selected.*native.*opaque/],
        ["dynamic/claude-native", /SDK-owned.*unavailable/],
        ["future/unknown", /not established/],
      ])
        assert.match(labels[id], pattern, id);
      await item(page, "Main prompt").click();
      await expect(page.locator("#prompt-delivery")).toHaveText(
        "When · Delivery not established by this checkout",
      );
      await page.goto(`${origin}/?id=system%2Fenvironment-pi#token=smoke-token`);
      await expect(page.locator("#prompt-delivery")).toHaveText("When · Empty · emits nothing");
      await editor(page).fill("Draft suffix.");
      await expect(page.locator("#prompt-delivery")).toContainText("first Pi model request");
      await page.getByRole("button", { name: "Revert", exact: true }).click();
      await expect(page.locator("#prompt-delivery")).toHaveText("When · Empty · emits nothing");
    },
    {
      setup: () => {
        entries.push({
          id: "system/environment-pi",
          title: "Pi suffix",
          category: "System",
          scope: "Pi",
          content: "",
          editable: true,
          revision: "1",
        });
      },
    },
  );

  await scenario(
    "atomic skill bodies explain on-demand delivery without claiming initial inclusion",
    async (page) => {
      await page.goto(`${origin}/?id=skill%2Fcharts%2Fbody#token=smoke-token`);
      await expect(page.locator("#prompt-delivery")).toHaveText(
        "When · On demand · when the skill is read or invoked; not included by its discovery listing",
      );
      await expect(editor(page)).toHaveValue("Full skill body.");
      await page.getByRole("button", { name: "Initial context", exact: true }).click();
      await expect(page.locator(".template-payload")).not.toContainText(["Full skill body."]);
      assert.deepEqual(payloads, []);
    },
    {
      setup: () => {
        templateSetup();
        entries.push({
          id: "skill/charts/body",
          title: "Chart skill body",
          category: "Skills",
          scope: "Root and child",
          content: "Full skill body.",
          editable: true,
          revision: "1",
        });
      },
    },
  );

  await scenario(
    "only declared runtime substitutions are marked in the recipe",
    async (page) => {
      await page.getByRole("button", { name: "Initial context", exact: true }).click();
      const literal = page.locator('#template-sections [data-atom-id="system/environment"]');
      await expect(literal.locator(".template-payload")).toHaveText("Literal {{example}} stays.");
      await expect(literal.locator(".runtime-value")).toHaveCount(0);
      await expect(literal.locator(".template-annotation")).not.toContainText("substituted");
      const skill = page.locator('#template-sections [data-atom-id="skill/charts/description"]');
      await expect(skill.locator(".runtime-value")).toHaveCount(0);
      await expect(skill.locator(".template-payload")).toHaveText("Read {{example}} literally.");
      await expect(skill.locator(".template-annotation")).not.toContainText("substituted");
      await expect(page.locator(".runtime-value").first()).toHaveText("{{skill_path:boot-hooks}}");
      await page
        .locator("#initial-context")
        .getByLabel("Harness", { exact: true })
        .selectOption("claude");
      await expect(page.locator(".runtime-value")).toHaveText("{{time_zone}}");
    },
    {
      setup: () => {
        templateSetup();
        entries.find((entry) => entry.id === "system/environment").content =
          "Literal {{example}} stays.";
        entries.find((entry) => entry.id === "skill/charts/description").content =
          "Read {{example}} literally.";
      },
    },
  );

  await scenario(
    "source preview Escape restores focus and stays closed after animation frames",
    async (page) => {
      await page.getByRole("button", { name: "Initial context", exact: true }).click();
      const source = page.locator('#template-sections [data-atom-id="system/environment"] a');
      const preview = page.locator("#overlap-preview");
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await page.getByRole("button", { name: "Initial context", exact: true }).focus();
        await source.focus();
        await expect(preview).toBeVisible();
        await source.press("Tab");
        await expect(preview).toBeFocused();
        await page.keyboard.press("Shift+Tab");
        await expect(source).toBeFocused();
        await expect(preview).toBeVisible();
        await source.press("Tab");
        await expect(preview).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(source).toBeFocused();
        // Observe queued focus work after it can run, not just the synchronous hide.
        const afterFrames = await page.evaluate(async () => {
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
          const source = document.querySelector(
            '#template-sections [data-atom-id="system/environment"] a',
          );
          return {
            hidden: document.querySelector("#overlap-preview").hidden,
            focused: document.activeElement === source,
            expanded: source.getAttribute("aria-expanded"),
          };
        });
        assert.deepEqual(afterFrames, { hidden: true, focused: true, expanded: "false" });
      }
    },
    { setup: templateSetup },
  );

  for (const width of [1280, 390]) {
    await scenario(
      `context separates request recipe from review notes at ${width}px`,
      async (page) => {
        await page.getByRole("button", { name: "Initial context", exact: true }).click();
        const template = page.locator("#initial-context");
        await expect(template.locator(".template-columns strong")).toHaveText([
          "Request content · source recipe",
          "Review notes · not sent",
        ]);
        await expect(page.locator("#template-timing")).toContainText("not a request capture");
        await expect(
          template.locator('[data-channel="system"] .template-delivery').first(),
        ).toHaveText("From first model request · retained while unchanged; changes append updates");
        const body = template.locator('[data-atom-id="system/preamble"]');
        await expect(body.locator(".template-payload")).toHaveText("BODY system/preamble");
        const payload = body.locator(".template-payload");
        await expect(payload).toHaveCSS("border-left-style", "solid");
        await expect(payload.locator("a, .template-condition, .template-annotation")).toHaveCount(
          0,
        );
        const sourceLink = body.locator(".template-annotation a");
        await sourceLink.focus();
        await expect(page.locator("#overlap-preview-text")).toHaveText("BODY system/preamble");
        await expect(page.locator("#overlap-preview")).toBeVisible();
        await template.locator('[data-atom-id="system/environment"] a').dispatchEvent("mouseenter");
        await expect(sourceLink).toBeFocused();
        await sourceLink.press("Tab");
        await expect(page.locator("#overlap-preview")).toBeFocused();
        await expect(page.locator("#overlap-preview-text")).toHaveText("BODY system/preamble");
        await page.keyboard.press("Tab");
        const nextLink = template.locator('a[data-prompt-id="dynamic/personal"]');
        await expect(nextLink).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(page.locator("#overlap-preview")).toBeHidden();
        await sourceLink.hover();
        await expect(page.locator("#overlap-preview")).toBeVisible();
        await page.keyboard.press("Escape");
        const empty = template.locator('[data-atom-id="system/environment-pi"]');
        await expect(empty.locator(".template-payload")).toHaveCount(0);
        await expect(empty.locator(".template-annotation")).toContainText("Empty · emits nothing");
        await expect(
          template.locator(".runtime .template-payload, .missing .template-payload"),
        ).toHaveCount(0);
        await expect(template.locator(".template-payload")).not.toContainText([
          "Initial task / user input not selected",
        ]);
        const inventory = template.locator('[data-channel="availability"]');
        await expect(inventory).toContainText("not a request section");
        await expect(inventory.locator(".template-payload")).toHaveCount(0);
        await expect(inventory.locator('[data-atom-id="tool/orb_self"] pre')).toHaveText(
          "BODY tool/orb_self",
        );
        const tool = template.locator('[data-channel="tools"]').first();
        await expect(tool.locator("h2")).toContainText("separate from system");
        await expect(tool.locator(".template-delivery")).toHaveText(
          "From first model request · separate API field; current definition",
        );
        await expect(inventory.locator(".template-delivery")).toHaveText(
          "Inline if budget-selected; otherwise on discovery",
        );
        await expect(template.locator('[data-channel="input"] .template-delivery')).toHaveText(
          "When input arrives · not selected here",
        );
        await expect(template.locator(".template-annotation")).toContainText([
          "Header may include a budget suffix",
        ]);
        await page
          .locator("#initial-context")
          .getByLabel("Harness", { exact: true })
          .selectOption("claude");
        const conditional = template.locator('[data-atom-id="system/network"]');
        await expect(conditional.locator(".template-annotation")).toContainText(
          "Conditional at context build · when preview host configured",
        );
        await expect(conditional.locator(".template-payload")).toHaveCSS(
          "border-left-style",
          "dashed",
        );
        const timezone = template.locator('[data-atom-id="system/claude-timezone"]');
        await expect(timezone.locator(".runtime-value")).toHaveText("{{time_zone}}");
        await expect(timezone.locator(".template-annotation")).toContainText(
          "Runtime values substituted before sending",
        );
        await expect(timezone.locator(".template-payload")).toHaveText(
          "User's time zone: {{time_zone}}.",
        );
        await expect(template.locator('[data-channel="system"] .template-delivery')).toHaveText(
          "At root query launch · supplied to SDK; native request layout unknown",
        );
        await page
          .locator("#initial-context")
          .getByLabel("Conversation", { exact: true })
          .selectOption("subagent");
        await expect(template.locator('[data-channel="native"] .template-delivery')).toHaveText(
          "SDK-owned context · delivery timing and content unavailable",
        );
        await expect(template.locator(".template-payload")).toHaveCount(0);
        await expect(template).toContainText("inheritance");
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        assert.deepEqual(payloads, [], "context review must not save prompts");
      },
      { width, setup: templateSetup },
    );
  }

  for (const width of [1280, 390]) {
    await scenario(
      `template navigation preserves atomic state at ${width}px`,
      async (page) => {
        await page.getByRole("button", { name: "Initial context", exact: true }).click();
        const template = page.locator("#initial-context");
        await expect(template).toContainText("Checkout template");
        await expect(template.locator('[data-atom-id="system/preamble"] pre')).toHaveText(
          "BODY system/preamble",
        );
        await page
          .locator("#initial-context")
          .getByLabel("Harness", { exact: true })
          .selectOption("claude");
        await expect(template).toContainText("claude_code");
        await page
          .locator("#initial-context")
          .getByLabel("Conversation", { exact: true })
          .selectOption("subagent");
        await expect(template).toContainText("profile");
        await expect(template.locator('[data-atom-id="system/environment"]')).toHaveCount(0);
        await page
          .locator("#initial-context")
          .getByLabel("Harness", { exact: true })
          .selectOption("pi");
        await expect(template).toContainText("CHILD AFTER");
        await expect(template.locator('[data-atom-id="system/child-restriction"] pre')).toHaveText(
          " CHILD AFTER",
        );
        await expect(template.locator('[data-atom-id="system/child-restriction"] a')).toBeVisible();
        await template.locator('[data-atom-id="system/preamble"] a').click();
        await expect(template).toBeHidden();
        assert.match(page.url(), /#token=smoke-token$/);
        await editor(page).fill("draft <img src=x onerror=alert(1)>\nsecond line");
        await editor(page).press("Home");
        await editor(page).press("ArrowUp");
        assert.ok(page.url().includes("system%2Fpreamble"));
        await page.getByRole("button", { name: "Diff", exact: true }).click();
        validationFailure = true;
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect(page.getByRole("alert")).toContainText("Keep the prompt variables unchanged");
        await page.getByRole("button", { name: "Initial context", exact: true }).click();
        assert.equal(
          await page
            .locator("#initial-context")
            .getByLabel("Conversation", { exact: true })
            .inputValue(),
          "subagent",
        );
        await expect(template.locator('[data-atom-id="system/preamble"] pre')).toContainText(
          "draft <img",
        );
        await expect(template.locator("img")).toHaveCount(0);
        await template.locator('[data-atom-id="system/preamble"] a').click();
        await expect(page.getByRole("textbox", { name: "After", exact: true })).toHaveValue(
          /draft <img/,
        );
        await expect(page.getByRole("alert")).toContainText("Keep the prompt variables unchanged");
        await page.goBack();
        await expect(template).toBeVisible();
        await template.locator('[data-atom-id="upstream/pi/skills-read"] a').click();
        assert.equal(await editor(page).getAttribute("readonly"), "");
        await page.getByRole("button", { name: "Initial context", exact: true }).click();
        await page
          .locator("#initial-context")
          .getByLabel("Conversation", { exact: true })
          .selectOption("root");
        await expect(template).not.toContainText("CHILD AFTER");
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
      },
      { width, setup: templateSetup },
    );
  }

  await scenario(
    "unsupported template URLs preserve resources through dashboard and history",
    async (page) => {
      for (const query of [
        "view=BOGUS",
        "view=template&harness=BOGUS",
        "view=template&role=BOGUS",
        "view=template&harness=BOGUS&role=BOGUS",
      ]) {
        const path = `/?${query}#token=smoke-token`;
        await page.goto(origin + path);
        await expect(page.locator("#catalog-status")).toContainText(
          /Initial context template.*doesn't exist/,
        );
        assert.equal(page.url(), origin + path);
        await expect(page.locator("#workspace")).toBeHidden();
        await expect(page.locator("#initial-context")).toBeHidden();
        await page.getByRole("link", { name: "Dashboard", exact: true }).click();
        await expect(page.locator("#workspace")).toBeVisible();
        assert.equal(page.url(), `${origin}/#token=smoke-token`);
        await page.goBack();
        await expect(page.locator("#catalog-status")).toContainText(
          /Initial context template.*doesn't exist/,
        );
        assert.equal(page.url(), origin + path);
        await page.goForward();
        await expect(page.locator("#workspace")).toBeVisible();
        await expect(page.locator("#catalog-status")).toBeHidden();
      }
      await page.goto(`${origin}/?view=template#token=smoke-token`);
      await expect(page.locator("#initial-context")).toBeVisible();
      assert.equal(
        await page.locator("#initial-context").getByLabel("Harness", { exact: true }).inputValue(),
        "pi",
      );
      assert.equal(
        await page
          .locator("#initial-context")
          .getByLabel("Conversation", { exact: true })
          .inputValue(),
        "root",
      );
    },
    { setup: templateSetup },
  );

  const redundancySetup = () => {
    entries = redundancyCorpus.map((entry) => ({
      ...entry,
      title: entry.id,
      category: "Audit",
      scope: "Audited context",
      editable: true,
      revision: "1",
    }));
  };
  const inventory = (page) => page.getByRole("navigation", { name: "Prompt inventory" });
  const covered = (page) => page.getByRole("navigation", { name: "Covering prompts" });
  const auditLink = (page, id) => inventory(page).locator(`a[href*="${encodeURIComponent(id)}"]`);

  await scenario(
    "initial routing and policy source links have no whole-entry coverage",
    async (page) => {
      await page.getByRole("button", { name: "Initial context", exact: true }).click();
      for (const id of ["system/codemode", "codemode/policy"]) {
        const link = page.locator(`#initial-context [data-atom-id="${id}"] a`);
        await expect(link).not.toHaveClass(/redundant/);
        await expect(link).not.toHaveAccessibleName(/Redundant/);
      }
      await expect(
        page.locator('#initial-context [data-atom-id="skill/codemode-manual/body"]'),
      ).toHaveCount(0);
      await page.locator('#initial-context [data-atom-id="codemode/policy"] a').click();
      await editor(page).fill("Unique policy draft.");
      await page.getByRole("button", { name: "Initial context", exact: true }).click();
      const link = page.locator('#initial-context [data-atom-id="codemode/policy"] a');
      await link.focus();
      await expect(page.locator("#overlap-preview-text")).toHaveText("Unique policy draft.");
      await expect(link).not.toHaveClass(/redundant/);
    },
    { setup: redundancySetup },
  );

  await scenario(
    "no complete-redundancy rule covers current atoms or unknown copies",
    async (page) => {
      await expect(item(page, "Main prompt")).toBeVisible();
      const result = await page.evaluate(async (corpus) => {
        const { findPromptRedundancies, promptContentFingerprint } = await import("/app.js");
        return {
          current: findPromptRedundancies(corpus),
          normalized: findPromptRedundancies(
            corpus.map((e) => ({ ...e, content: ` \n${e.content}\n` })),
          ),
          copies: findPromptRedundancies([
            { id: "unknown-a", content: "A previously unaudited instruction, copied verbatim." },
            { id: "unknown-b", content: "A previously unaudited instruction, copied verbatim." },
          ]),
          fingerprints: [
            "",
            "a",
            "é",
            "e\u0301",
            "😀",
            "\ud800",
            "\ud801",
            "a\0",
            "\u0100",
            "\0a",
            " \n a \t",
          ].map(promptContentFingerprint),
        };
      }, overlapCorpus);
      assert.deepEqual(result.current, []);
      assert.deepEqual(result.normalized, []);
      assert.deepEqual(result.copies, []);
      assert.deepEqual(result.fingerprints, [
        "0:6c62272e07bb014262b821756295c58d",
        "1:0880954519ab1be95aa0733055b70e0c",
        "1:088093f669ab1be95aa0733054e924c4",
        "2:695359d9cd757277b806e96dc9454350",
        "2:67b0c33470757277b806e8ece3e53552",
        "1:0880945b77ab1be95aa073305527697d",
        "1:0880945931ab1be95aa07330552620f4",
        "2:697128ab8a757277b806e976f4a3892c",
        "1:0880945b4eab1be95aa073305527370a",
        "2:66ad382ae0757277b806e89d2e4ef984",
        "1:0880954519ab1be95aa0733055b70e0c",
      ]);
    },
  );

  await scenario(
    "empty redundant filter composes with search and arrows without losing drafts",
    async (page) => {
      await auditLink(page, "codemode/policy").click();
      const draft = "Policy draft survives empty filters.";
      await editor(page).fill(draft);
      const toggle = page.getByRole("button", { name: "Redundant", exact: true });
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-pressed", "true");
      await expect(inventory(page).getByRole("link")).toHaveCount(0);
      await page.keyboard.press("ArrowDown");
      await expect(editor(page)).toHaveValue(draft);
      await page.getByRole("searchbox").fill("codemode");
      await expect(inventory(page).getByRole("link")).toHaveCount(0);
      await page.keyboard.press("ArrowUp");
      await expect(editor(page)).toHaveValue(draft);
      await page.getByRole("searchbox").fill("");
      await toggle.click();
      await expect(inventory(page).getByRole("link")).toHaveCount(redundancyCorpus.length);
      await expect(auditLink(page, "codemode/policy")).not.toHaveClass(/redundant/);
      await expect(covered(page)).toBeHidden();
    },
    { setup: redundancySetup },
  );

  await scenario(
    "optional skill body cannot mark initial routing or policy redundant",
    async (page) => {
      const targetId = "system/codemode";
      const bodyId = "skill/codemode-manual/body";
      await auditLink(page, targetId).click();
      const routing = await editor(page).inputValue();
      await auditLink(page, bodyId).click();
      await editor(page).fill(routing);
      await expect(page.locator("#prompt-delivery")).toContainText("On demand");
      await expect(auditLink(page, targetId)).not.toHaveClass(/redundant/);
      await auditLink(page, targetId).click();
      await expect(editor(page)).toHaveValue(routing);
      await expect(covered(page)).toBeHidden();
      await auditLink(page, bodyId).click();
      await page.getByRole("button", { name: "Revert", exact: true }).click();
      await expect(editor(page)).toHaveValue(redundancyCorpus.find((e) => e.id === bodyId).content);
      await expect(inventory(page).locator(".redundant")).toHaveCount(0);
    },
    { setup: redundancySetup },
  );

  await scenario(
    "policy save/reload preserves delivery and empty coverage without storage",
    async (page) => {
      const targetId = "codemode/policy";
      await auditLink(page, targetId).click();
      await editor(page).fill("Policy save draft.");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByRole("status")).toHaveText("Saved");
      await expect(auditLink(page, targetId)).not.toHaveClass(/redundant/);
      entries.find((e) => e.id === targetId).content = redundancyCorpus.find(
        (e) => e.id === targetId,
      ).content;
      await page.getByRole("button", { name: "Reload latest", exact: true }).click();
      await expect(editor(page)).toHaveValue(
        redundancyCorpus.find((e) => e.id === targetId).content,
      );
      await expect(page.locator("#prompt-delivery")).toContainText("separate API field");
      await expect(covered(page)).toBeHidden();
      assert.deepEqual(
        await page.evaluate(() => [localStorage.length, sessionStorage.length]),
        [0, 0],
      );
    },
    { setup: redundancySetup },
  );

  await scenario(
    "pure content matcher: grounded claims, symmetry, negatives and invalidation",
    async (page) => {
      await expect(item(page, "Main prompt")).toBeVisible();
      const result = await page.evaluate(async (corpus) => {
        const { findPromptOverlaps } = await import("/app.js");
        const links = Object.fromEntries(
          corpus.map(({ id }) => [id, findPromptOverlaps(corpus, id)]),
        );
        const renamed = [
          { id: "unrelated-0", content: "Orbs do not share workspaces." },
          { id: "unrelated-1", content: "Orbs do not share file systems." },
        ];
        const moved = findPromptOverlaps(renamed, "unrelated-0");
        renamed[0].content = "Talk about the weather.";
        const removed = findPromptOverlaps(renamed, "unrelated-0");
        const chain = [
          { id: "a", content: "Orbs do not share workspaces." },
          { id: "b", content: "Orbs do not share workspaces. Images are returned inline." },
          { id: "c", content: "Images are returned inline." },
        ];
        return { links, moved, removed, chain: findPromptOverlaps(chain, "a") };
      }, overlapCorpus);
      const positive = auditedPairs.positive;
      for (const [left, right] of positive)
        assert.ok(result.links[left].includes(right), `${left} → ${right}`);
      for (const [id, targets] of Object.entries(result.links)) {
        assert.ok(!targets.includes(id));
        assert.equal(new Set(targets).size, targets.length);
        assert.deepEqual(
          targets,
          overlapCorpus.filter((entry) => targets.includes(entry.id)).map((entry) => entry.id),
        );
        for (const target of targets)
          assert.ok(result.links[target].includes(id), `${target} → ${id}`);
      }
      for (const [left, right] of auditedPairs.negative)
        assert.ok(!result.links[left].includes(right), `${left} ≠ ${right}`);
      for (const id of ["dynamic/personal", "dynamic/project", "system/environment-pi"])
        assert.deepEqual(result.links[id], []);
      assert.deepEqual(result.moved, ["unrelated-1"]);
      assert.deepEqual(result.removed, []);
      assert.deepEqual(result.chain, ["b"]);
    },
  );

  await scenario(
    "matcher excludes unavailable content, placeholders and generic boilerplate; precise opposites overlap",
    async (page) => {
      await expect(item(page, "Main prompt")).toBeVisible();
      const result = await page.evaluate(async () => {
        const { findPromptOverlaps, promptOverlapFacts } = await import("/app.js");
        const entries = [
          { id: "alpha", content: "Orbs do not share workspaces." },
          { id: "beta", content: "Orbs do share file systems." },
          { id: "dynamic/personal", content: "Orbs do not share workspaces." },
          { id: "dynamic/project", content: "Orbs do not share workspaces." },
          {
            id: "generic-a",
            content: "Operation failed. Try again. Omit to use the agent's own default.",
          },
          {
            id: "generic-b",
            content: "Operation failed. Try again. Omit to use the agent's own default.",
          },
          { id: "slots-a", content: "{{context}} {{text}} <summary> {{prompt}} </summary>" },
          { id: "slots-b", content: "{{context}} {{text}} <summary> {{prompt}} </summary>" },
          { id: "slots-claim", content: "{{Orbs do not share workspaces.}}" },
          {
            id: "heading-a",
            content: "# Code-mode agent manual\n## Limits (central native code-mode)",
          },
          {
            id: "heading-b",
            content: "# Code-mode agent manual\n## Limits (central native code-mode)",
          },
          {
            id: "topic",
            content: "Discuss orbs and workspaces with the user. Files and tools provide context.",
          },
        ];
        return {
          graph: Object.fromEntries(entries.map(({ id }) => [id, findPromptOverlaps(entries, id)])),
          facts: promptOverlapFacts(entries[0].content),
        };
      });
      assert.deepEqual(result.graph.alpha, ["beta"]);
      assert.deepEqual(result.graph.beta, ["alpha"]);
      for (const id of [
        "dynamic/personal",
        "dynamic/project",
        "generic-a",
        "generic-b",
        "slots-a",
        "slots-b",
        "slots-claim",
        "heading-a",
        "heading-b",
        "topic",
      ])
        assert.deepEqual(result.graph[id], [], id);
      assert.ok(result.facts.includes("orb-workspace-isolation"));
    },
  );

  const sharedClaim = "Orbs do not share workspaces.";
  const overlapSetup = () => {
    entries[0].content = sharedClaim;
    entries[1].content =
      "Orbs do not share file systems!\n<script>window.previewExecuted = true</script>\n" +
      Array.from({ length: 180 }, (_, index) => `Literal target line ${index}`).join("\n") +
      "\nEND OF TARGET";
  };
  const overlapLink = (page, name = "orb_send") =>
    page.locator("#overlap-links").getByRole("link", { name, exact: true });

  for (const width of [1280, 390]) {
    await scenario(
      `overlap preview hover, focus, literal full text and scrolling at ${width}px`,
      async (page) => {
        await item(page, "Main prompt").click();
        const link = overlapLink(page);
        await expect(link).toHaveAttribute("href", "/?id=tools#token=smoke-token");
        const preview = page.locator("#overlap-preview");
        await link.hover();
        await expect(preview).toBeVisible();
        await expect(page.locator("#overlap-preview-text")).toHaveText(entries[1].content);
        assert.equal(await page.evaluate(() => window.previewExecuted), undefined);
        const box = await preview.boundingBox();
        assert.ok(
          box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= 900,
        );
        const triggerBox = await link.boundingBox();
        await page.evaluate(() => {
          window.previewClosedDuringCrossing = false;
          window.crossingObserver = new MutationObserver(() => {
            if (document.querySelector("#overlap-preview").hidden)
              window.previewClosedDuringCrossing = true;
          });
          window.crossingObserver.observe(document.querySelector("#overlap-preview"), {
            attributes: true,
            attributeFilter: ["hidden"],
          });
        });
        await page.mouse.move(
          triggerBox.x + triggerBox.width / 2,
          box.y < triggerBox.y ? box.y + box.height - 8 : box.y + 8,
          { steps: 12 },
        );
        assert.equal(
          await page.evaluate(() => {
            window.crossingObserver.disconnect();
            return window.previewClosedDuringCrossing;
          }),
          false,
        );
        await expect(preview).toBeVisible();
        await preview.focus();
        await observeKeys(page);
        await pressArrow(page, "ArrowDown", false);
        await expect(page.locator("#prompt-title")).toHaveText("Main prompt");
        await page.keyboard.press("Control+End");
        await expect
          .poll(() => preview.evaluate((element) => element.scrollTop))
          .toBeGreaterThan(0);
        await expect(page.getByText("END OF TARGET", { exact: false })).toBeInViewport();
        await page.keyboard.press("Escape");
        await expect(preview).toBeHidden();
        await expect(link).toBeFocused();
        await page.getByRole("button", { name: "Diff", exact: true }).focus();
        await link.focus();
        await expect(preview).toBeVisible();
        await page.getByRole("button", { name: "Diff", exact: true }).focus();
        await page.mouse.move(0, 0);
        await expect(preview).toBeHidden();
        await link.focus();
        await expect(preview).toBeVisible();
        await page.keyboard.press("Tab");
        await expect(preview).toBeFocused();
        await expect(preview).toBeVisible();
        const modifiedTab = await preview.evaluate((element) =>
          ["ctrlKey", "metaKey", "altKey"].map((key) => {
            const event = new KeyboardEvent("keydown", {
              key: "Tab",
              [key]: true,
              bubbles: true,
              cancelable: true,
            });
            element.dispatchEvent(event);
            return event.defaultPrevented;
          }),
        );
        assert.deepEqual(modifiedTab, [false, false, false]);
        await expect(preview).toBeFocused();
        await page.keyboard.press("Shift+Tab");
        await expect(link).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(preview).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(page.getByRole("button", { name: "Diff", exact: true })).toBeFocused();
        await link.focus();
        await page.keyboard.press("Tab");
        await page.keyboard.press("Escape");
        await expect(link).toBeFocused();
        await expect(preview).toBeHidden();
      },
      { width, setup: overlapSetup },
    );
  }

  await scenario(
    "overlap navigation retains drafts, errors, review and modified link clicks",
    async (page) => {
      await item(page, "Main prompt").click();
      await editor(page).fill(`${sharedClaim}\nLocal draft`);
      validationFailure = true;
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByRole("alert")).toBeVisible();
      await page.getByRole("button", { name: "Diff", exact: true }).click();
      const preview = page.locator("#overlap-preview");
      await overlapLink(page).focus();
      await expect(preview).toBeVisible();
      await overlapLink(page).click();
      await expect(preview).toBeHidden();
      await expect(page.locator("#prompt-title")).toHaveText("orb_send");
      await page
        .getByRole("textbox", { name: "After", exact: true })
        .fill(`${sharedClaim}\nOther draft`);
      await overlapLink(page, "Main prompt").click();
      await expect(page.getByRole("textbox", { name: "After", exact: true })).toHaveValue(
        `${sharedClaim}\nLocal draft`,
      );
      await expect(page.getByRole("alert")).toHaveText("Keep the prompt variables unchanged.");
      assert.equal(new URL(page.url()).hash, "#token=smoke-token");
      const modified = await overlapLink(page).evaluate((link) => {
        const event = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true });
        link.dispatchEvent(event);
        return event.defaultPrevented;
      });
      assert.equal(modified, false);
      await expect(page.locator("#prompt-title")).toHaveText("Main prompt");
      await page.goBack();
      await expect(page.getByRole("textbox", { name: "After", exact: true })).toHaveValue(
        `${sharedClaim}\nOther draft`,
      );
    },
    { setup: overlapSetup },
  );

  await scenario(
    "short preview near viewport bottom touches its trigger",
    async (page) => {
      await item(page, "Main prompt").click();
      const link = overlapLink(page);
      await link.evaluate((element) => {
        Object.assign(element.style, { position: "fixed", bottom: "100px", left: "320px" });
      });
      await link.hover();
      const preview = page.locator("#overlap-preview");
      await expect(preview).toBeVisible();
      const triggerBox = await link.boundingBox();
      const box = await preview.boundingBox();
      assert.ok(
        Math.abs(box.y + box.height - triggerBox.y) < 1 ||
          Math.abs(box.y - triggerBox.y - triggerBox.height) < 1,
        "no gap beside short preview",
      );
      await page.mouse.move(
        triggerBox.x + triggerBox.width / 2,
        box.y < triggerBox.y ? box.y + box.height - 8 : box.y + 8,
        { steps: 12 },
      );
      await expect(preview).toBeVisible();
    },
    {
      setup: () => {
        overlapSetup();
        entries[1].content = sharedClaim;
      },
    },
  );

  await scenario(
    "ambiguous overlap titles include scope; outside scroll closes preview",
    async (page) => {
      await item(page, "Main prompt").click();
      await expect(overlapLink(page, "User time zone · Root and child")).toBeVisible();
      await expect(overlapLink(page, "User time zone · Child")).toBeVisible();
      await overlapLink(page, "User time zone · Child").focus();
      await expect(page.locator("#overlap-preview")).toBeVisible();
      await expect(page.locator("#overlap-preview-title")).toHaveText("User time zone · Child");
      await page.locator("#inventory").dispatchEvent("scroll");
      await expect(page.locator("#overlap-preview")).toBeHidden();
      await overlapLink(page, "User time zone · Root and child").focus();
      await page.keyboard.press("Tab");
      await expect(page.locator("#overlap-preview")).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(overlapLink(page, "User time zone · Child")).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(page.locator("#overlap-preview")).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(page.getByRole("button", { name: "Diff", exact: true })).toBeFocused();
    },
    {
      setup: () => {
        overlapSetup();
        entries[1].title = "User time zone";
        entries[3].title = "User time zone";
        entries[3].content = sharedClaim;
      },
    },
  );

  await scenario(
    "overlaps update from drafts, revert, reload and save",
    async (page) => {
      await item(page, "Main prompt").click();
      await expect(overlapLink(page)).toBeVisible();
      await editor(page).fill("Unrelated draft");
      await expect(page.locator("#overlaps")).toBeHidden();
      await page.getByRole("button", { name: "Revert", exact: true }).click();
      await expect(overlapLink(page)).toBeVisible();
      await item(page, "orb_send").click();
      await editor(page).fill("No shared information");
      await item(page, "Main prompt").click();
      await expect(page.locator("#overlaps")).toBeHidden();
      await item(page, "orb_send").click();
      await page.getByRole("button", { name: "Revert", exact: true }).click();
      await expect(overlapLink(page, "Main prompt")).toBeVisible();
      entries[1].content = "Reloaded unrelated information";
      entries[1].revision = "2";
      await page.getByRole("button", { name: "Reload latest", exact: true }).click();
      await expect(editor(page)).toHaveValue(entries[1].content);
      await expect(page.locator("#overlaps")).toBeHidden();
      await editor(page).fill(sharedClaim);
      await expect(overlapLink(page, "Main prompt")).toBeVisible();
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByRole("status")).toHaveText("Saved");
      await expect(overlapLink(page, "Main prompt")).toBeVisible();
      await editor(page).fill("Saved unrelated information");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByRole("status")).toHaveText("Saved");
      await expect(page.locator("#overlaps")).toBeHidden();
    },
    { setup: overlapSetup },
  );

  await scenario("inventory, literal content, search, scopes and read-only", async (page) => {
    await expect(item(page, "Main prompt")).toHaveAttribute("href", "/?id=main#token=smoke-token");
    await item(page, "Main prompt").click();
    await expect(editor(page)).toHaveValue(literal);
    await expect(page.locator("script")).toHaveCount(1);
    assert.equal(new URL(page.url()).hash, "#token=smoke-token");
    await expect(page).toHaveTitle("Prompts");
    await expect(page.getByRole("heading", { name: "Prompts", exact: true })).toBeVisible();
    await expect(page.locator("#prompt-title")).toHaveText("Main prompt");
    await expect(
      page.getByText("Changes stay in this checkout. Nothing is deployed.", { exact: true }),
    ).toBeVisible();
    await expect(page.locator("body")).not.toContainText(
      /import .* from|SOURCE_SENTINEL|src\/main\.ts/,
    );
    await expect(item(page, "orb_send")).toContainText("Root and child");
    await expect(item(page, "orb_alert")).toContainText("Child");
    await expect(item(page, "boot-hooks")).toBeVisible();
    await page.getByRole("searchbox").fill("boot-hooks");
    await item(page, "boot-hooks").click();
    await expect(editor(page)).toHaveValue("Configure the environment before the agent starts.");
    await page.getByRole("searchbox").fill("package");
    await expect(item(page, "Provider defaults")).toBeVisible();
    await expect(item(page, "Main prompt")).toHaveCount(0);
    await item(page, "Provider defaults").click();
    await expect(editor(page)).toHaveAttribute("readonly", "");
    await expect(page.getByText("Read-only", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await page.getByRole("searchbox").fill("nothing-matches");
    await expect(page.getByText("No matching prompts.")).toBeVisible();
    await page.getByRole("searchbox").fill("");
    await expect(item(page, "orb_send")).toBeVisible();
  });

  async function observeKeys(page) {
    await page.evaluate(() => {
      window.keyEvents = [];
      window.addEventListener("keydown", (event) => {
        window.keyEvents.push({ key: event.key, consumed: event.defaultPrevented });
      });
    });
  }

  async function pressArrow(page, key, consumed) {
    await page.keyboard.press(key);
    const events = await page.evaluate(() => window.keyEvents);
    assert.equal(events.at(-1).consumed, consumed);
  }

  await scenario(
    "arrow navigation follows visible order, keeps focus and stops at bounds",
    async (page) => {
      await expect(item(page, "Main prompt")).toBeVisible();
      await observeKeys(page);
      await pressArrow(page, "ArrowDown", true);
      await expect(item(page, "Main prompt")).toHaveAttribute("aria-current", "page");
      await expect(item(page, "Main prompt")).toBeFocused();
      await expect(editor(page)).toHaveValue(literal);
      assert.equal(new URL(page.url()).search, "?id=main");
      await pressArrow(page, "ArrowUp", false);
      await pressArrow(page, "ArrowDown", true);
      await expect(item(page, "orb_send")).toBeFocused();
      await expect(editor(page)).toHaveValue(initial()[1].content);
      await pressArrow(page, "ArrowDown", true);
      await expect(item(page, "orb_alert")).toBeFocused();
      await pressArrow(page, "ArrowDown", true);
      await expect(editor(page)).toHaveAttribute("readonly", "");
      await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
      await pressArrow(page, "ArrowDown", true);
      await expect(item(page, "boot-hooks")).toBeFocused();
      await pressArrow(page, "ArrowDown", false);
      await pressArrow(page, "ArrowUp", true);
      await expect(item(page, "Provider defaults")).toHaveAttribute("aria-current", "page");
      assert.equal(new URL(page.url()).hash, "#token=smoke-token");
      assert.deepEqual(payloads, []);
    },
  );

  await scenario("search arrows select only matches and retain search focus", async (page) => {
    const search = page.getByRole("searchbox");
    await expect(item(page, "Main prompt")).toBeVisible();
    await observeKeys(page);
    await search.focus();
    await pressArrow(page, "ArrowUp", true);
    await expect(item(page, "boot-hooks")).toHaveAttribute("aria-current", "page");
    await expect(search).toBeFocused();
    await search.fill("Tools");
    await pressArrow(page, "ArrowDown", true);
    await expect(item(page, "orb_send")).toHaveAttribute("aria-current", "page");
    await expect(search).toBeFocused();
    await pressArrow(page, "ArrowUp", false);
    await pressArrow(page, "ArrowDown", true);
    await expect(item(page, "orb_alert")).toHaveAttribute("aria-current", "page");
    await expect(editor(page)).toHaveValue(initial()[3].content);
    await pressArrow(page, "ArrowDown", false);
    await search.fill("nothing-matches");
    await pressArrow(page, "ArrowUp", false);
    await pressArrow(page, "ArrowDown", false);
    await expect(editor(page)).toHaveValue(initial()[3].content);
    await search.fill("package");
    await pressArrow(page, "ArrowUp", true);
    await expect(item(page, "Provider defaults")).toHaveAttribute("aria-current", "page");
    await expect(editor(page)).toHaveAttribute("readonly", "");
  });

  await scenario("arrows retain drafts, validation errors and review state", async (page) => {
    await item(page, "Main prompt").click();
    await editor(page).fill("Draft without protected variable");
    validationFailure = true;
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText("Keep the prompt variables unchanged.");
    await page.getByRole("button", { name: "Diff", exact: true }).click();
    await item(page, "Main prompt").focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.locator("#prompt-title")).toHaveText("orb_send");
    await page.getByRole("textbox", { name: "After", exact: true }).fill("Other draft");
    await item(page, "orb_send").focus();
    await page.keyboard.press("ArrowUp");
    await expect(page.getByRole("textbox", { name: "After", exact: true })).toHaveValue(
      "Draft without protected variable",
    );
    await expect(page.getByRole("textbox", { name: "Before", exact: true })).toHaveValue(literal);
    await expect(page.getByRole("alert")).toHaveText("Keep the prompt variables unchanged.");
    await expect(page.getByRole("status")).toHaveText("Unsaved changes");
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("textbox", { name: "After", exact: true })).toHaveValue(
      "Other draft",
    );
    assert.equal(payloads.length, 1);
  });

  await scenario("textarea caret keys and modified arrows are not navigation", async (page) => {
    await item(page, "Main prompt").click();
    await editor(page).fill("First line\nSecond line\nThird line");
    await observeKeys(page);
    await page.keyboard.press("Control+Home");
    await pressArrow(page, "ArrowDown", false);
    assert.equal(await editor(page).evaluate((element) => element.selectionStart), 11);
    await pressArrow(page, "ArrowUp", false);
    assert.equal(await editor(page).evaluate((element) => element.selectionStart), 0);
    await page.getByRole("button", { name: "Diff", exact: true }).click();
    await page.getByRole("textbox", { name: "Before", exact: true }).focus();
    await pressArrow(page, "ArrowDown", false);
    await pressArrow(page, "ArrowUp", false);
    await page.getByRole("searchbox").focus();
    for (const modifier of ["Control", "Meta", "Alt", "Shift"]) {
      await pressArrow(page, `${modifier}+ArrowDown`, false);
      await pressArrow(page, `${modifier}+ArrowUp`, false);
    }
    await expect(item(page, "Main prompt")).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("textbox", { name: "After", exact: true })).toHaveValue(
      "First line\nSecond line\nThird line",
    );
  });

  await scenario(
    "server-only provenance is neither displayed nor searched",
    async (page) => {
      await item(page, "Main prompt").click();
      await expect(page.locator("body")).not.toContainText("SOURCE_SENTINEL");
      await page.getByRole("searchbox").fill("SOURCE_SENTINEL");
      await expect(page.getByText("No matching prompts.")).toBeVisible();
    },
    {
      setup: () => {
        entries[0].path = "SOURCE_SENTINEL/private.ts";
      },
    },
  );

  await scenario("variable validation retains the prompt draft", async (page) => {
    await item(page, "Main prompt").click();
    await editor(page).fill("Changed prompt without its variable");
    validationFailure = true;
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText("Keep the prompt variables unchanged.");
    await expect(editor(page)).toHaveValue("Changed prompt without its variable");
    assert.deepEqual(payloads, [{ content: "Changed prompt without its variable", revision: "1" }]);
  });

  await scenario("drafts survive switching, revert and explicit save", async (page) => {
    await item(page, "Main prompt").click();
    await editor(page).fill("Draft");
    await expect(page.getByText("Unsaved changes", { exact: true })).toBeVisible();
    await item(page, "orb_send").click();
    await item(page, "Main prompt").click();
    await expect(editor(page)).toHaveValue("Draft");
    await page.getByRole("button", { name: "Revert", exact: true }).click();
    await expect(editor(page)).toHaveValue(literal);
    await editor(page).fill("Saved prompt");
    await page.keyboard.press("Control+s");
    await expect(page.getByRole("status")).toHaveText("Saved");
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await expect(page.getByText("Unsaved changes", { exact: true })).toHaveCount(0);
    assert.deepEqual(payloads, [{ content: "Saved prompt", revision: "1" }]);
    await page.reload();
    await expect(editor(page)).toHaveValue("Saved prompt");
    assert.equal(new URL(page.url()).hash, "#token=smoke-token");
    assert.equal(new URL(page.url()).search, "?id=main");
  });

  await scenario(
    "save response cannot replace concurrent typing, including another entry",
    async (page) => {
      await item(page, "Main prompt").click();
      await editor(page).fill("Submitted draft");
      pauseSave = true;
      const started = new Promise((resolve) => {
        saveStarted = resolve;
      });
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await started;
      await editor(page).fill("Newer typing");
      await item(page, "orb_send").click();
      await editor(page).fill("Other draft");
      releaseSave();
      pauseSave = false;
      await item(page, "Main prompt").click();
      await expect(editor(page)).toHaveValue("Newer typing");
      await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByRole("status")).toHaveText("Saved");
      await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
      assert.equal(entries[0].content, "Newer typing");
      await item(page, "orb_send").click();
      await expect(editor(page)).toHaveValue("Other draft");
    },
  );

  for (const earlyDraft of [false, true]) {
    await scenario(
      `same-file sequential saves retain drafts (early: ${earlyDraft})`,
      async (page) => {
        await item(page, "orb_send").click();
        await editor(page).fill("First tool prose");
        pauseSave = true;
        const started = new Promise((resolve) => {
          saveStarted = resolve;
        });
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await started;
        await item(page, "orb_alert").click();
        if (earlyDraft) await editor(page).fill("Second tool prose");
        entries[0].scope = "Refreshed inventory";
        pauseSave = false;
        releaseSave();
        await expect(item(page, "Main prompt")).toContainText("Refreshed inventory");
        if (earlyDraft) await expect(editor(page)).toHaveValue("Second tool prose");
        else await editor(page).fill("Second tool prose");
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect(page.getByRole("status")).toHaveText("Saved");
        await expect(page.getByRole("alert")).toHaveCount(0);
        assert.deepEqual(payloads, [
          { content: "First tool prose", revision: "1" },
          { content: "Second tool prose", revision: "2" },
        ]);
        assert.equal(entries.find((entry) => entry.id === "tools").content, "First tool prose");
        assert.equal(
          entries.find((entry) => entry.id === "child-tool").content,
          "Second tool prose",
        );
        assert.equal(entries[0].content, literal);
      },
    );
  }

  await scenario("refresh preserves genuine sibling content conflicts", async (page) => {
    await item(page, "orb_alert").click();
    await editor(page).fill("Keep sibling draft");
    await item(page, "orb_send").click();
    await editor(page).fill("First tool prose");
    const refresh = holdList();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    const snapshot = await refresh.started;
    const sibling = entries.find((entry) => entry.id === "child-tool");
    sibling.content = "Externally changed description";
    for (const entry of entries) {
      if (sameFile(entry, sibling)) entry.revision = "3";
    }
    snapshot.splice(0, snapshot.length, ...structuredClone(entries));
    snapshot[0].scope = "Refreshed inventory";
    refresh.release();
    await expect(item(page, "Main prompt")).toContainText("Refreshed inventory");
    await item(page, "orb_alert").click();
    await expect(editor(page)).toHaveValue("Keep sibling draft");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText("Prompt changed");
    assert.equal(payloads.at(-1).revision, "1");
    assert.equal(sibling.content, "Externally changed description");
  });

  await scenario("pending refresh blocks sibling saves without blocking drafts", async (page) => {
    await item(page, "orb_send").click();
    await editor(page).fill("First tool prose");
    const refresh = holdList();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    const snapshot = await refresh.started;
    snapshot.find((entry) => entry.id === "tools").title = "Stale saving title";
    await expect(page.getByRole("status")).toHaveText("Saving…");
    await item(page, "orb_alert").click();
    await editor(page).fill("Sibling draft during refresh");
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await page.keyboard.press("Control+s");
    assert.equal(payloads.length, 1);
    refresh.release();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
    await expect(item(page, "orb_send")).toBeVisible();
    await expect(editor(page)).toHaveValue("Sibling draft during refresh");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Saved");
    await expect(page.getByRole("alert")).toHaveCount(0);
    assert.deepEqual(payloads.at(-1), {
      content: "Sibling draft during refresh",
      revision: "2",
    });
  });

  await scenario("old refresh cannot regress a newer sibling reload", async (page) => {
    await item(page, "orb_send").click();
    await editor(page).fill("First tool prose");
    const refresh = holdList();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    const snapshot = await refresh.started;
    snapshot[0].scope = "Old refresh completed";
    for (const entry of entries) {
      if (["tools", "child-tool"].includes(entry.id)) entry.revision = "3";
    }
    await item(page, "orb_alert").click();
    await page.getByRole("button", { name: "Reload latest", exact: true }).click();
    await expect(page.getByRole("button", { name: "Reload latest", exact: true })).toBeEnabled();
    refresh.release();
    await expect(item(page, "Main prompt")).toContainText("Old refresh completed");
    await editor(page).fill("Final prose");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Saved");
    await expect(page.getByRole("alert")).toHaveCount(0);
    assert.equal(payloads.at(-1).revision, "3");
  });

  await scenario("failed refresh does not report a successful save as failed", async (page) => {
    await item(page, "orb_send").click();
    await editor(page).fill("Saved tool prose");
    listFailure = true;
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Saved");
    await expect(page.getByRole("alert")).toContainText("Saved. Could not refresh other prompts.");
    await expect(editor(page)).toHaveValue("Saved tool prose");
    assert.equal(entries.find((entry) => entry.id === "tools").content, "Saved tool prose");
    assert.equal(payloads.length, 1);
  });

  await scenario(
    "conflict preserves draft; latest reload requires explicit discard",
    async (page) => {
      await item(page, "Main prompt").click();
      await editor(page).fill("Conflicting draft");
      entries[0].content = "External change";
      entries[0].revision = "2";
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByRole("alert")).toContainText("Prompt changed");
      await expect(editor(page)).toHaveValue("Conflicting draft");
      page.once("dialog", (dialog) => dialog.dismiss());
      await page.getByRole("button", { name: "Reload latest", exact: true }).click();
      await expect(editor(page)).toHaveValue("Conflicting draft");
      page.once("dialog", (dialog) => dialog.accept());
      await page.getByRole("button", { name: "Reload latest", exact: true }).click();
      await expect(editor(page)).toHaveValue("External change");
      await expect(page.getByRole("alert")).toHaveCount(0);
      await editor(page).fill("New prompt");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    },
  );

  await scenario("failed save retains draft and beforeunload warns", async (page) => {
    await item(page, "Main prompt").click();
    await editor(page).fill("Keep this draft");
    saveFailure = true;
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Prompt is not writable");
    await expect(editor(page)).toHaveValue("Keep this draft");
    const dialogPromise = page.waitForEvent("dialog");
    const navigation = page.evaluate(() => {
      window.location.reload();
    });
    const dialog = await dialogPromise;
    assert.equal(dialog.type(), "beforeunload");
    await dialog.dismiss();
    await navigation;
    await expect(editor(page)).toHaveValue("Keep this draft");
    saveFailure = false;
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  });

  await scenario(
    "unknown prompt preserves URL",
    async (page) => {
      await expect(
        page.getByText("Prompt “missing” doesn't exist.", { exact: true }),
      ).toBeVisible();
      await expect(page.getByRole("link", { name: "Dashboard", exact: true })).toHaveAttribute(
        "href",
        "/#token=smoke-token",
      );
      assert.equal(new URL(page.url()).search, "?id=missing");
    },
    { path: "/?id=missing#token=smoke-token" },
  );

  await scenario(
    "missing token never calls API",
    async (page) => {
      await expect(page.getByText("access token", { exact: false })).toBeVisible();
      await expect(page.getByRole("link", { name: "Dashboard", exact: true })).toBeVisible();
      assert.equal(requests.length, 0);
    },
    { path: "/" },
  );

  await scenario(
    "invalid token produces explicit error and retry",
    async (page) => {
      await expect(page.getByRole("alert")).toContainText("Access denied");
      await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    },
    { path: "/#token=invalid" },
  );

  await scenario(
    "empty inventory",
    async (page) => {
      await expect(page.getByText("No prompts found.", { exact: true })).toBeVisible();
    },
    {
      setup: () => {
        entries = [];
      },
    },
  );

  await scenario(
    "initial failure retry",
    async (page) => {
      await expect(page.getByRole("alert")).toContainText("Cannot read prompts");
      listFailure = false;
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      await expect(item(page, "Main prompt")).toBeVisible();
    },
    {
      setup: () => {
        listFailure = true;
      },
    },
  );

  await scenario("before/after review is literal and follows the draft", async (page) => {
    await item(page, "Main prompt").click();
    await editor(page).fill("Revised prose");
    await page.getByRole("button", { name: "Diff", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Before", exact: true })).toHaveValue(literal);
    await expect(page.getByText("After", { exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "After", exact: true })).toHaveValue(
      "Revised prose",
    );
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Saved");
    assert.deepEqual(payloads, [{ content: "Revised prose", revision: "1" }]);
    await expect(page.getByRole("textbox", { name: "Before", exact: true })).toHaveValue(
      "Revised prose",
    );
    await expect(page.getByRole("button", { name: "Diff", exact: true })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await page.getByRole("button", { name: "Diff", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Before", exact: true })).toHaveCount(0);
    await expect(editor(page)).toHaveValue("Revised prose");
  });

  await scenario(
    "large inventory scrolls independently of desktop editor",
    async (page) => {
      await item(page, "Main prompt").click();
      const dimensions = await page.evaluate(() => {
        const sidebar = document.querySelector(".inventory");
        const prompt = document.querySelector("#prompt");
        return {
          document: document.documentElement.scrollHeight,
          viewport: innerHeight,
          sidebarClient: sidebar.clientHeight,
          sidebarScroll: sidebar.scrollHeight,
          editorHeight: prompt.clientHeight,
        };
      });
      assert.ok(dimensions.document <= dimensions.viewport + 1);
      assert.ok(dimensions.sidebarScroll > dimensions.sidebarClient * 2);
      assert.ok(dimensions.editorHeight > 300 && dimensions.editorHeight < dimensions.viewport);
      // Click rerenders the inventory; arrows must still work immediately afterwards.
      for (let index = 0; index < 25; index += 1) await page.keyboard.press("ArrowDown");
      const current = page.locator('#inventory a[aria-current="page"]');
      await expect(current).toContainText("Prompt 24");
      await expect(current).toBeInViewport();
      assert.ok(await page.locator(".inventory").evaluate((element) => element.scrollTop > 0));
      await expect(page.getByRole("button", { name: "Save", exact: true })).toBeInViewport();
    },
    {
      setup: () => {
        const main = initial()[0];
        entries = [
          main,
          ...Array.from({ length: 98 }, (_, index) => ({
            ...main,
            id: `prompt-${index}`,
            title: `Prompt ${index}`,
          })),
        ];
      },
    },
  );

  await scenario(
    "rendered mode retains source error, filter, review and selection",
    async (page) => {
      await item(page, "Main prompt").click();
      await editor(page).fill("Invalid draft");
      validationFailure = true;
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByRole("alert")).toHaveText("Keep the prompt variables unchanged.");
      await page.getByRole("button", { name: "Diff", exact: true }).click();
      await page.locator("#search").fill("main");
      await page.getByRole("button", { name: "Rendered prompt", exact: true }).click();
      await expect(page.locator("#rendered-status")).toHaveText("Prompt doesn't exist");
      await expect(page.locator("#rendered-text")).toBeHidden();
      await page.getByRole("button", { name: "Initial context", exact: true }).click();
      await page.getByRole("button", { name: "Atomic", exact: true }).click();
      await expect(page.locator("#prompt-title")).toHaveText("Main prompt");
      await expect(page.locator("#search")).toHaveValue("main");
      await expect(page.getByRole("textbox", { name: "After", exact: true })).toHaveValue(
        "Invalid draft",
      );
      await expect(page.getByRole("alert")).toHaveText("Keep the prompt variables unchanged.");
      assert.equal(payloads.length, 1);
    },
  );

  for (const width of [1280, 390]) {
    await scenario(
      `contained layout at ${width}px`,
      async (page) => {
        await item(page, "Main prompt").click();
        await editor(page).fill("x".repeat(1200));
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        const box = await editor(page).boundingBox();
        assert.ok(box.width > 100 && box.x >= 0 && box.x + box.width <= width);
        await page.getByRole("button", { name: "Diff", exact: true }).click();
        await expect(page.getByRole("textbox", { name: "Before", exact: true })).toHaveValue(
          literal,
        );
        await expect(page.getByRole("textbox", { name: "After", exact: true })).toHaveValue(
          "x".repeat(1200),
        );
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
      },
      { width },
    );
  }
});

test("rendered prompt browser", async (t) => {
  const running = await start({ port: 0, root: root.pathname });
  assert.ok(running.isOk());
  const server = running.value;
  const browser = await chromium.launch({
    executablePath: chromiumExecutable(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE),
    headless: true,
    args: ["--no-sandbox"],
  });
  t.after(async () => {
    await browser.close();
    assert.ok((await server.close()).isOk());
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const calls = [];
  for (const width of [1280, 390]) {
    await t.test(`checkout root/child, drafts, literal text and layout at ${width}px`, async () => {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => {
        if (new URL(request.url()).pathname.startsWith("/api/")) calls.push(request.method());
      });
      try {
        await page.goto(`${origin}/?id=repository%2Finstructions#token=${server.token}`);
        const draft =
          (await page.locator("#prompt").inputValue()) +
          "\nLiteral <script>window.__renderExecuted = true</script> & {{literal_example}}";
        await page.locator("#prompt").fill(draft);
        await page.locator('#inventory a[href*="system%2Ftimezone"]').click();
        const zoneDraft = `${await page.locator("#prompt").inputValue()} Rendered zone marker.`;
        await page.locator("#prompt").fill(zoneDraft);
        await page.locator('#inventory a[href*="tool%2Forb_self"]').click();
        const toolDraft = `${await page.locator("#prompt").inputValue()} Rendered declaration marker.`;
        await page.locator("#prompt").fill(toolDraft);
        await page.locator('#inventory a[href*="repository%2Finstructions"]').click();
        await page.locator("#search").fill("instructions");
        const open = page.waitForResponse((response) => response.url().endsWith("/api/render"));
        await page.getByRole("button", { name: "Rendered prompt", exact: true }).click();
        const response = await open;
        assert.equal(response.status(), 200);
        const payload = response.request().postDataJSON();
        assert.equal(payload.harness, "pi");
        assert.equal(payload.role, "root");
        assert.equal(payload.timeZone, "America/Los_Angeles");
        assert.equal(
          payload.drafts.find((entry) => entry.id === "repository/instructions").content,
          draft,
        );
        const inventory = await page.request.get(`${origin}/api/prompts`, {
          headers: { Authorization: `Bearer ${server.token}` },
        });
        const originals = (await inventory.json()).entries;
        assert.equal(payload.drafts.length, 3);
        assert.equal(
          payload.drafts.find((entry) => entry.id === "system/timezone").content,
          zoneDraft,
        );
        assert.equal(
          payload.drafts.find((entry) => entry.id === "tool/orb_self").content,
          toolDraft,
        );
        assert.equal(
          payload.drafts.find((entry) => entry.id === "repository/instructions").revision,
          originals.find((entry) => entry.id === "repository/instructions").revision,
        );
        const text = (await response.json()).text;
        await expect(page.locator("#rendered-text")).toHaveText(text, { useInnerText: false });
        assert.equal(
          await page.locator("#rendered-text").evaluate((element) => element.textContent),
          text,
        );
        assert.ok(text.startsWith("<codemode>"));
        assert.ok(text.includes("Tools scripts can call (`await tools.<name>(args)`):"));
        assert.ok(text.includes('Namespace orb: discover with describeNamespace("orb").'));
        assert.ok(text.includes("Use archive/delete only on explicit user request"));
        const preamble = originals.find((entry) => entry.id === "system/preamble").content;
        const environment = originals.find((entry) => entry.id === "system/environment").content;
        const opening = `<orb-instructions>\n${preamble}\n\n<project_instructions>`;
        assert.ok(text.indexOf(environment) > text.indexOf("Rendered zone marker."));
        assert.ok(text.includes(opening));
        assert.ok(text.includes(draft));
        assert.ok(text.includes("Rendered zone marker."));
        assert.ok(text.split("</codemode>")[0].includes("Rendered declaration marker."));
        assert.ok(!text.includes("{{time_zone}}"));
        assert.ok(!text.includes("{{parent_instructions}}"));
        for (const skill of [
          "boot-hooks",
          "charts",
          "cloud-identity",
          "codemode-manual",
          "codemode-quick-reference",
          "hosting",
        ]) {
          assert.ok(text.includes(`/opt/pi-orb/skills/${skill}/SKILL.md`));
        }
        assert.ok(text.split("</codemode>")[0].includes("path: string"));
        assert.equal(
          await page.locator("#rendered-text").evaluate((element) => element.childElementCount),
          0,
        );
        assert.equal(await page.evaluate(() => window.__renderExecuted), undefined);
        assert.equal(
          await page.locator("#rendered-text").evaluate((element) => {
            const selection = window.getSelection();
            selection.selectAllChildren(element);
            return selection.toString();
          }),
          text,
        );
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        const box = await page.locator("#rendered-text").boundingBox();
        assert.ok(box.x >= 0 && box.width > 100 && box.x + box.width <= width);
        const childResponse = page.waitForResponse((response) =>
          response.url().endsWith("/api/render"),
        );
        await page.locator("#rendered-role").selectOption("subagent");
        const child = await childResponse;
        assert.equal(child.request().postDataJSON().role, "subagent");
        const childText = (await child.json()).text;
        await expect(page.locator("#rendered-text")).toHaveText(childText, { useInnerText: false });
        assert.notEqual(childText, text);
        assert.ok(childText.includes(opening));
        assert.ok(childText.includes("notify_parent"));
        const noZoneResponse = page.waitForResponse((response) =>
          response.url().endsWith("/api/render"),
        );
        await page.locator("#rendered-timezone").selectOption("");
        const noZone = await noZoneResponse;
        assert.equal(noZone.request().postDataJSON().timeZone, null);
        assert.ok(!(await noZone.json()).text.includes("Rendered zone marker."));
        await page.getByRole("button", { name: "Atomic", exact: true }).click();
        await expect(page.locator("#prompt")).toHaveValue(draft);
        await expect(page.locator("#search")).toHaveValue("instructions");
        await page.locator("#prompt").fill(`${draft} updated`);
        await page.locator("#search").fill("");
        const preambleDraft = "  PREAMBLE 🦊 <xml> {{literal}}  ";
        const environmentDraft = "\nENV & <markup> {{literal}}\n";
        for (const [id, content] of [
          ["system/preamble", preambleDraft],
          ["system/environment", environmentDraft],
        ]) {
          await page.locator(`#inventory a[href*="?id=${encodeURIComponent(id)}#"]`).click();
          await page.locator("#prompt").fill(content);
        }
        await page.locator('#inventory a[href*="repository%2Finstructions"]').click();
        await page.locator("#search").fill("instructions");
        const refreshed = page.waitForResponse((response) =>
          response.url().endsWith("/api/render"),
        );
        await page.getByRole("button", { name: "Rendered prompt", exact: true }).click();
        const refreshedResponse = await refreshed;
        assert.ok(
          (await refreshedResponse.json()).text.includes(
            `<orb-instructions>\n${preambleDraft}\n\n<project_instructions>`,
          ),
        );
        assert.equal(
          refreshedResponse
            .request()
            .postDataJSON()
            .drafts.find((entry) => entry.id === "repository/instructions").content,
          `${draft} updated`,
        );
        await page.goBack();
        await expect(page.locator("#prompt")).toHaveValue(`${draft} updated`);
        await page.goForward();
        await expect(page.locator("#rendered-text")).toContainText(`${draft} updated`);
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    });
  }
  for (const width of [1280, 390]) {
    await t.test(`Skills shortcut from Rendered preserves drafts at ${width}px`, async () => {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage();
      try {
        await page.goto(`${origin}/?id=skill%2Fboot-hooks%2Fbody#token=${server.token}`);
        const draft = `${await page.locator("#prompt").inputValue()}\nUnsaved skill review.`;
        await page.locator("#prompt").fill(draft);
        await page.locator("#diff").click();
        await page.locator("#search").fill("no matching entry");
        await page.locator("#redundant-filter").click();
        const response = page.waitForResponse((result) => result.url().endsWith("/api/render"));
        await page.locator("#rendered-view").click();
        assert.equal((await response).status(), 200);
        const shortcut = page.getByRole("button", { name: "Skills", exact: true });
        await expect(shortcut).toHaveCount(1);
        await expect(shortcut).toBeInViewport();
        await shortcut.focus();
        await page.keyboard.press("Enter");
        await expect(page.locator("#atomic-view")).toHaveAttribute("aria-pressed", "true");
        await expect(page.locator("#search")).toHaveValue("");
        await expect(page.locator("#redundant-filter")).toHaveAttribute("aria-pressed", "false");
        await expect(page.locator('#inventory a[aria-current="page"]')).toHaveAttribute(
          "href",
          `/?id=skill%2Fboot-hooks%2Fbody#token=${server.token}`,
        );
        await expect(page.locator("#prompt")).toHaveValue(draft);
        await expect(page.locator("#diff")).toHaveAttribute("aria-expanded", "true");
        await expect(page.locator("#edit-status")).toHaveText("Unsaved changes");
        await expect(
          page.locator("#inventory h2").filter({ hasText: /^Skills$/ }),
        ).toBeInViewport();
        await expect(page.locator('#inventory a[href*="skill%2F"]')).toHaveCount(12);
        await expect(page.locator("#inventory a")).toHaveCount(CATALOG.length);
        for (const name of [
          "boot-hooks",
          "charts",
          "cloud-identity",
          "codemode-manual",
          "codemode-quick-reference",
          "hosting",
        ])
          for (const part of ["body", "description"])
            await expect(
              page.locator(`#inventory a[href*="${encodeURIComponent(`skill/${name}/${part}`)}"]`),
            ).toBeVisible();
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        if (width === 390) {
          const first = await page.locator("#atomic-view").boundingBox();
          const last = await shortcut.boundingBox();
          assert.ok(last.y > first.y, "mobile navigation wraps");
        }
      } finally {
        await context.close();
      }
    });
  }
  await t.test(
    "unsupported, missing renderer and invalid response never show partial content",
    async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        await page.goto(`${origin}/?view=rendered&harness=claude&role=root#token=${server.token}`);
        await expect(page.locator("#rendered-status")).toContainText(
          /unsupported|unavailable|not available|cannot render/i,
        );
        await expect(page.locator("#rendered-text")).toBeHidden();
        assert.ok(page.url().includes("harness=claude"));
        await page.route("**/api/render", (route) =>
          route.fulfill({
            status: 404,
            contentType: "application/json",
            body: JSON.stringify({
              error: {
                code: "not_found",
                message: "Renderer doesn't exist on this server.",
              },
            }),
          }),
        );
        await page.locator("#rendered-harness").selectOption("pi");
        await expect(page.locator("#rendered-status")).toContainText("Renderer doesn't exist");
        await expect(page.locator("#rendered-text")).toBeHidden();
        await page.unroute("**/api/render");
        await page.route("**/api/render", (route) =>
          route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ partial: "not complete" }),
          }),
        );
        await page.getByRole("button", { name: "Refresh", exact: true }).click();
        await expect(page.locator("#rendered-status")).toContainText(/invalid|incomplete/i);
        await expect(page.locator("#rendered-text")).toBeHidden();
      } finally {
        await context.close();
      }
    },
  );
  await t.test(
    "out-of-order render completions and mode exits cannot publish stale text",
    async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      // Observe real application completion, including JSON parsing and the revision guard.
      const app = await readFile(new URL("scripts/prompt-browser/app.js", root), "utf8");
      assert.ok(app.includes("async function renderPrompt() {"));
      await page.route("**/app.js", (route) =>
        route.fulfill({
          contentType: "text/javascript",
          body: app.replace(
            "async function renderPrompt() {",
            `function renderPrompt() {
          const completion = finishRenderPrompt();
          (globalThis.__renderCompletions ??= []).push(completion);
          return completion;
        }
        async function finishRenderPrompt() {`,
          ),
        }),
      );
      let release;
      let markStarted;
      const started = new Promise((resolve) => {
        markStarted = resolve;
      });
      const held = new Promise((resolve) => {
        release = resolve;
      });
      let releaseExit;
      let markExitStarted;
      const exitStarted = new Promise((resolve) => {
        markExitStarted = resolve;
      });
      const exitHeld = new Promise((resolve) => {
        releaseExit = resolve;
      });
      let holdNextChild = false;
      let childText = "current child";
      await page.route("**/api/render", async (route) => {
        const config = route.request().postDataJSON();
        let text = config.role === "root" ? "old root" : childText;
        if (config.role === "root") {
          markStarted();
          await held;
        } else if (holdNextChild) {
          holdNextChild = false;
          text = "post-exit stale child";
          markExitStarted();
          await exitHeld;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ text }),
        });
      });
      try {
        await page.goto(`${origin}/?view=rendered#token=${server.token}`);
        await started;
        await expect(page.locator("#rendered-text")).toBeHidden();
        await page.locator("#rendered-role").selectOption("subagent");
        await expect(page.locator("#rendered-text")).toHaveText("current child");
        release();
        await page.evaluate(() => Promise.all(globalThis.__renderCompletions));
        await expect(page.locator("#rendered-text")).toHaveText("current child");
        holdNextChild = true;
        await page.getByRole("button", { name: "Refresh", exact: true }).click();
        await exitStarted;
        await page.getByRole("button", { name: "Initial context", exact: true }).click();
        await expect(page.locator("#template-role")).toHaveValue("subagent");
        await expect(page.locator("#rendered-text")).toBeHidden();
        releaseExit();
        await page.evaluate(() => Promise.all(globalThis.__renderCompletions));
        await expect(page.locator("#initial-context")).toBeVisible();
        await expect(page.locator("#rendered-prompt")).toBeHidden();
        await expect(page.locator("#rendered-text")).toBeHidden();
        assert.equal(await page.locator("#rendered-text").textContent(), "");
        childText = "latest child";
        await page.getByRole("button", { name: "Rendered prompt", exact: true }).click();
        await page.evaluate(() => Promise.all(globalThis.__renderCompletions));
        await expect(page.locator("#rendered-role")).toHaveValue("subagent");
        await expect(page.locator("#rendered-text")).toHaveText("latest child");
      } finally {
        release();
        releaseExit();
        await context.close();
      }
    },
  );
  await t.test("unknown rendered configuration preserves URL and dashboard link", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      const path = `/?view=rendered&role=missing#token=${server.token}`;
      await page.goto(origin + path);
      await expect(page.locator("#catalog-status")).toContainText("doesn't exist");
      await expect(
        page.locator("#catalog-status").getByRole("link", { name: "Dashboard", exact: true }),
      ).toBeVisible();
      assert.equal(new URL(page.url()).search, "?view=rendered&role=missing");
      await page
        .locator("#catalog-status")
        .getByRole("link", { name: "Dashboard", exact: true })
        .click();
      await expect(page.locator("#workspace")).toBeVisible();
      await expect(page.locator("#rendered-prompt")).toBeHidden();
      await page.goBack();
      await expect(page.locator("#catalog-status")).toContainText("doesn't exist");
      assert.equal(new URL(page.url()).search, "?view=rendered&role=missing");
    } finally {
      await context.close();
    }
  });
  assert.ok(!calls.includes("PUT"));
});
