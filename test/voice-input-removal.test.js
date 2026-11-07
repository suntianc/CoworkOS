import "./app-boot.test.js";
import "./composer-attachments.test.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parseHTML } from "linkedom";

test("the shared composer exposes text, send, stop and attachments without a speech control", async () => {
  const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
  const { document } = parseHTML(html);
  for (const selector of ["#composer-input", "#send-button", "#stop-button", "#file-input"]) {
    assert.ok(document.querySelector(selector), `missing retained control: ${selector}`);
  }
  assert.equal(Boolean(document.querySelector(".mic-button, #i-mic")), false);
  const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(app, /SpeechRecognition|webkitSpeechRecognition|createVoiceInput|voiceInput/);
});

test("desktop preload and host expose no voice bridge or IPC while retaining other capabilities", async () => {
  const { runInNewContext } = await import("node:vm");
  const preload = await readFile(new URL("../desktop/preload.cjs", import.meta.url), "utf8");
  let bridge;
  runInNewContext(preload, {
    require: () => ({
      contextBridge: { exposeInMainWorld: (_name, value) => (bridge = value) },
      ipcRenderer: { sendSync: () => ({ entries: {} }), on() {}, invoke() {} },
      webUtils: { getPathForFile() {} }
    }),
    process: { platform: "darwin", env: {} },
    location: { protocol: "http:", origin: "http://127.0.0.1:1" },
    localStorage: { length: 0, getItem() {}, setItem() {}, removeItem() {} },
    document: { addEventListener() {} },
    window: { addEventListener() {} },
    setTimeout,
    clearTimeout,
    queueMicrotask
  });
  assert.ok(bridge);
  assert.equal("voiceInput" in bridge, false);
  assert.equal(typeof bridge.computerUse, "function");
  assert.equal(typeof bridge.onPrepareClose, "function");
  const main = await readFile(new URL("../desktop/main.cjs", import.meta.url), "utf8");
  assert.doesNotMatch(main, /speechInput|speech-input|bookman:voice-/);
});

test("build and packaging remove voice resources and privacy declarations while keeping Computer Use", async () => {
  const { access } = await import("node:fs/promises");
  const { createRequire } = await import("node:module");
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const config = createRequire(import.meta.url)("../electron-builder.config.cjs");
  assert.equal("build:speech-input" in pkg.scripts, false);
  assert.doesNotMatch(pkg.scripts["build:base"], /speech/);
  assert.ok(pkg.scripts["build:base"].includes("build-computer-use"));
  assert.equal(config.asar, false);
  assert.ok(config.files.includes("!dist/src/gui/atria-speech-input"));
  assert.ok(config.files.includes("!dist/src/gui/atria-speech-input.sha256"));
  for (const path of [
    "../desktop/speech-input.cjs",
    "../web/assets/controllers/voice-input.js",
    "../src/gui/macos-speech.swift",
    "../scripts/build-speech-input.mjs"
  ]) {
    await assert.rejects(access(new URL(path, import.meta.url)), { code: "ENOENT" });
  }
  assert.ok(config.mac.extendInfo, "packaging must remove Electron's default privacy descriptions");
  for (const key of ["NSMicrophoneUsageDescription", "NSSpeechRecognitionUsageDescription"])
    assert.equal(config.mac.extendInfo[key], null);
  const entitlements = await readFile(new URL("../desktop/entitlements.mac.plist", import.meta.url), "utf8");
  assert.doesNotMatch(entitlements, /com\.apple\.security\.device\.audio-input/);
  assert.match(entitlements, /com\.apple\.security\.cs\.allow-jit/);
  const dev = await readFile(new URL("../scripts/desktop-dev.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(dev, /speech-input|createDesktopSpeechInput/);
  assert.match(dev, /Delete :\$\{key\}/);
});

test("uploaded attachment and text survive a fresh composer session and remain isolated by task", async () => {
  const { createComposerSession } = await import("../web/assets/controllers/composer-session.js");
  const { createFileUpload, uploadedFileIds } = await import("../web/assets/controllers/file-upload.js");
  const records = new Map();
  const storage = {
    getItem: (key) => records.get(key) ?? null,
    setItem: (key, value) => records.set(key, value),
    removeItem: (key) => records.delete(key)
  };
  const create = () => {
    const input = { value: "", addEventListener() {} };
    let files = [];
    const session = createComposerSession({
      input,
      storage,
      getAttachments: () => files,
      setAttachments: (next) => (files = next)
    });
    return { input, session, getFiles: () => files, setFiles: (next) => (files = next) };
  };
  const first = create();
  first.session.activate("task-a");
  first.input.value = "Draft with an attachment";
  const bytes = [];
  const upload = createFileUpload({
    getContext: () => first.session.currentToken,
    getFiles: first.getFiles,
    setFiles: first.setFiles,
    onStatus() {},
    onBusy() {},
    onError: (message) => assert.fail(message),
    upload: async (file) => {
      bytes.push(await file.text());
      return {
        name: file.name,
        size: file.size,
        uploadId: "upload-00000000-0000-4000-8000-000000000001",
        sha256: "fixture"
      };
    }
  });
  await upload.add([new File(["fixture attachment bytes"], "sample.txt")]);
  assert.deepEqual(bytes, ["fixture attachment bytes"]);
  assert.deepEqual(uploadedFileIds(first.getFiles()), ["upload-00000000-0000-4000-8000-000000000001"]);
  assert.equal(first.session.prepareClose(), true);
  const reopened = create();
  reopened.session.activate("task-a");
  assert.equal(reopened.input.value, "Draft with an attachment");
  assert.deepEqual(uploadedFileIds(reopened.getFiles()), ["upload-00000000-0000-4000-8000-000000000001"]);
  reopened.session.activate("task-b");
  assert.equal(reopened.input.value, "");
  assert.deepEqual(reopened.getFiles(), []);
  reopened.session.activate("task-a");
  assert.equal(reopened.input.value, "Draft with an attachment");
});
