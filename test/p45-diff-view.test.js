import assert from "node:assert/strict";
import { test } from "node:test";
import { filePatchText, parseUnifiedDiff } from "../web/assets/diff-view.js";

const patch = [
  "diff --git a/summarize.sh b/summarize.sh",
  "new file mode 100644",
  "index 0000000..8d1bba2",
  "--- /dev/null",
  "+++ b/summarize.sh",
  "@@ -0,0 +1,3 @@",
  "+#!/usr/bin/env bash",
  "+set -euo pipefail",
  "+echo done",
  "diff --git a/notes.md b/notes.md",
  "index 1111111..2222222 100644",
  "--- a/notes.md",
  "+++ b/notes.md",
  "@@ -1,2 +1,2 @@",
  " # 验收记录",
  "-old line",
  "+new line"
].join("\n");

test("a unified diff is read into files and numbered lines", () => {
  const files = parseUnifiedDiff(patch);
  assert.deepEqual(
    files.map((file) => file.path),
    ["summarize.sh", "notes.md"]
  );
  assert.deepEqual(files[0].lines[0].lines, [
    { kind: "add", number: 1, text: "#!/usr/bin/env bash" },
    { kind: "add", number: 2, text: "set -euo pipefail" },
    { kind: "add", number: 3, text: "echo done" }
  ]);
  assert.deepEqual(files[1].lines[0].lines, [
    { kind: "context", number: 1, text: "# 验收记录" },
    { kind: "delete", number: 2, text: "old line" },
    { kind: "add", number: 2, text: "new line" }
  ]);
});

test("a deleted file keeps its path and one file's patch can be downloaded", () => {
  const removed = [
    "diff --git a/gone.txt b/gone.txt",
    "deleted file mode 100644",
    "--- a/gone.txt",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-removed"
  ].join("\n");
  const files = parseUnifiedDiff(removed);
  assert.equal(files[0].path, "gone.txt");
  assert.deepEqual(files[0].lines[0].lines, [{ kind: "delete", number: 1, text: "removed" }]);
  assert.equal(filePatchText(files, "gone.txt"), "@@ -1 +0,0 @@\n-removed");
});

test("an empty or unrelated text yields no files", () => {
  assert.deepEqual(parseUnifiedDiff(""), []);
  assert.deepEqual(parseUnifiedDiff("not a diff\n"), []);
});
