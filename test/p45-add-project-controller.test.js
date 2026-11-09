import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { parseHTML } from "linkedom";
import { createAddProjectController } from "../web/assets/controllers/add-project.js";

function fixture(t, { api, command } = {}) {
  const { window, document } = parseHTML(readFileSync("web/index.html", "utf8"));
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    CSS: globalThis.CSS
  };
  globalThis.window = window;
  globalThis.document = document;
  globalThis.CSS = { escape: (value) => value };
  window.HTMLElement.prototype.getClientRects ??= () => [];
  const calls = [];
  const created = [];
  const toasts = [];
  const controller = createAddProjectController({
    api: async (path, options) => {
      calls.push({ path, options });
      return api(path, options);
    },
    command: async (path, options) => {
      calls.push({ path, options });
      return command(path, options);
    },
    showToast: (message) => toasts.push(message),
    onCreated: (project) => {
      created.push(project);
    }
  });
  const $ = (selector) => document.querySelector(selector);
  const submit = () =>
    $(".add-project-dialog form").dispatchEvent(new window.Event("submit", { cancelable: true }));
  t.after(() => {
    controller.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });
  return { controller, calls, created, toasts, $, submit, window };
}

test("adding a local project sends the folder, closes and hands the project over", async (t) => {
  const f = fixture(t, {
    command: async () => ({ project: { projectId: "project_new", projectName: "新项目" } })
  });
  f.controller.open();
  assert.equal(f.$("#add-project-modal").hidden, false);
  assert.equal(f.$("#add-project-tab-local").getAttribute("aria-selected"), "true");
  f.$("#add-project-name").value = "新项目";
  f.$("#add-project-directory").value = "/tmp/new";
  f.submit();
  await delay(0);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].path, "/api/projects");
  assert.deepEqual(f.calls[0].options.body, { projectName: "新项目", projectDirectory: "/tmp/new" });
  assert.deepEqual(f.created, [{ projectId: "project_new", projectName: "新项目" }]);
  assert.equal(f.$("#add-project-modal").hidden, true);
  assert.equal(f.$("#add-project-name").value, "");
});

test("a failed local attempt keeps the dialog and its inputs", async (t) => {
  const f = fixture(t, {
    command: async () => {
      throw new Error("该工作文件夹已属于另一个项目");
    }
  });
  f.controller.open();
  f.$("#add-project-name").value = "重复项目";
  f.$("#add-project-directory").value = "/tmp/taken";
  f.submit();
  await delay(0);
  assert.equal(f.$("#add-project-modal").hidden, false);
  assert.match(f.$("#add-project-state").textContent, /另一个项目/);
  assert.equal(f.$("#add-project-state").getAttribute("role"), "alert");
  assert.equal(f.$("#add-project-name").value, "重复项目");
  assert.equal(f.$("#add-project-directory").value, "/tmp/taken");
  assert.deepEqual(f.created, []);
});

test("the Git panel starts a clone, shows progress and keeps the input after a failure", async (t) => {
  let polled = 0;
  const f = fixture(t, {
    api: async (path) => {
      if (path === "/api/project-clones")
        return { clone: { cloneId: "clone_1", state: "cloning", progress: 0 } };
      polled += 1;
      if (polled === 1) return { clone: { cloneId: "clone_1", state: "cloning", progress: 42 } };
      return {
        clone: {
          cloneId: "clone_1",
          state: "failed",
          progress: 0,
          error: "Permission denied (publickey)"
        }
      };
    }
  });
  f.controller.open();
  f.$("#add-project-tab-git").click();
  assert.equal(f.$("#add-project-panel-local").hidden, true);
  assert.equal(f.$("#add-project-panel-git").hidden, false);
  assert.equal(f.$("#add-project-submit").textContent, "克隆并添加");
  f.$("#add-project-remote").value = "git@github.com:acme/website.git";
  f.$("#add-project-destination").value = "/tmp/website";
  f.$("#add-project-branch").value = "release";
  f.submit();
  await delay(0);
  assert.equal(f.calls[0].path, "/api/project-clones");
  assert.equal(f.calls[0].options.json.remoteUrl, "git@github.com:acme/website.git");
  assert.equal(f.calls[0].options.json.destination, "/tmp/website");
  assert.equal(f.calls[0].options.json.branch, "release");
  assert.match(f.calls[0].options.json.operationId, /^clone:/);
  assert.match(f.$("#add-project-state").textContent, /克隆中 · 0%/);
  await delay(450);
  assert.match(f.$("#add-project-state").textContent, /克隆中 · 42%/);
  await delay(450);
  assert.match(f.$("#add-project-state").textContent, /克隆失败：Permission denied \(publickey\)/);
  assert.equal(f.$("#add-project-modal").hidden, false);
  assert.equal(f.$("#add-project-remote").value, "git@github.com:acme/website.git");
});

test("closing the dialog cancels the running clone", async (t) => {
  const f = fixture(t, {
    api: async (path) => {
      if (path === "/api/project-clones")
        return { clone: { cloneId: "clone_9", state: "cloning", progress: 0 } };
      return { clone: { cloneId: "clone_9", state: "cancelled", progress: 0 } };
    }
  });
  f.controller.open();
  f.$("#add-project-tab-git").click();
  f.$("#add-project-remote").value = "https://example.test/slow.git";
  f.$("#add-project-destination").value = "/tmp/slow";
  f.submit();
  await delay(0);
  f.$("#add-project-cancel").click();
  await delay(0);
  assert.equal(f.$("#add-project-modal").hidden, true);
  assert.equal(
    f.calls.some((call) => call.path === "/api/project-clones/clone_9/cancel"),
    true
  );
});
