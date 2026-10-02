import assert from "node:assert/strict";
import { test } from "node:test";
import { preflightDecision } from "./native-browser-fence.mjs";

const projectId = "11111111-2222-4333-8444-555555555555";
const orbId = "22222222-3333-4444-8555-666666666666";
const project = (id, state) => ({ id, state });
const orb = (id, state = "archived", hostRef = null) => ({ id, state, hostRef });

test("fresh fixture starts normally", () => {
  assert.equal(preflightDecision(projectId, orbId, []), false);
  assert.equal(
    preflightDecision(projectId, orbId, [
      { project: project("other", "active"), orbs: [orb("other")] },
    ]),
    false,
  );
});

test("only an archived or deleting, host-free owned orb in deleting project may resume cleanup", () => {
  for (const state of ["archived", "deleting"])
    assert.equal(
      preflightDecision(projectId, orbId, [
        { project: project(projectId, "deleting"), orbs: [orb(orbId, state)] },
      ]),
      true,
    );
  for (const entry of [
    { project: project(projectId, "active"), orbs: [orb(orbId, "deleting")] },
    { project: project(projectId, "deleting"), orbs: [orb(orbId, "stopped")] },
    { project: project(projectId, "deleting"), orbs: [orb(orbId, "deleting", "vm")] },
    { project: project(projectId, "deleting"), orbs: [orb("foreign", "deleting")] },
  ])
    assert.throws(() => preflightDecision(projectId, orbId, [entry]));
  assert.throws(() =>
    preflightDecision(projectId, orbId, [
      { project: project(projectId, "deleting"), orbs: [orb(orbId)] },
      { project: project("other", "active"), orbs: [orb("other", "stopped", "vm")] },
    ]),
  );
});
