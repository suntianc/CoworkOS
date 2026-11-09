import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { buildTabs, renderTabStrip } from "../web/assets/workbench/host.js";
import { bindingModel, renderBindingMenu, UNBOUND } from "../web/assets/workbench/binding.js";

function instance(id, title, resourceId, status = "open", conversations = [{ taskId: "task-a" }]) {
  return {
    appInstanceId: id,
    appType: "text-editor",
    title,
    resourceIds: [resourceId],
    resourceId,
    status,
    conversations
  };
}

/** A tab as the global strip reports it. */
function appTab(taskId, appInstanceId, title, extra = {}) {
  const resourceId = extra.resourceId ?? `res_${appInstanceId}`;
  return {
    tabId: `resource:${resourceId}`,
    kind: "application",
    appType: "text-editor",
    title,
    resourceId,
    hasResource: true,
    conversations: taskId ? [{ taskId, goal: extra.taskGoal }] : [],
    ...(taskId ? { groupTaskId: taskId } : { standalone: true }),
    ...extra
  };
}
function chatTab(taskId, taskGoal) {
  return { tabId: `conversation:${taskId}`, kind: "conversation", taskId, title: taskGoal, taskGoal };
}

test("tabs from several tasks stay grouped by conversation", () => {
  // Tabs are global, the way a browser's are: which task a tab belongs to is a
  // property of the tab, not of the window.
  const { tabs } = buildTabs({
    tabs: [
      appTab("task-a", "app_1", "方案.md", { taskGoal: "产品方案" }),
      chatTab("task-b", "调研"),
      chatTab("task-a", "产品方案"),
      appTab("task-b", "app_2", "笔记.md", { taskGoal: "调研" })
    ]
  });
  // Each task's conversation leads its own group: an application tab only makes
  // sense beside the conversation it belongs to.
  assert.deepEqual(
    tabs.map((tab) => tab.tabId),
    ["conversation:task-a", "resource:res_app_1", "conversation:task-b", "resource:res_app_2"]
  );
  // A conversation tab's title is already the task, so only application tabs
  // carry the prefix — and only while more than one task is open, which is the
  // sole case where two same-named documents need telling apart.
  assert.deepEqual(
    tabs.map((tab) => tab.taskLabel),
    [undefined, "产品方案", undefined, "调研"]
  );
  const single = buildTabs({
    tabs: [chatTab("task-a", "甲"), appTab("task-a", "app_1", "a.md", { taskGoal: "甲" })]
  });
  assert.deepEqual(
    single.tabs.map((tab) => tab.taskLabel),
    [undefined, undefined],
    "one open task needs no prefix at all"
  );
});

test("a tab says one thing: a conversation, an application, or a document", () => {
  // What the strip actually rendered before this: "编辑《产品方案》产品方案.md1"
  // — the conversation's name, the file name and an unread count crammed into
  // one tab — and "未归属的文档文本编辑器" for a window opened on its own, where
  // 未归属的文档 is the internal placeholder goal of the workspace that holds
  // unattached windows, printed as though the person had named a conversation.
  const { tabs } = buildTabs({
    tabs: [
      chatTab("task-a", "编辑《产品方案》"),
      appTab("task-a", "app_1", "产品方案.md", {
        taskGoal: "编辑《产品方案》",
        hasResource: true,
        unread: 1
      }),
      {
        tabId: "application:workspace:app_2",
        kind: "application",
        taskId: "workspace",
        appInstanceId: "app_2",
        appType: "text-editor",
        title: "文本编辑器",
        standalone: true,
        hasResource: false
      }
    ]
  });
  const [chat, doc, loose] = tabs;

  // One conversation is open, so its document needs no conversation prefix: the
  // standalone workspace is not a second conversation.
  assert.equal(doc.taskLabel, undefined, "a lone conversation's document carries no prefix");
  assert.equal(chat.taskLabel, undefined);
  // The unattached window says so in the user's own terms, and never borrows
  // the workspace's internal goal.
  assert.equal(loose.standalone, true);
  assert.equal(loose.taskLabel, undefined);
  // A window with nothing open in it is the application, not a document: no
  // unread count, and marked so the strip can draw it differently.
  assert.equal(loose.empty, true);
  assert.equal(loose.unread, 0);
  assert.equal(doc.empty, false);
  assert.equal(doc.unread, 1);

  const markup = renderTabStrip({ tabs, activeTabId: chat.tabId });
  assert.doesNotMatch(markup, /未归属的文档/, "the internal placeholder goal must never reach the strip");
  assert.match(markup, /未关联/, "an unattached window is labelled as such");
  // Exactly one chip on the strip: the 未关联 marker. The document tab has none.
  assert.equal((markup.match(/class="tab-task/g) ?? []).length, 1);
});

test("a conversation prefix appears only when two conversations are open", () => {
  // The prefix exists to tell two same-named documents apart. A standalone
  // window used to count as a second "task", so opening one editor on its own
  // put a conversation prefix on every other tab for no reason.
  const withLoose = buildTabs({
    tabs: [
      chatTab("task-a", "甲"),
      appTab("task-a", "app_1", "a.md", { taskGoal: "甲", hasResource: true }),
      {
        tabId: "application:workspace:app_2",
        kind: "application",
        taskId: "workspace",
        appInstanceId: "app_2",
        appType: "text-editor",
        title: "文本编辑器",
        standalone: true,
        hasResource: false
      }
    ]
  });
  assert.deepEqual(
    withLoose.tabs.map((tab) => tab.taskLabel),
    [undefined, undefined, undefined],
    "a standalone window is not a second conversation"
  );

  // Two real conversations is the case the prefix is for.
  const twoChats = buildTabs({
    tabs: [
      chatTab("task-a", "甲"),
      appTab("task-a", "app_1", "方案.md", { taskGoal: "甲", hasResource: true }),
      chatTab("task-b", "乙"),
      appTab("task-b", "app_2", "方案.md", { taskGoal: "乙", hasResource: true })
    ]
  });
  assert.deepEqual(
    twoChats.tabs.map((tab) => tab.taskLabel),
    [undefined, "甲", undefined, "乙"]
  );
});

test("a conversation being composed holds its own place in the strip", async () => {
  // The bug this pins: 新对话 created no tab, so the strip went on highlighting
  // the previous conversation while the composer was writing a different one.
  // A conversation is a tab exactly as an application is; the only difference
  // is that this one has no task id yet.
  const { draftConversationTab, DRAFT_TAB_ID } = await import("../web/assets/workbench/host.js");
  const draft = draftConversationTab();
  assert.equal(draft.kind, "conversation");
  assert.equal(draft.taskId, null, "a draft has no task until its first message");

  const { tabs, activeTabId } = buildTabs({
    tabs: [chatTab("task-a", "旧对话"), draft],
    activeTabId: DRAFT_TAB_ID
  });
  assert.deepEqual(
    tabs.map((tab) => tab.tabId),
    ["conversation:task-a", DRAFT_TAB_ID]
  );
  assert.equal(activeTabId, DRAFT_TAB_ID, "the draft is what is in front, not the previous conversation");
  assert.equal(tabs[1].draft, true);
  assert.equal(tabs[0].draft, false);

  const markup = renderTabStrip({ tabs, activeTabId });
  assert.match(markup, /新对话/);
  assert.match(markup, /is-draft/);
  // A draft is not a second conversation for labelling purposes: it owns no
  // documents, so it must not start prefixing the real conversation's tabs.
  const withDocument = buildTabs({
    tabs: [
      chatTab("task-a", "甲"),
      appTab("task-a", "app_1", "a.md", { taskGoal: "甲", hasResource: true }),
      draft
    ]
  });
  assert.deepEqual(
    withDocument.tabs.map((tab) => tab.taskLabel),
    [undefined, undefined, undefined]
  );
});

test("every tab closes, including a conversation", () => {
  // Closing a conversation tab closes a view; the task itself is untouched.
  const { tabs } = buildTabs({ tabs: [chatTab("task-a", "甲"), appTab("task-a", "app_1", "a.md")] });
  assert.equal(
    tabs.every((tab) => tab.closable),
    true
  );
  const markup = renderTabStrip({ tabs, activeTabId: tabs[0].tabId });
  assert.equal((markup.match(/data-close-tab=/g) ?? []).length, 2);
});

test("unsaved drafts and unread Agent changes are separate markers", () => {
  const tab = appTab("task-a", "app_1", "doc.md", { unread: 3 });
  const { tabs } = buildTabs({ tabs: [tab], drafts: new Map([[tab.tabId, true]]) });
  assert.equal(tabs[0].dirty, true, "a local draft is not the same as an unread change");
  assert.equal(tabs[0].unread, 3);

  const markup = renderTabStrip({ tabs, activeTabId: tab.tabId });
  assert.match(markup, /tab-dirty/);
  assert.match(markup, /class="tab-unread"[^>]*>3</);
  // Saved work with pending Agent reads shows only the count.
  const saved = buildTabs({ tabs: [appTab("task-a", "app_1", "doc.md", { unread: 2 })] });
  assert.equal(saved.tabs[0].dirty, false);
  assert.doesNotMatch(renderTabStrip({ ...saved, activeTabId: saved.tabs[0].tabId }), /tab-dirty/);
  // A conversation tab has no resource, so nothing can be unread on it.
  assert.equal(buildTabs({ tabs: [chatTab("task-a", "甲")] }).tabs[0].unread, 0);
});

test("an active tab that no longer exists falls back to the first open one", () => {
  const { activeTabId } = buildTabs({
    tabs: [chatTab("task-a", "甲")],
    activeTabId: "application:task-z:gone"
  });
  assert.equal(activeTabId, "conversation:task-a");
  const kept = buildTabs({ tabs: [chatTab("task-a", "甲")], activeTabId: "conversation:task-a" });
  assert.equal(kept.activeTabId, "conversation:task-a");
  // An empty strip has nothing to activate, and says so rather than rendering blank.
  assert.equal(buildTabs({ tabs: [] }).activeTabId, undefined);
  assert.match(renderTabStrip(buildTabs({ tabs: [] })), /没有打开的标签/);
});

test("tab titles and task labels from the server are escaped", () => {
  const hostile = '<img src=x onerror=alert(1)>" onmouseover="alert(2)';
  const { tabs, activeTabId } = buildTabs({
    tabs: [appTab("task-a", "app_1", hostile, { taskGoal: hostile })]
  });
  const markup = renderTabStrip({ tabs, activeTabId });
  assert.equal(markup.includes("<img"), false);
  assert.equal(markup.includes('onmouseover="alert'), false);
  for (const value of [...markup.matchAll(/"([^"]*)"/g)].map((entry) => entry[1])) {
    assert.equal(value.includes("<"), false, `attribute value must not contain a raw <: ${value}`);
  }
  // Nested buttons are invalid HTML and get hoisted out of their tab.
  assert.equal(markup.includes("<button"), false);
});

test("the binding control names the bound application and offers detaching", () => {
  const instances = [instance("app_1", "产品方案.md", "res_1"), instance("app_2", "会议记录.md", "res_2")];
  const bound = bindingModel({ instances, boundResourceId: "res_2" });
  assert.equal(bound.selected, "app_2");
  assert.equal(bound.label, "会议记录.md", "the button must say which resource the next message refers to");
  assert.equal(bound.available, true);

  const markup = renderBindingMenu(bound, { appLabels: { "text-editor": "文本编辑器" } });
  assert.match(markup, /data-bind-instance="app_1"/);
  assert.match(markup, /aria-selected="true" data-bind-instance="app_2"/);
  // Detaching is an option, not the absence of one.
  assert.match(markup, new RegExp(`data-bind-instance="${UNBOUND}"`));
  assert.match(markup, /不加载应用/);
  const { document } = parseHTML(markup);
  assert.deepEqual(
    [...document.querySelectorAll(".model-option-name")].map((node) => node.textContent),
    ["产品方案.md", "会议记录.md", "不加载应用"]
  );
  const selected = document.querySelector('[data-bind-instance="app_2"]');
  assert.equal(selected.querySelector(".binding-option-icon use").getAttribute("href"), "#i-file");
  assert.equal(selected.querySelector(".model-option-check use").getAttribute("href"), "#i-check");
  assert.equal(selected.getAttribute("aria-description"), "文本编辑器");
  assert.doesNotMatch(markup, /本轮对话加载|<small/);
});

test("with no application open the control stays reachable and says so", () => {
  // Hiding the control here removed the only way to bind an application, which
  // left the feature unreachable exactly when the user wanted it.
  const model = bindingModel({ instances: [] });
  assert.equal(model.available, true, "the control must not disappear");
  assert.equal(model.hasOptions, false);
  assert.equal(model.selected, undefined);
  assert.equal(model.label, "没有打开的应用");
  const markup = renderBindingMenu(model);
  assert.match(markup, /当前工作区没有打开的应用/);
  const { document } = parseHTML(markup);
  assert.equal(document.querySelector("[data-bind-open-apps]"), null, "applications open from attachments");
  assert.equal(markup.includes("data-bind-instance"), false, "there is nothing to select yet");

  // A closed tab is not bindable either, and reads the same way.
  const closed = bindingModel({ instances: [instance("app_1", "closed.md", "res_1", "closed")] });
  assert.equal(closed.hasOptions, false);
  assert.equal(closed.available, true);
});

test("the binding offers only the current conversation's applications", () => {
  // The strip spans several tasks, so the control must not offer another
  // conversation's document as something this one can be bound to.
  const stale = bindingModel({
    instances: [instance("app_1", "上一个对话.md", "res_1")],
    boundResourceId: "res_1"
  });
  assert.equal(stale.selected, "app_1");
  const fresh = bindingModel();
  assert.equal(fresh.selected, undefined);
  assert.equal(fresh.hasOptions, false);
  assert.equal(fresh.label, "没有打开的应用");
});

test("unbound is one state, and the detach row is what shows it", () => {
  const instances = [instance("app_1", "a.md", "res_1")];
  // There is no fallback to guess around any more, so "never bound" and
  // "detached" are the same thing and must read the same way.
  assert.equal(bindingModel({ instances }).label, "未加载应用");
  assert.equal(bindingModel({ instances }).label, "未加载应用");
  assert.match(
    renderBindingMenu(bindingModel({ instances })),
    /aria-selected="true" data-bind-instance="__unbound__"/
  );
});

test("a binding pointing at a tab that no longer exists falls back to unbound", () => {
  const model = bindingModel({
    instances: [instance("app_1", "a.md", "res_1")],
    boundResourceId: "res_gone"
  });
  assert.equal(model.selected, undefined);
  assert.match(renderBindingMenu(model), new RegExp(`aria-selected="true" data-bind-instance="${UNBOUND}"`));
});

test("binding menu titles from the server are escaped", () => {
  const markup = renderBindingMenu(
    bindingModel({
      instances: [instance("app_1", '"><script>alert(1)</script>', "res_1")],
      boundResourceId: "res_1"
    })
  );
  assert.equal(markup.includes("<script"), false);
  for (const value of [...markup.matchAll(/"([^"]*)"/g)].map((entry) => entry[1])) {
    assert.equal(value.includes("<"), false, `attribute must not contain a raw <: ${value}`);
  }
});

test("a window opened on its own remains selectable beside existing documents", () => {
  // The bug this pins: options were filtered to the selected conversation's own
  // windows, so an editor opened standalone — the one case where binding is the
  // whole point — could never be selected.
  const model = bindingModel({
    instances: [
      {
        appInstanceId: "app_own",
        appType: "text-editor",
        title: "方案.md",
        resourceIds: ["res_1"],
        resourceId: "res_1",
        status: "open"
      },
      {
        appInstanceId: "app_loose",
        appType: "text-editor",
        title: "草稿.md",
        resourceIds: ["res_2"],
        resourceId: "res_2",
        status: "open",
        standalone: true,
        taskId: "workspace"
      }
    ],
    boundResourceId: undefined
  });
  assert.deepEqual(
    model.options.map((option) => option.value),
    ["app_own", "app_loose"]
  );
  assert.equal(model.hasStandalone, true);
  assert.equal(model.options[1].standalone, true);

  const markup = renderBindingMenu(model, { appLabels: { "text-editor": "文本编辑器" } });
  assert.doesNotMatch(markup, /同一工作区的其他应用实例|可加载到本对话|<small/);
  assert.match(markup, /data-bind-instance="app_loose"/);
  // And detaching is still reachable.
  assert.match(markup, /不加载应用/);
});

test("with only standalone windows the menu still offers them", () => {
  // A brand-new conversation has no windows of its own; if that rendered the
  // empty state the user could not attach the editor they already had open.
  const model = bindingModel({
    instances: [
      {
        appInstanceId: "app_loose",
        appType: "text-editor",
        title: "草稿.md",
        resourceIds: ["res_1"],
        resourceId: "res_1",
        status: "open",
        standalone: true,
        taskId: "workspace"
      }
    ]
  });
  assert.equal(model.hasOptions, true);
  assert.match(renderBindingMenu(model), /data-bind-instance="app_loose"/);
  assert.doesNotMatch(renderBindingMenu(model), /当前工作区没有打开的应用/);
});

test("the binding menu keeps unavailable tools in its tooltip and accessible description", () => {
  // A failed server means the Agent has fewer ways to help with this
  // application. Left silent, a user reads that as the Agent being unhelpful.
  const working = bindingModel({
    instances: [
      {
        appInstanceId: "app_1",
        appType: "text-editor",
        title: "方案.md",
        resourceIds: ["res_1"],
        resourceId: "res_1",
        status: "open",
        mcp: { state: "running", toolNames: ["outline_document", "replace_section"] }
      }
    ]
  });
  assert.doesNotMatch(renderBindingMenu(working, { appLabels: { "text-editor": "文本编辑器" } }), /专用工具/);

  const broken = bindingModel({
    instances: [
      {
        appInstanceId: "app_1",
        appType: "text-editor",
        title: "方案.md",
        resourceIds: ["res_1"],
        resourceId: "res_1",
        status: "open",
        mcp: { state: "failed", toolNames: [], error: "spawn ENOENT" }
      }
    ]
  });
  const brokenMarkup = renderBindingMenu(broken, { appLabels: { "text-editor": "文本编辑器" } });
  const { document } = parseHTML(brokenMarkup);
  const option = document.querySelector('[data-bind-instance="app_1"]');
  assert.equal(option.getAttribute("title"), "方案.md · 专用工具不可用");
  assert.equal(option.getAttribute("aria-description"), "文本编辑器，专用工具不可用");
  assert.equal(option.textContent.trim(), "方案.md");
  assert.doesNotMatch(brokenMarkup, /spawn ENOENT|<small/);

  // An application with no server declared says nothing extra — most do not
  // have one, and a note on every row would be noise.
  const plain = bindingModel({
    instances: [
      {
        appInstanceId: "app_1",
        appType: "text-editor",
        title: "方案.md",
        resourceIds: ["res_1"],
        resourceId: "res_1",
        status: "open"
      }
    ]
  });
  const markup = renderBindingMenu(plain, { appLabels: { "text-editor": "文本编辑器" } });
  assert.doesNotMatch(markup, /专用工具/);
  // A running server with no tools is the same: nothing worth saying.
  const empty = bindingModel({
    instances: [
      {
        appInstanceId: "app_1",
        appType: "text-editor",
        title: "方案.md",
        resourceIds: ["res_1"],
        resourceId: "res_1",
        status: "open",
        mcp: { state: "running", toolNames: [] }
      }
    ]
  });
  assert.doesNotMatch(renderBindingMenu(empty), /专用工具/);
});

test("every selection reaches the caller, because binding and opening are one act", async () => {
  // The control used to switch the binding itself for this conversation's own
  // windows and hand over only the rest — and a standalone window is not one
  // of this conversation's instances, so the server answered 404 and the
  // adoption never ran. There is no fork now: opening a document's tab and
  // naming the conversation are one request, so the caller performs it.
  const { createBindingControl } = await import("../web/assets/workbench/binding.js");
  const { parseHTML } = await import("linkedom");
  const { document } = parseHTML('<button id="b"><span class="n"></span></button><div id="m" hidden></div>');
  const calls = [];
  const selected = [];
  const control = createBindingControl({
    button: document.querySelector("#b"),
    menu: document.querySelector("#m"),
    label: document.querySelector(".n"),
    api: {
      setActiveInstance: async (taskId, id) => {
        calls.push(`setActive:${id}`);
      },
      unbind: async () => {
        calls.push("unbind");
      }
    },
    getTaskId: () => "task-1",
    onSelect: (id, option) => selected.push([id, option?.standalone === true])
  });
  control.update({
    instances: [
      {
        appInstanceId: "app_own",
        appType: "text-editor",
        title: "本对话的.md",
        resourceIds: ["res_1"],
        resourceId: "res_1",
        status: "open"
      },
      {
        appInstanceId: "app_loose",
        appType: "text-editor",
        title: "草稿.md",
        resourceIds: ["res_2"],
        resourceId: "res_2",
        status: "open",
        standalone: true,
        taskId: "workspace"
      }
    ]
  });
  control.open();

  const row = (id) => document.querySelector(`[data-bind-instance="${id}"]`);
  row("app_loose").dispatchEvent(new document.defaultView.Event("click", { bubbles: true }));
  await new Promise((settle) => setTimeout(settle, 10));
  assert.deepEqual(calls, [], "the control makes no request of its own");
  assert.deepEqual(selected, [["app_loose", true]], "the unattached document is handed over");

  // And so is one this conversation already references.
  control.open();
  row("app_own").dispatchEvent(new document.defaultView.Event("click", { bubbles: true }));
  await new Promise((settle) => setTimeout(settle, 10));
  assert.deepEqual(calls, []);
  assert.deepEqual(selected[1], ["app_own", false]);
});

test("same-workspace instances remain loadable without implying conversation ownership", async () => {
  // The bug this pins, reported twice: a txt created while some conversation
  // was open belongs to that conversation. The menu offered only this
  // conversation's windows and unattached ones, so from a new conversation the
  // document was unreachable — "还没有打开的应用" while it sat in the strip.
  const model = bindingModel({
    instances: [
      instance("app_own", "本对话的.md", "res_1"),
      {
        ...instance("app_other", "别处的.md", "res_2"),
        standalone: true,
        elsewhere: true,
        taskId: "task-b",
        taskGoal: "另一个任务"
      },
      { ...instance("app_loose", "草稿.md", "res_3"), standalone: true, taskId: "workspace" }
    ]
  });
  assert.deepEqual(
    model.options.map((option) => option.value),
    ["app_own", "app_other", "app_loose"]
  );

  const markup = renderBindingMenu(model, { appLabels: { "text-editor": "文本编辑器" } });
  // Loading references an instance without presenting another chat as its owner.
  assert.doesNotMatch(markup, /同一工作区的其他应用实例|来自「另一个任务」|可加载到本对话/);
  const { document } = parseHTML(markup);
  assert.deepEqual(
    [...document.querySelectorAll("[data-bind-instance]")].map((node) => node.dataset.bindInstance),
    ["app_own", "app_other", "app_loose", UNBOUND]
  );
});

test("the control never issues a binding request itself, with or without a conversation", async () => {
  // It used to switch the binding for this conversation's own windows, which
  //404'd for anything else and made the menu item silently do nothing. And
  // from a draft — no task at all — it returned early, so selecting a document
  // did nothing whatsoever: no adoption, no error, no request.
  const { createBindingControl } = await import("../web/assets/workbench/binding.js");
  const { parseHTML } = await import("linkedom");
  const { document } = parseHTML('<button id="b"><span class="n"></span></button><div id="m" hidden></div>');
  const calls = [];
  const selected = [];
  let currentTask = "task-a";
  const control = createBindingControl({
    button: document.querySelector("#b"),
    menu: document.querySelector("#m"),
    label: document.querySelector(".n"),
    api: {
      setActiveInstance: async (taskId, id) => {
        calls.push(`setActive:${id}`);
      },
      unbind: async () => {
        calls.push("unbind");
      }
    },
    getTaskId: () => currentTask,
    onSelect: (id) => selected.push(id)
  });
  const instances = [
    instance("app_own", "本对话的.md", "res_1"),
    { ...instance("app_other", "别处的.md", "res_2"), standalone: true, elsewhere: true, taskId: "task-b" }
  ];
  const click = (id) => {
    control.open();
    document
      .querySelector(`[data-bind-instance="${id}"]`)
      .dispatchEvent(new document.defaultView.Event("click", { bubbles: true }));
    return new Promise((settle) => setTimeout(settle, 10));
  };

  control.update({ instances });
  await click("app_other");
  assert.deepEqual(calls, [], "the control issues no request of its own");
  assert.deepEqual(selected, ["app_other"], "the choice is handed over");

  await click("app_own");
  assert.deepEqual(calls, []);

  // From a draft there is no task at all, and selecting must still act.
  currentTask = undefined;
  control.update({ instances });
  await click("app_own");
  assert.deepEqual(calls, [], "still nothing attempted without a conversation");
  assert.deepEqual(selected, ["app_other", "app_own", "app_own"], "but every choice reaches the caller");
});
