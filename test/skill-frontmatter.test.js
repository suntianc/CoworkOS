import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { discoverSkills } from "../dist/src/runtime/skill-registry.js";

async function discover(t, files) {
  const root = await mkdtemp(join(tmpdir(), "cowork-skill-frontmatter-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [directory, content] of Object.entries(files)) {
    await mkdir(join(root, directory), { recursive: true });
    await writeFile(join(root, directory, "SKILL.md"), content);
  }
  return discoverSkills([root]);
}

test("skill discovery reads the frontmatter scalar forms skills use", async (t) => {
  const skills = await discover(t, {
    quoted: '---\nname: quoted\ndescription: "Use for charts: bars, lines."\n---\nbody\n',
    folded: "---\nname: folded\ndescription: >-\n  Adds charts\n  to reports.\n---\nbody\n",
    literal: "---\nname: literal\ndescription: |\n  First line\n  Second line\n---\nbody\n",
    continued: "---\nname: continued\ndescription: Long sentence\n  continues here.\n---\nbody\n",
    inferred: "---\ndescription: Named by its directory.\n---\nbody\n"
  });

  assert.deepEqual(
    skills.map((skill) => [skill.name, skill.description]),
    [
      ["continued", "Long sentence continues here."],
      ["folded", "Adds charts to reports."],
      ["inferred", "Named by its directory."],
      ["literal", "First line\nSecond line"],
      ["quoted", "Use for charts: bars, lines."]
    ]
  );
});

test("skills opt out with disable-model-invocation and need a description", async (t) => {
  const skills = await discover(t, {
    hidden: "---\nname: hidden\ndescription: Hidden.\ndisable-model-invocation: true\n---\nbody\n",
    nodescription: "---\nname: nodescription\n---\nbody\n",
    visible: "---\nname: visible\ndescription: Visible.\n---\nbody\n"
  });

  assert.deepEqual(
    skills.map((skill) => skill.name),
    ["visible"]
  );
});
