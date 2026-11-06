import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
const { isArtifactViewerUrl } = createRequire(import.meta.url)("../desktop/artifact-viewer.cjs");

test("the host accepts only a blob URL of the currently selected local origin", () => {
  const selected = "http://127.0.0.1:1234";
  const id = "7b5875f8-8ff8-46e5-9f9b-95c8f9ef3052";
  assert.equal(isArtifactViewerUrl(`blob:${selected}/${id}`, selected), true);
  for (const value of [
    `blob:http://127.0.0.1:1235/${id}`,
    `blob:${selected}/${id}?x=1`,
    `blob:${selected}/${id}/other`,
    `blob:${selected}/not-a-uuid`,
    `http://127.0.0.1:1234/${id}`,
    `blob:https://example.invalid/${id}`
  ])
    assert.equal(isArtifactViewerUrl(value, selected), false, value);
  assert.equal(isArtifactViewerUrl(null, selected), false);
});
