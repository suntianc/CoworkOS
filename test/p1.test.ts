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

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const target = String(input);
      if (target === "https://google.serper.dev/search") {
        assert.equal((init?.headers as Record<string, string>)["X-API-KEY"], "serper-test-key");
        return fakeResponse(
          JSON.stringify({
            organic: [{ position: 1, title: "Example", link: "https://example.com", snippet: "A result" }]
          }),
          200,
          "application/json"
        );
      }
      return fakeResponse(
        "<html><head><title>Example &amp; Test</title></head><body><h1>Hello</h1><script>ignore()</script><p>World</p></body></html>",
        200,
        "text/html"
      );
    }) as typeof fetch;
    try {
      const web = createWebTools({ serperApiKey: "serper-test-key" });
      const searchResult = await web.get("search")?.execute({ query: "example" });
      assert.match(JSON.stringify(searchResult), /https:\/\/example\.com/);
      const visitResult = await web.get("visit")?.execute({ url: "https://example.com" });
      assert.match(JSON.stringify(visitResult), /Hello/);
      assert.match(JSON.stringify(visitResult), /World/);
      assert.doesNotMatch(JSON.stringify(visitResult), /ignore/);
      await assert.rejects(
        () => web.get("visit")!.execute({ url: "http://127.0.0.1:8080" }),
        /private-network/
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

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

function fakeResponse(body: string, status: number, contentType: string): Response {
  return new Response(body, { status, headers: { "content-type": contentType } });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
