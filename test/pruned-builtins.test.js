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

test("the runtime catalogue is gone and has no component installer routes", async (t) => {
  const d = await startDashboard();
  t.after(() => d.stop());
  for (const appType of removed) {
    const result = await fetch(d.base + "/api/workbench/open-application", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appType })
    });
    assert.equal(result.status, 404, appType);
  }
  for (const [method, path] of [
    ["GET", "/api/applications"],
    ["GET", "/api/components"],
    ["POST", "/api/components/blender/install"],
    ["GET", "/api/applications/blender/runtime"],
    ["POST", "/api/applications/blender/install"],
    ["GET", "/api/workbench/tabs"]
  ]) {
    const result = await fetch(d.base + path, { method });
    assert.equal(result.status, 404, path);
  }
});

test("retired domain workflows cannot be discovered or loaded", async () => {
  const skills = await discoverSkills([resolve(".pi/skills")]);
  const loader = createLoadSkillTool(skills);
  for (const name of [
    ...removed,
    "virtual-agent-authoring",
    "parametric-cad",
    "presentations",
    "make-a-deck",
    "office-documents"
  ])
    await assert.rejects(loader.execute({ name }), /unknown skill/);
  assert.ok(skills.some((skill) => skill.name === "iterative-optimization"));
});
