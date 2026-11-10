import assert from "node:assert/strict";
import { test } from "node:test";
import { createArtifactController } from "../web/assets/controllers/artifact-controller.js";

function artifactFixture({ mimeType = "application/pdf", editable, sourceResourceId, sourceChanged } = {}) {
  // The controller remembers the element that opened the preview; Node has no
  // document, so the fixture supplies the one field it reads.
  globalThis.document ??= { activeElement: null, body: {} };
  const path = "介绍 中文 & #.pptx";
  const calls = [];
  let finish;
  let navigation = 0;
  const state = {
    selected: "task-a",
    openFiles: [],
    previewPath: null,
    artifactDrawerOpen: false,
    artifactCache: new Map(),
    detail: {
      artifacts: [{ relativePath: path, mimeType }],
      applications: { deliverables: [{ relativePath: path, editable, sourceResourceId }] }
    }
  };
  const workbench = {
    editableKinds: new Set(["application/vnd.openxmlformats-officedocument.presentationml.presentation"]),
    captureNavigation() {
      const captured = ++navigation;
      calls.push(["navigation"]);
      return { navigation: captured, current: () => navigation === captured };
    },
    importArtifact: async (...args) => {
      calls.push(["import", ...args]);
      if (sourceResourceId && !sourceChanged)
        return { reused: true, resource: { resourceId: sourceResourceId, title: "原文档" } };
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    api: {
      openTab: async (body) => calls.push(["tab", body])
    },
    refreshTabs: async () => {},
    host: { activate: async (...args) => calls.push(["activate", ...args]) }
  };
  const controller = createArtifactController({
    state,
    getWorkbench: () => workbench,
    $: () => null,
    showToast() {},
    renderRightPanel: () => calls.push(["render"]),
    api: async (...args) => {
      calls.push(["preview", ...args]);
      return { previewKind: "pdf" };
    }
  });
  return {
    path,
    state,
    calls,
    controller,
    finish: () => finish({ resource: { resourceId: "res_imported", title: "介绍" } })
  };
}

for (const metadata of [
  { mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
  { editable: true }
])
  test(`opening an editable artifact goes directly to its application (${metadata.mimeType || "deliverable"})`, async () => {
    const f = artifactFixture(metadata);
    const pending = f.controller.openArtifact(f.path);
    assert.equal(f.calls.filter(([kind]) => kind === "import").length, 1);
    assert.equal(f.state.artifactDrawerOpen, false);
    assert.equal(
      f.calls.some(([kind]) => kind === "preview" || kind === "render"),
      false
    );
    f.finish();
    await pending;
    assert.equal(f.calls.at(-1)[0], "activate");
  });

test("opening a PDF or unsupported artifact keeps the file preview", async () => {
  const f = artifactFixture();
  await f.controller.openArtifact(f.path);
  assert.equal(f.state.artifactDrawerOpen, true);
  assert.equal(f.state.previewPath, f.path);
  assert.equal(
    f.calls.some(([kind]) => kind === "preview"),
    true
  );
  assert.equal(
    f.calls.some(([kind]) => kind === "import"),
    false
  );
});

for (const mimeType of ["application/json", "application/octet-stream"])
  test(`a merged source file link opens its resource application (${mimeType})`, async () => {
    const f = artifactFixture({ mimeType });
    f.state.detail.applications.deliverables = [
      {
        kind: "resource",
        resourceId: "res_original",
        editable: true,
        files: [{ relativePath: f.path, mimeType }]
      }
    ];
    const pending = f.controller.openArtifact(f.path);
    assert.equal(f.calls.filter(([kind]) => kind === "import").length, 1);
    assert.equal(f.state.artifactDrawerOpen, false);
    f.finish();
    await pending;
    assert.equal(f.calls.at(-1)[0], "activate");
  });

test("repeated clicks while an artifact is importing share one editor handoff", async () => {
  const f = artifactFixture({ editable: true });
  const pending = f.controller.openArtifact(f.path);
  const duplicate = f.controller.openArtifact(f.path);
  assert.equal(f.calls.filter(([kind]) => kind === "import").length, 1);
  f.finish();
  await Promise.all([pending, duplicate]);
  assert.equal(f.calls.filter(([kind]) => kind === "tab").length, 1);
  assert.equal(f.calls.filter(([kind]) => kind === "activate").length, 1);
});

test("returning to a pending artifact after another preview honors the last click", async () => {
  const f = artifactFixture({ editable: true });
  const previewPath = "预览.pdf";
  f.state.detail.artifacts.push({ relativePath: previewPath, mimeType: "application/pdf" });
  const first = f.controller.openArtifact(f.path);
  f.controller.openArtifact(previewPath);
  const last = f.controller.openArtifact(f.path);
  f.finish();
  await Promise.all([first, last]);
  assert.equal(f.calls.filter(([kind]) => kind === "import").length, 1);
  assert.equal(f.calls.filter(([kind]) => kind === "tab").length, 1);
  assert.equal(f.calls.filter(([kind]) => kind === "activate").length, 1);
  assert.equal(f.state.artifactDrawerOpen, false);
});

test("opening a known export closes the drawer with the same navigation scope", async () => {
  const f = artifactFixture({ editable: true, sourceResourceId: "res_original" });
  f.state.artifactDrawerOpen = true;
  await f.controller.openArtifact(f.path);
  assert.equal(f.state.artifactDrawerOpen, false);
  assert.equal(f.calls.filter(([kind]) => kind === "navigation").length, 1);
  assert.equal(f.calls.filter(([kind]) => kind === "import").length, 1);
  assert.equal(f.calls.find(([kind]) => kind === "tab")[1].resourceId, "res_original");
});

test("a changed export opens the document resolved by the shared import service", async () => {
  const f = artifactFixture({ editable: true, sourceResourceId: "res_original", sourceChanged: true });
  const pending = f.controller.openArtifact(f.path);
  assert.equal(f.calls.filter(([kind]) => kind === "import").length, 1);
  f.finish();
  await pending;
  assert.equal(f.calls.find(([kind]) => kind === "tab")[1].resourceId, "res_imported");
});

test("a later file preview remains selected when an earlier editable artifact finishes importing", async () => {
  const f = artifactFixture({ editable: true });
  const previewPath = "预览.pdf";
  f.state.detail.artifacts.push({ relativePath: previewPath, mimeType: "application/pdf" });
  const pending = f.controller.openArtifact(f.path);
  f.controller.openArtifact(previewPath);
  f.finish();
  await pending;
  assert.equal(f.state.artifactDrawerOpen, true);
  assert.equal(f.state.previewPath, previewPath);
  assert.equal(f.calls.filter(([kind]) => kind === "activate").length, 0);
});

for (const action of ["openResourceInEditor", "editArtifact"])
  for (const navigated of [false, true])
    test(`${action} preserves its original task and ${navigated ? "a later navigation" : "the requested focus"}`, async () => {
      let finish;
      let current = true;
      const calls = [];
      const pending = new Promise((resolve) => {
        finish = resolve;
      });
      const state = {
        selected: "task-a",
        detail: { artifacts: [{ relativePath: "original-resource-or-artifact" }] }
      };
      const workbench = {
        captureNavigation: () => ({ current: () => current, navigation: 7 }),
        importArtifact: async (...args) => {
          calls.push(["import", ...args]);
          return pending;
        },
        api: {
          openResource: async (...args) => {
            calls.push(["open", ...args]);
            return pending;
          },
          openTab: async (body) => {
            calls.push(["tab", body]);
          }
        },
        refreshTabs: async () => {
          calls.push(["refresh"]);
        },
        host: {
          activate: async (...args) => {
            calls.push(["activate", ...args]);
          }
        }
      };
      const controller = createArtifactController({
        state,
        getWorkbench: () => workbench,
        $: () => null,
        showToast() {}
      });
      const request = controller[action]("original-resource-or-artifact");
      if (navigated) {
        current = false;
        state.selected = "task-b";
      }
      finish({
        resource: { resourceId: "created-resource", title: "可编辑文档" },
        appInstance: { resourceIds: ["created-resource"] }
      });
      await request;
      assert.equal(calls[0][1], "task-a");
      assert.deepEqual(calls.find(([kind]) => kind === "tab")[1], {
        kind: "application",
        resourceId: "created-resource",
        activate: false
      });
      assert.equal(calls.filter(([kind]) => kind === "activate").length, navigated ? 0 : 1);
      if (!navigated)
        assert.deepEqual(calls.at(-1), ["activate", "resource:created-resource", { navigation: 7 }]);
    });

for (const navigated of [false, true])
  test(`opening a known export reuses its document and preserves ${navigated ? "later navigation" : "focus"}`, async () => {
    let finish;
    let current = true;
    const calls = [];
    const state = {
      selected: "task-a",
      detail: {
        artifacts: [{ relativePath: "export.pptx" }],
        applications: { deliverables: [{ relativePath: "export.pptx", sourceResourceId: "res_original" }] }
      }
    };
    const workbench = {
      captureNavigation: () => ({ current: () => current, navigation: 7 }),
      importArtifact: async (...args) => {
        calls.push(["import", ...args]);
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
      api: {
        openTab: async (body) => {
          calls.push(["tab", body]);
        }
      },
      refreshTabs: async () => {},
      host: {
        activate: async (...args) => {
          calls.push(["activate", ...args]);
        }
      }
    };
    const controller = createArtifactController({
      state,
      getWorkbench: () => workbench,
      $: () => null,
      showToast() {}
    });
    const pending = controller.editArtifact("export.pptx");
    if (navigated) {
      current = false;
      state.selected = "task-b";
    }
    finish({ reused: true, resource: { resourceId: "res_original", title: "原文档" } });
    await pending;
    assert.equal(calls[0][0], "import");
    assert.equal(calls[0][1], "task-a");
    assert.equal(calls[0][2].relativePath, "export.pptx");
    assert.equal(calls.find(([kind]) => kind === "tab")[1].resourceId, "res_original");
    assert.equal(calls.filter(([kind]) => kind === "activate").length, navigated ? 0 : 1);
  });
