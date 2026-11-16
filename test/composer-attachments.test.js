import assert from "node:assert/strict";
import { test } from "node:test";
import { createComposerSession } from "../web/assets/controllers/composer-session.js";
import { createFileUpload, uploadedFileIds } from "../web/assets/controllers/file-upload.js";
import { readTextAttachments, composePrompt, MAX_ATTACHMENT_BYTES } from "../web/assets/attachments.js";

const file = (name, content) => new File([content], name);
test("attachments keep the complete tail and reject binary, invalid UTF-8 and oversized files", async () => {
  const text = "BEGIN\n" + "x".repeat(13000) + "\nEND_SENTINEL";
  const attachments = await readTextAttachments([file("full.txt", text)]);
  assert.equal(attachments[0].text, text);
  assert.ok(composePrompt("检查完整文件", attachments).endsWith("END_SENTINEL"));
  await assert.rejects(readTextAttachments([file("image.png", new Uint8Array([137, 80, 0]))]), /暂不支持/);
  await assert.rejects(readTextAttachments([file("renamed.txt", new Uint8Array([65, 0]))]), /二进制/);
  await assert.rejects(readTextAttachments([file("invalid.txt", new Uint8Array([255]))]), /UTF-8/);
  await assert.rejects(
    readTextAttachments([file("large.txt", "x".repeat(MAX_ATTACHMENT_BYTES + 1))]),
    /超过 128 KB/
  );
  await assert.rejects(readTextAttachments([1, 2, 3, 4].map((i) => file(`${i}.txt`, "ok"))), /最多/);
  assert.throws(() => composePrompt("invalid\0", []), /二进制/);
});

test("conversation drafts retain attachments across navigation and a fresh page session", () => {
  const records = new Map();
  const storage = {
    getItem: (key) => records.get(key),
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
      setAttachments: (value) => {
        files = value;
      }
    });
    return {
      input,
      session,
      files: () => files,
      setFiles: (value) => {
        files = value;
      }
    };
  };
  const first = create();
  first.session.activate("task-a");
  first.input.value = "A 的草稿";
  first.setFiles([{ name: "full.txt", text: "首尾完整", size: 12 }]);
  first.session.activate(null);
  assert.equal(first.input.value, "");
  first.input.value = "新会话草稿";
  first.session.activate("task-a");
  assert.equal(first.input.value, "A 的草稿");
  assert.equal(first.files()[0].text, "首尾完整");
  first.session.save();
  const reloaded = create();
  reloaded.session.activate(reloaded.session.activeTask);
  assert.equal(reloaded.input.value, "A 的草稿");
  assert.equal(reloaded.files()[0].name, "full.txt");
  reloaded.session.activate(null);
  assert.equal(reloaded.input.value, "新会话草稿");
  reloaded.session.transfer("task-b");
  reloaded.input.value = "";
  reloaded.setFiles([]);
  reloaded.session.save();
  reloaded.session.activate(null);
  assert.equal(reloaded.input.value, "");
  reloaded.session.activate("task-a");
  assert.equal(reloaded.input.value, "A 的草稿");
});

test("late conversation creation moves its own draft without selecting or changing another draft", () => {
  const input = { value: "", addEventListener() {} };
  let files = [];
  const session = createComposerSession({
    input,
    storage: { getItem() {}, setItem() {}, removeItem() {} },
    getAttachments: () => files,
    setAttachments: (value) => {
      files = value;
    }
  });
  session.activate(null);
  input.value = "创建中的草稿";
  files = [{ name: "source.txt", text: "SOURCE" }];
  const token = session.currentToken;
  const draft = session.snapshot();
  session.activate("task-b");
  input.value = "B 独立草稿";
  files = [{ name: "b.txt", text: "B" }];
  session.transfer("created-task", "new", token, draft);
  assert.equal(session.currentKey, "task-b");
  assert.equal(input.value, "B 独立草稿");
  assert.equal(files[0].name, "b.txt");
  session.activate("created-task");
  assert.equal(input.value, "创建中的草稿");
  assert.equal(files[0].name, "source.txt");
  session.activate("task-b");
  assert.equal(input.value, "B 独立草稿");
  session.activate(null);
  input.value = "第二份新草稿";
  const secondToken = session.currentToken;
  const secondDraft = session.snapshot();
  session.activate("task-b");
  session.activate(null);
  input.value = "返回后继续编辑的新草稿";
  session.transfer("second-created-task", "new", secondToken, secondDraft);
  assert.equal(session.currentKey, "new");
  assert.equal(input.value, "返回后继续编辑的新草稿");
  session.activate("second-created-task");
  assert.equal(input.value, "第二份新草稿");
  session.activate(null);
  assert.equal(input.value, "返回后继续编辑的新草稿");
});

test("background creation preserves the current key, token and edits even within the same composer session", () => {
  const input = { value: "", addEventListener() {} };
  let attachments = [];
  const session = createComposerSession({
    input,
    storage: { getItem() {}, setItem() {}, removeItem() {} },
    getAttachments: () => attachments,
    setAttachments: (files) => {
      attachments = files;
    }
  });
  session.activate(null);
  input.value = "创建请求的原指令";
  attachments = [{ name: "original.txt", text: "ORIGINAL" }];
  const token = session.currentToken;
  const snapshot = session.snapshot();
  input.value = "仍在当前会话编辑的下一条";
  attachments = [{ name: "latest.txt", text: "LATEST" }];
  session.transfer("background-task", "new", token, snapshot, { background: true });
  assert.equal(session.currentKey, "new");
  assert.equal(session.currentToken, token);
  assert.equal(input.value, "仍在当前会话编辑的下一条");
  assert.equal(attachments[0].name, "latest.txt");
  session.activate("background-task");
  assert.equal(input.value, "创建请求的原指令");
  assert.equal(attachments[0].name, "original.txt");
  session.activate(null);
  assert.equal(input.value, "仍在当前会话编辑的下一条");
  assert.equal(attachments[0].name, "latest.txt");
});

test("storage quota failures block closing until every in-memory conversation is persisted", () => {
  const records = new Map();
  let unavailable = false;
  const storage = {
    getItem: (key) => records.get(key),
    setItem(key, value) {
      if (unavailable) throw new Error("QuotaExceededError");
      records.set(key, value);
    },
    removeItem(key) {
      if (unavailable) throw new Error("QuotaExceededError");
      records.delete(key);
    }
  };
  const input = { value: "", addEventListener() {} };
  const session = createComposerSession({ input, storage, getAttachments: () => [], setAttachments() {} });
  session.activate("task-a");
  input.value = "A 原来已经保存的草稿";
  session.save();
  unavailable = true;
  input.value = "A 最新内存草稿";
  session.save();
  session.activate("task-b");
  input.value = "B 最新内存草稿";
  assert.equal(session.prepareClose(), false);
  assert.equal(JSON.parse(records.get("atria.composer.v1:task-a")).text, "A 原来已经保存的草稿");
  assert.equal(input.value, "B 最新内存草稿");
  unavailable = false;
  assert.equal(session.prepareClose(), true);
  assert.equal(JSON.parse(records.get("atria.composer.v1:task-a")).text, "A 最新内存草稿");
  assert.equal(JSON.parse(records.get("atria.composer.v1:task-b")).text, "B 最新内存草稿");
  session.activate("task-a");
  assert.equal(input.value, "A 最新内存草稿");
});

test("programmatic attachment changes, transfers and clearing notify the desktop mirror after storage updates", () => {
  const records = new Map();
  const mirrored = [];
  const input = { value: "", addEventListener() {} };
  let files = [];
  const session = createComposerSession({
    input,
    storage: {
      getItem: (key) => records.get(key),
      setItem: (key, value) => records.set(key, value),
      removeItem: (key) => records.delete(key)
    },
    getAttachments: () => files,
    setAttachments: (value) => {
      files = value;
    },
    onPersist: () => mirrored.push(Object.fromEntries(records))
  });
  session.activate(null);
  input.value = "异步文件已读取";
  files = [{ name: "late.txt", text: "完整文件内容" }];
  session.save();
  assert.equal(JSON.parse(mirrored.at(-1)["atria.composer.v1:new"]).attachments[0].name, "late.txt");
  session.transfer("created-task");
  assert.equal(JSON.parse(mirrored.at(-1)["atria.composer.v1:created-task"]).text, "异步文件已读取");
  assert.equal(mirrored.at(-1)["atria.composer.v1:new"], undefined);
  files = [];
  input.value = "";
  session.save();
  assert.equal(mirrored.at(-1)["atria.composer.v1:created-task"], undefined);
  assert.equal(JSON.parse(mirrored.at(-1)["atria.composer.v1:active"]), "created-task");
});

test("message edit keeps the original draft through navigation, restart, cancellation and background acceptance", () => {
  const records = new Map();
  const storage = {
    getItem: (key) => records.get(key),
    setItem: (key, value) => records.set(key, value),
    removeItem: (key) => records.delete(key)
  };
  const create = () => {
    const input = { value: "", addEventListener() {} };
    let attachments = [];
    const session = createComposerSession({
      input,
      storage,
      getAttachments: () => attachments,
      setAttachments: (files) => {
        attachments = files;
      }
    });
    return { input, session, attachments: () => attachments };
  };
  const f = create();
  f.session.activate("task-a");
  f.input.value = "unsent draft\nkeep this";
  f.session.save();
  const target = {
    messageId: "user",
    versionId: "version",
    runId: "run",
    body: "old body\nwith newlines",
    attachments: [{ name: "old.txt", uploadId: "upload-11111111-1111-4111-8111-111111111111" }]
  };
  assert.equal(f.session.beginEdit(target), true);
  assert.equal(f.input.value, "unsent draft\nkeep this");
  assert.equal(f.session.editSnapshot().text, target.body);
  assert.deepEqual(f.attachments(), []);
  assert.deepEqual(f.session.editSnapshot().attachments, target.attachments);
  f.session.updateEdit({ text: "edited body" });
  f.session.activate("task-b");
  f.input.value = "other draft";
  f.session.save();
  const restarted = create();
  restarted.session.activate("task-a");
  assert.equal(restarted.input.value, "unsent draft\nkeep this");
  assert.equal(restarted.session.editSnapshot().text, "edited body");
  assert.equal(restarted.session.editing.messageId, "user");
  restarted.session.finishEdit();
  assert.equal(restarted.input.value, "unsent draft\nkeep this");
  assert.deepEqual(restarted.attachments(), []);
  restarted.session.beginEdit(target);
  const editId = restarted.session.editing.editId;
  restarted.session.activate("task-b");
  restarted.session.finishEdit("task-a", editId);
  assert.equal(restarted.input.value, "other draft");
  restarted.session.activate("task-a");
  assert.equal(restarted.input.value, "unsent draft\nkeep this");
  assert.equal(restarted.session.editing, undefined);
});

test("uploaded attachment and text survive a fresh composer session and remain isolated by task", async () => {
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
    getDraftIdentity: () => first.session.currentToken,
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
