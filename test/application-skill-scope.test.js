import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import { discoverSkills, createLoadSkillTool } from "../dist/src/runtime/skill-registry.js";

const requirePi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = await import(requirePi.resolve("jiti"));
const helperPath = resolve(".pi/runtime/application-skills.ts");
const { mainApplicationSkillScope, mainApplicationSkills } = await createJiti(
  pathToFileURL(helperPath).href
).import(helperPath);

test("explicit Pi skill files retain SDK-compatible inferred names and application scope", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-explicit-skill-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const userPath = join(root, "user-skill", "SKILL.md");
  const appPath = join(root, "app-skill", "SKILL.md");
  await mkdir(join(root, "user-skill"));
  await mkdir(join(root, "app-skill"));
  await writeFile(
    userPath,
    "---\ndescription: An explicit SDK skill without a name field\n---\nUser workflow."
  );
  await writeFile(
    appPath,
    "---\ndescription: Scoped explicit skill\napplication: example-app\n---\nApp workflow."
  );
  assert.deepEqual(
    (await discoverSkills([userPath, appPath])).map((skill) => skill.name),
    ["user-skill"]
  );
  assert.deepEqual(
    (await discoverSkills([userPath, appPath], { applications: ["example-app"] })).map((skill) => skill.name),
    ["app-skill", "user-skill"]
  );
});

test("Main's canonical SDK catalog preserves overrides and YAML while honoring disabled and empty selections", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-sdk-skill-selection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const overridePath = join(root, "charts", "SKILL.md");
  const yamlPath = join(root, "yaml-skill", "SKILL.md");
  await mkdir(join(root, "charts"));
  await mkdir(join(root, "yaml-skill"));
  await writeFile(overridePath, "---\nname: charts\ndescription: User override\n---\nUSER_OVERRIDE body.");
  await writeFile(
    yamlPath,
    "---\nname: yaml-skill\ndescription:\n  Valid SDK description split onto next line.\n---\nYAML_WORKFLOW body."
  );
  const sdk = () =>
    loadSkills({ cwd: root, agentDir: root, skillPaths: [overridePath, yamlPath], includeDefaults: false })
      .skills;
  const base = [resolve(".pi/skills")];
  let selected = sdk();
  let scope = mainApplicationSkillScope(base, undefined, resolve("."), selected);
  let catalog = await mainApplicationSkills(scope, selected);
  assert.equal(catalog.find((skill) => skill.name === "charts").filePath, overridePath);
  assert.equal(
    catalog.find((skill) => skill.name === "yaml-skill").description,
    "Valid SDK description split onto next line."
  );
  let tool = createLoadSkillTool(await discoverSkills(scope.skillRoots));
  assert.match((await tool.execute({ name: "charts" })).content, /USER_OVERRIDE body/);
  assert.match((await tool.execute({ name: "yaml-skill" })).content, /YAML_WORKFLOW body/);

  await writeFile(
    overridePath,
    "---\nname: charts\ndescription: User override\ndisable-model-invocation: true\n---\nDisabled body."
  );
  selected = sdk();
  scope = mainApplicationSkillScope(base, undefined, resolve("."), selected);
  catalog = await mainApplicationSkills(scope, selected);
  assert.ok(
    !catalog.some((skill) => skill.name === "charts"),
    "a disabled user override does not fall back to bundled charts"
  );
  tool = createLoadSkillTool(await discoverSkills(scope.skillRoots));
  await assert.rejects(() => tool.execute({ name: "charts" }), /unknown skill/);

  scope = mainApplicationSkillScope(base, undefined, resolve("."), []);
  assert.deepEqual(await mainApplicationSkills(scope, []), [], "an explicit empty SDK catalog stays empty");
  assert.deepEqual(await discoverSkills(scope.skillRoots), []);
  const legacy = mainApplicationSkillScope(base, undefined, resolve("."), undefined);
  assert.ok((await discoverSkills(legacy.skillRoots)).some((skill) => skill.name === "charts"));
});
