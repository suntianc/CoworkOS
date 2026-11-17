import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebTools } from "../src/tools/web-tools.js";
import { browseWorkspace } from "../src/tools/workspace-browse.js";
import { createLoadSkillTool, discoverSkills, skillCatalogPrompt } from "../src/runtime/skill-registry.js";

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "cowork-p1-"));
  try {
    const skillRoot = join(root, ".pi", "skills", "demo");
    await mkdir(skillRoot, { recursive: true });
    await writeFile(
      join(skillRoot, "SKILL.md"),
      "---\nname: demo-skill\ndescription: Use for demo files.\n---\n\n# Demo\nDo the demo thing.\n"
    );
    const skills = await discoverSkills([join(root, ".pi", "skills")]);
    assert.equal(skills.length, 1);
    assert.match(skillCatalogPrompt(skills), /demo-skill: Use for demo files/);
    const loaded = (await createLoadSkillTool(skills).execute({ name: "demo-skill" })) as {
      content: string;
      directory: string;
    };
    assert.match(loaded.content, /Do the demo thing/);
    assert.equal(loaded.directory, skillRoot);
    await assert.rejects(() => createLoadSkillTool(skills).execute({ name: "missing" }), /unknown skill/);

    // Private targets are refused before the provider is contacted.
    const web = createWebTools({ provider: "exa", exaEndpoint: "http://127.0.0.1:9/mcp" });
    await assert.rejects(
      () => web.get("visit")!.execute({ url: "http://127.0.0.1:8080" }),
      /private-network/
    );

    const shared = await mkdtemp(join(tmpdir(), "cowork-p1-shared-"));
    try {
      await mkdir(join(shared, "agents", "subagents", "s1"), { recursive: true });
      await writeFile(join(shared, "agents", "subagents", "s1", "progress.md"), "tests are green\n");
      const browse = (input: unknown) => browseWorkspace({ workspaceDirectory: shared }, input);
      const tree = await browse({ mode: "tree", depth: 4 });
      assert.match(JSON.stringify(tree), /agents\/subagents\/s1\/progress\.md/);
      const search = await browse({ mode: "search", query: "green" });
      assert.match(JSON.stringify(search), /progress\.md/);
      // The read-only view never leaves the Task workspace, even through a link.
      await assert.rejects(() => browse({ mode: "tree", path: "../" }), /escapes workspace/);
    } finally {
      await rm(shared, { recursive: true, force: true });
    }

    console.log("P1 tool/web tests passed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
