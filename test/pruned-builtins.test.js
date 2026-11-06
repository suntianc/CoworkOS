import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { startDashboard } from "./dashboard-fixture.mjs";
import { discoverSkills, createLoadSkillTool } from "../dist/src/runtime/skill-registry.js";

const removed = [
  "text-editor",
  "cad",
  "blender",
  "pptist",
  "cad-harness",
  "freecad-harness",
  "blender-harness",
  "office-harness"
];

test("the runtime catalogue is empty, rejects retired apps, and has no component installer routes", async (t) => {
  const d = await startDashboard();
  t.after(() => d.stop());
  const response = await fetch(d.base + "/api/applications");
  assert.equal(response.status, 200);
  assert.deepEqual(
    (await response.json()).applications.map((app) => app.appType),
    []
  );
  for (const appType of removed) {
    const result = await fetch(d.base + "/api/workbench/open-application", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appType })
    });
    assert.equal(result.status, 404, appType);
  }
  for (const [method, path] of [
    ["GET", "/api/components"],
    ["POST", "/api/components/blender/install"],
    ["GET", "/api/applications/blender/runtime"],
    ["POST", "/api/applications/blender/install"]
  ]) {
    const result = await fetch(d.base + path, { method });
    assert.equal(result.status, 404, path);
  }
  const state = await (await fetch(d.base + "/api/workbench/tabs")).json();
  assert.equal(state.tabs.length, 0);
});

test("retired domain workflows cannot be discovered or loaded even with an application scope", async () => {
  const skills = await discoverSkills([resolve(".pi/skills")], { applications: removed });
  const loader = createLoadSkillTool(skills);
  for (const name of [...removed, "parametric-cad", "presentations", "make-a-deck"])
    await assert.rejects(loader.execute({ name }), /unknown skill/);
  assert.ok(skills.some((skill) => skill.name === "office-documents"));
  assert.ok(skills.some((skill) => skill.name === "virtual-agent-authoring"));
});
