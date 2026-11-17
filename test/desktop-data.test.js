import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const require = createRequire(import.meta.url);
const { desktopPaths, prepareDesktopData } = require("../desktop/paths.cjs");

test("desktop upgrades preserve data outside installation, and future data versions refuse downgrade", async () => {
  const root = await mkdtemp(join(tmpdir(), "atria-desktop-data-"));
  try {
    const paths = desktopPaths("/immutable/install", root, {});
    await prepareDesktopData(paths, "0.1.0");
    const file = join(paths.workspaceRoot, "document.txt");
    await writeFile(file, "持久内容\n");
    await prepareDesktopData(desktopPaths("/new/install", root, {}), "0.2.0");
    assert.equal(await readFile(file, "utf8"), "持久内容\n");
    assert.deepEqual(JSON.parse(await readFile(join(root, "data-version.json"), "utf8")), {
      formatVersion: 1,
      createdWith: "0.1.0",
      lastOpenedWith: "0.2.0"
    });
    await writeFile(join(root, "data-version.json"), '{"formatVersion":2}');
    await assert.rejects(prepareDesktopData(paths, "0.1.0"), /不兼容/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("renderer shutdown waits for saved documents and refuses a timeout or wrong acknowledgement", async () => {
  const { createRendererFlush } = require("../desktop/renderer-flush.cjs");
  const messages = [];
  const documents = createRendererFlush(
    () => ({
      webContents: {
        isDestroyed: () => false,
        getURL: () => "http://127.0.0.1:3880",
        send: (...args) => messages.push(args)
      }
    }),
    25
  );
  const saved = documents.request();
  documents.acknowledge("wrong-request", true);
  let settled = false;
  saved.then(() => {
    settled = true;
  });
  await new Promise((done) => setImmediate(done));
  assert.equal(settled, false);
  documents.acknowledge(messages[0][1], true);
  assert.equal(await saved, true);
  assert.equal(await documents.request(), false);
  const failed = documents.request();
  documents.acknowledge(messages[2][1], false);
  assert.equal(await failed, false);
});

