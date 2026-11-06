import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const { connectRenderer } = createRequire(import.meta.url)("../desktop/renderer-connection.cjs");
const backend = { url: "http://127.0.0.1:12345" };

test("renderer removes the legacy host cookie before navigating to the selected backend", async () => {
  const events = [];
  await connectRenderer(
    backend,
    {
      remove: async (url, name) => {
        assert.equal(url, backend.url);
        assert.equal(name, "atria-session");
        events.push("remove");
      }
    },
    () => ({
      isDestroyed: () => false,
      loadURL: async (url) => {
        assert.equal(url, backend.url);
        events.push("navigate");
      }
    })
  );
  assert.deepEqual(events, ["remove", "navigate"]);
});

test("a closed renderer is not navigated and a cookie removal failure prevents navigation", async () => {
  await connectRenderer(backend, { remove: async () => {} }, () => undefined);
  await assert.rejects(
    connectRenderer(
      backend,
      {
        remove: async () => {
          throw new Error("cookie failure");
        }
      },
      () => ({ isDestroyed: () => false, loadURL: () => assert.fail("must not navigate") })
    ),
    /cookie failure/
  );
});
