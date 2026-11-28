import { randomUUID } from "node:crypto";
import {
  CAPABILITY_GOAL,
  type ClientAction,
  type ClientFrame,
  type GoalView,
  isGoalAction,
  type ServerFrame,
} from "@pi-orb/protocol";
import { expect as check } from "@playwright/test";
import { it } from "vitest";
import { gotoFrontendFixture } from "./testkit/frontend-fixture.ts";
import { createFrontendFixture } from "./testkit/frontend-owned.ts";

it.each(["chromium", "webkit"] as const)(
  "%s: Claude uses native effort levels and /effort without Pi shell prefixes",
  async (engine) => {
    const fixture = await createFrontendFixture(engine);
    const { page, origin } = fixture;
    const id = randomUUID();
    fixture.cleanup(() => page.request.delete(`${origin}/api/v1/orbs/${id}`));
    {
      const created = await page.request.post(
        `${origin}/api/v1/projects/frontend-scratchpad-project/orbs`,
        { data: { id, harness: "claude", userTimeZone: "America/Los_Angeles" } },
      );
      check(created.status()).toBe(202);
      const started = await page.request.post(`${origin}/api/v1/orbs/${id}/start`, { data: {} });
      check(started.status()).toBe(202);
      check((await started.json()).state).toBe("running");
      await gotoFrontendFixture(page, `${origin}/orbs/${id}`);
      const effort = page.getByRole("button", { name: "Change effort", exact: true });
      await check(effort).toBeEnabled();
      await check(page.getByRole("button", { name: "Change thinking", exact: true })).toHaveCount(
        0,
      );
      const input = page.getByRole("textbox", { name: "Message the orb", exact: true });
      await input.fill("retain Claude draft");
      await effort.click();
      await check(input).toHaveValue("effort ");
      await check(page.getByRole("option")).toHaveCount(5);
      for (const level of ["low", "medium", "high", "xhigh", "max"]) {
        await check(page.getByRole("option", { name: level, exact: true })).toBeVisible();
      }
      await page.getByRole("option", { name: "max", exact: true }).click();
      await check(effort).toHaveText("max");
      await check(input).toHaveValue("retain Claude draft");
      await input.fill("/effort ");
      await page.getByRole("option", { name: "xhigh", exact: true }).click();
      await check(effort).toHaveText("xhigh");
      await check(input).toHaveValue("");
      await input.pressSequentially("/go");
      await check(page.locator(".command-picker")).toHaveText("No matching command or value.");
      await input.press("Escape");
      await input.pressSequentially("!printf fixture");
      await check(input).toHaveValue("!printf fixture");
      await check(page.locator(".composer-line .composer-prefix")).toHaveText(">");
    }
  },
);

it("a new Claude orb exposes settings and /goal as soon as its first live sync arrives", async () => {
  const fixture = await createFrontendFixture("chromium");
  const { page, origin } = fixture;
  const projectPath = "/projects/frontend-scratchpad-project";
  const pending: (() => void)[] = [];
  let syncReceived = false;
  let released = false;
  const actions: ClientAction[] = [];
  await page.routeWebSocket("**/api/v1/orbs/*/live", (socket) => {
    const server = socket.connectToServer();
    server.onMessage((message) => {
      const frame = JSON.parse(message.toString()) as ServerFrame;
      const send = (next: ServerFrame) => socket.send(JSON.stringify(next));
      const forward = () => {
        if (frame.type === "server.welcome") {
          send({ ...frame, capabilities: [...frame.capabilities, CAPABILITY_GOAL] });
          return;
        }
        if (frame.type === "sync.completed")
          send({
            v: 1,
            type: "runtime.event",
            at: frame.at,
            event: { type: "goal_state", goal: null },
          });
        socket.send(message);
      };
      if (released) forward();
      else pending.push(forward);
      if (frame.type === "sync.completed") syncReceived = true;
    });
    socket.onMessage((message) => {
      const frame = JSON.parse(message.toString()) as ClientFrame;
      if (frame.type === "client.request") actions.push(frame.action);
      else server.send(message);
    });
  });

  const created = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url() === `${origin}/api/v1${projectPath}/orbs`,
  );
  await gotoFrontendFixture(page, `${origin}${projectPath}/orbs/new?harness=claude`);
  const response = await created;
  check(response.status()).toBe(202);
  const { id, harness } = (await response.json()) as { id: string; harness: string };
  fixture.cleanup(() => page.request.delete(`${origin}/api/v1/orbs/${id}`));
  check(harness).toBe("claude");
  await check(page).toHaveURL(`${origin}/orbs/${id}`);
  const started = await page.request.post(`${origin}/api/v1/orbs/${id}/start`, { data: {} });
  check(started.status()).toBe(202);

  let postedMessages = 0;
  await page.route(`**/api/v1/orbs/${id}/messages`, async (route) => {
    if (route.request().method() === "POST") {
      postedMessages++;
      await route.abort();
    } else await route.continue();
  });

  const input = page.getByRole("textbox", { name: "Message the orb", exact: true });
  const goal = page.getByRole("option", { name: "goal", exact: true });
  const add = page.getByRole("button", { name: "Add goal", exact: true });
  const effort = page.getByRole("button", { name: "Change effort", exact: true });
  const model = page.getByRole("button", { name: "Change model", exact: true });
  await check(page.locator(".orb-life-word")).toHaveText("running");
  await check.poll(() => syncReceived).toBe(true);
  const draft = "keep my draft during startup";
  await input.fill(draft);
  await input.press("Home");
  await input.press("/");
  await check(input).toHaveValue("");
  await input.press("Escape");
  await check(input).toHaveValue(draft);
  await input.press("Home");
  await page.keyboard.insertText("/");
  await check(input).toHaveValue("");
  await input.pressSequentially("go");
  const composer = await input.elementHandle();
  await check(input).toHaveValue("go");
  await check(page.locator(".command-picker")).toHaveText("Connecting…");
  for (const control of [goal, add, effort, model]) await check(control).toHaveCount(0);

  released = true;
  for (const send of pending.splice(0)) send();
  await check(goal).toBeVisible();
  for (const control of [add, effort, model]) await check(control).toBeEnabled();
  await check(page.locator(".command-picker")).not.toContainText("Connecting…");
  await check(input).toHaveValue("go");
  check(await composer.evaluate((node) => node.isConnected)).toBe(true);

  await input.pressSequentially("al");
  await input.press("Enter");
  const editor = page.getByRole("form", { name: "New goal" });
  await check(editor).toBeVisible();
  await check(input).toHaveValue(draft);
  check(actions).toEqual([]);
  check(postedMessages).toBe(0);

  await editor.getByRole("textbox", { name: "Objective" }).press("Escape");
  await check(editor).toHaveCount(0);
  await input.fill("/go");
  await page.context().setOffline(true);
  try {
    await check(page.locator(".command-picker")).toHaveText(
      "Settings unavailable — connect to a running orb.",
    );
    await check(goal).toHaveCount(0);
    await check(add).toHaveCount(0);
  } finally {
    await page.context().setOffline(false);
  }
});

it("Claude can set and clear a native goal without Pause or Resume", async () => {
  const fixture = await createFrontendFixture("chromium");
  const { page, origin } = fixture;
  const id = randomUUID();
  const apiPath = `/api/v1/orbs/${id}`;
  fixture.cleanup(() => page.request.delete(`${origin}${apiPath}`));
  const created = await page.request.post(
    `${origin}/api/v1/projects/frontend-scratchpad-project/orbs`,
    { data: { id, harness: "claude", userTimeZone: "America/Los_Angeles" } },
  );
  check(created.status()).toBe(202);
  const started = await page.request.post(`${origin}${apiPath}/start`, { data: {} });
  check(started.status()).toBe(202);

  const revision = "native-goal-1";
  const actions: ClientAction[] = [];
  let goal: GoalView | null = null;
  await page.routeWebSocket(`**${apiPath}/live`, (socket) => {
    const server = socket.connectToServer();
    const at = new Date().toISOString();
    const send = (frame: ServerFrame) => socket.send(JSON.stringify(frame));
    const sendGoal = () =>
      send({ v: 1, type: "runtime.event", at, event: { type: "goal_state", goal } });
    server.onMessage((message) => {
      const frame = JSON.parse(message.toString()) as ServerFrame;
      if (frame.type === "server.welcome") {
        send({ ...frame, capabilities: [...frame.capabilities, CAPABILITY_GOAL] });
        return;
      }
      if (frame.type === "sync.completed") sendGoal();
      socket.send(message);
    });
    socket.onMessage((message) => {
      const frame = JSON.parse(message.toString()) as ClientFrame;
      if (frame.type !== "client.request" || !isGoalAction(frame.action)) {
        server.send(message);
        return;
      }
      const { action, requestId } = frame;
      actions.push(action);
      if (action.type === "goal_set") {
        goal = { revision, objective: action.objective, status: "active" };
      } else if (action.type === "goal_clear") {
        goal = null;
      } else {
        return;
      }
      sendGoal();
      send({
        v: 1,
        type: "request.result",
        at,
        requestId,
        result: { type: "goal_applied", duplicate: false },
      });
    });
  });

  await gotoFrontendFixture(page, `${origin}/orbs/${id}`);
  const header = page.locator(".orb-header-stack");
  const add = header.getByRole("button", { name: "Add goal", exact: true });
  await add.click();
  const editor = header.getByRole("form", { name: "New goal" });
  const input = editor.getByRole("textbox", { name: "Objective" });
  const objective = "Keep the Claude work focused";
  await input.fill(objective);
  await check(editor.getByRole("button", { name: "Set goal", exact: true })).toBeEnabled();
  await input.press("Meta+Enter");

  const drawer = header.locator("details.orb-goal");
  const summary = drawer.locator("summary");
  await check(summary.getByText(objective, { exact: true })).toBeVisible();
  await check(drawer).toHaveAttribute("data-status", "active");
  await summary.click();
  await check(
    drawer.getByRole("button", { name: /^(Pause|Resume)$/, includeHidden: true }),
  ).toHaveCount(0);
  await drawer.getByRole("button", { name: "Clear", exact: true }).click();
  await check(add).toBeVisible();
  await check(drawer).toHaveCount(0);
  check(actions).toEqual([
    { type: "goal_set", objective },
    { type: "goal_clear", revision },
  ]);
});

it.each(["chromium", "webkit"] as const)(
  "%s: lifecycle cluster and slash settings preserve drafts and synchronize tabs",
  async (engine) => {
    const fixture = await createFrontendFixture(engine, {
      page: { viewport: { width: 1280, height: 900 } },
    });
    const { browser, page, origin } = fixture;
    const url = `${origin}/orbs/frontend-fixture-orb`;
    {
      await gotoFrontendFixture(page, url);
      const thinking = page.getByRole("button", { name: "Change thinking", exact: true });
      await check(thinking).toBeEnabled();
      const modelButton = page.getByRole("button", { name: "Change model", exact: true });
      await modelButton.click();
      const modelOptions = page.getByRole("option");
      await check(modelOptions).toHaveCount(4);
      for (const name of ["Astra", "Sol", "Terra", "Luna"])
        await check(page.getByRole("option", { name, exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      const input = page.getByRole("textbox", { name: "Message the orb", exact: true });
      await input.fill("keep this draft");
      await thinking.click();
      await check(input).toHaveValue("thinking ");
      await check(page.locator(".composer-line .composer-prefix")).toHaveText("/");
      await check(page.locator(".command-picker")).not.toContainText("←");
      await input.click();
      await check(page.locator(".command-picker")).toBeVisible();
      await input.press("Escape");
      await check(page.locator(".command-picker")).toHaveCount(0);
      await check(input).toHaveValue("keep this draft");
      await thinking.click();
      await page.locator(".orb-name").click();
      await check(page.locator(".command-picker")).toHaveCount(0);
      await check(input).toHaveValue("keep this draft");
      await thinking.click();
      await page.getByRole("option", { name: "low", exact: true }).focus();
      await page.keyboard.press("Escape");
      await check(page.locator(".command-picker")).toHaveCount(0);
      await check(input).toHaveValue("keep this draft");
      await thinking.click();
      await page.getByRole("option", { name: "low", exact: true }).click();
      await check(thinking).toHaveText("low");
      await check(input).toHaveValue("keep this draft");
      const second = await browser.newPage();
      await second.goto(url);
      await check(second.getByRole("button", { name: "Change thinking", exact: true })).toHaveText(
        "low",
      );
      await input.fill("");
      await input.press("/");
      await check(input).toHaveValue("");
      await input.press("Tab");
      await check(input).toHaveValue("model ");
      await input.press("Escape");
      await check(page.locator(".command-picker")).toHaveCount(0);
      await input.press("/");
      await input.pressSequentially("unknown");
      await input.press("Enter");
      await check(input).toHaveValue("unknown");
      await input.fill("model sol");
      await input.press("Enter");
      await check(page.getByRole("button", { name: "Change model", exact: true })).toHaveText(
        "Sol",
      );
      await check(second.getByRole("button", { name: "Change model", exact: true })).toHaveText(
        "Sol",
      );
      const bounds = await page.locator(".orb-header").evaluate((element) => ({
        height: element.getBoundingClientRect().height,
        overflow: element.scrollWidth > element.clientWidth,
      }));
      check(bounds).toEqual({ height: 24, overflow: false });
      const status = await page.locator(".orb-life").boundingBox();
      const stop = await page.getByRole("button", { name: "Stop orb", exact: true }).boundingBox();
      const model = await page
        .getByRole("button", { name: "Change model", exact: true })
        .boundingBox();
      check(status && stop && model && status.x < stop.x && stop.x < model.x).toBeTruthy();
      await page.reload();
      await check(page.getByRole("button", { name: "Change model", exact: true })).toHaveText(
        "Sol",
      );
      for (const width of [601, 768, 1024]) {
        await page.setViewportSize({ width, height: 900 });
        check(
          await page
            .locator(".orb-header")
            .evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true);
      }
      await page.setViewportSize({ width: 390, height: 844 });
      const rename = page.getByRole("button", { name: "Rename orb", exact: true });
      check((await rename.boundingBox())?.width).toBe(44);
      await page.getByRole("button", { name: "Write message", exact: true }).click();
      await input.fill("/thinking ");
      await page.getByRole("option", { name: "high", exact: true }).click();
      await check(input).toHaveValue("");
      await second.close();
    }
  },
);
