/**
 * The workbench's HTTP client.
 *
 * It exists so the error `code` survives the trip: the editor's conflict
 * handling depends on telling `revision_conflict` apart from a network
 * failure, and a client that flattened everything to a message string would
 * make that impossible.
 */
class ApplicationRequestError extends Error {
  constructor(code, message, details, retryable, status) {
    super(message);
    this.name = "ApplicationRequestError";
    this.code = code;
    this.details = details;
    this.retryable = Boolean(retryable);
    this.status = status;
  }
}

async function defaultRequest(path, options) {
  const response = await fetch(path, options);
  const body = await response.json().catch((error) => {
    // A successful status with an interrupted/malformed body is not a
    // successful operation. In particular, aborting after response headers
    // must not turn a cancelled preview into an empty geometry result.
    if (response.ok) throw error;
    return {};
  });
  if (response.ok) return body;
  const error = body?.error;
  if (error && typeof error === "object") {
    throw new ApplicationRequestError(
      error.code,
      error.message || response.statusText,
      error.details,
      error.retryable,
      response.status
    );
  }
  throw new ApplicationRequestError(
    "request_failed",
    typeof error === "string" ? error : response.statusText,
    undefined,
    false,
    response.status
  );
}

function post(body) {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {})
  };
}

const task = (taskId) => `/api/tasks/${encodeURIComponent(taskId)}`;
const resource = (taskId, resourceId) => `${task(taskId)}/resources/${encodeURIComponent(resourceId)}`;

const resourcesPath = (taskId, workspaceRoot) =>
  `${task(taskId)}/resources${taskId === "workspace" && workspaceRoot ? `?workspaceRoot=${encodeURIComponent(workspaceRoot)}` : ""}`;

/** Default byte reader for hosts that did not supply the shared client. */
async function defaultFetchBytes(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error("无法读取文件");
  return { blob: await response.blob() };
}

export function createApplicationApi({
  handoffToConversation,
  openResourceInTab,
  createAndOpen,
  onDocumentCreated,
  isStandaloneTask,
  bindToConversation,
  request: requestImpl = defaultRequest,
  fetchBytes = defaultFetchBytes
} = {}) {
  // Every call belongs to the page's bound backend and carries its session.
  const request = requestImpl;
  return {
    readBytes: (url, signal) => fetchBytes(url, signal),
    listWorkspaces: () => request("/api/workbench/workspaces"),
    chooseWorkspace: (workspaceRoot) => request("/api/workbench/workspaces", post({ workspaceRoot })),
    listTemporaryResources: () => request("/api/workbench/temporary-resources"),
    listApplications: () => request("/api/applications"),
    // The strip is global: it is not nested under a task, because a tab's task
    // is a property of the tab.
    listTabs: () => request("/api/workbench/tabs"),
    listApplicationRevisions: (signal, instanceIds) => {
      const query = new URLSearchParams();
      for (const id of instanceIds || []) query.append("appInstanceId", id);
      return request(`/api/workbench/revisions${query.size ? `?${query}` : ""}`, { signal });
    },
    openTab: (body) => request("/api/workbench/tabs", post(body)),
    // `null` records "no tab in front", which a new conversation needs.
    activateTab: (tabId) =>
      request("/api/workbench/tabs", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tabId: tabId ?? null })
      }),
    closeTab: (tabId) =>
      request("/api/workbench/tabs", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tabId })
      }),
    taskSummary: (taskId) => request(`${task(taskId)}/app-instances`),
    listResources: (taskId, workspaceRoot) => request(resourcesPath(taskId, workspaceRoot)),
    createResource: (taskId, body, workspaceRoot) =>
      request(resourcesPath(taskId, workspaceRoot), post(body)),
    // Ordinary imports are read by the server. File formats requiring a UI
    // Adapter send its complete converted content with the indexed source hash.
    importArtifact: (taskId, relativePath, converted) =>
      request(`${task(taskId)}/resources`, post({ ...converted, fromArtifact: relativePath })),
    readResource: (taskId, resourceId, options = {}) => {
      const search = new URLSearchParams();
      if (options.afterRevision !== undefined) search.set("afterRevision", String(options.afterRevision));
      if (options.limit !== undefined) search.set("limit", String(options.limit));
      const query = search.toString();
      return request(`${resource(taskId, resourceId)}${query ? `?${query}` : ""}`);
    },
    reviewResource: (taskId, resourceId) => request(`${resource(taskId, resourceId)}/review`),
    previewResource: (taskId, resourceId, content, options, signal) =>
      request(`${resource(taskId, resourceId)}/preview`, { ...post({ content, options }), signal }),
    applyOperation: (taskId, resourceId, body) =>
      request(`${resource(taskId, resourceId)}/operations`, post(body)),
    executeResourceCommand: (taskId, resourceId, body, signal) =>
      request(`${resource(taskId, resourceId)}/commands`, { ...post(body), signal }),
    attachmentUrl: (taskId, resourceId, name, revision) =>
      `${resource(taskId, resourceId)}/attachments/${encodeURIComponent(name)}?revision=${encodeURIComponent(revision)}`,
    importNativeResource: (taskId, resourceId, file, revision, operationId, signal) =>
      request(
        `${resource(taskId, resourceId)}/import-native?revision=${encodeURIComponent(revision)}&operationId=${encodeURIComponent(operationId)}`,
        { method: "POST", headers: { "content-type": "application/octet-stream" }, body: file, signal }
      ),
    // A URL rather than a call: page unload cancels fetch, so the last-resort
    // flush needs something it can hand to sendBeacon.
    operationsUrl: (taskId, resourceId) => `${resource(taskId, resourceId)}/operations`,
    listProjects: () => request("/api/tasks"),
    saveCopy: (taskId, resourceId, body) => request(`${resource(taskId, resourceId)}/save-copy`, post(body)),
    saveSourceFile: (taskId, resourceId, revision) =>
      request(`${resource(taskId, resourceId)}/save-source`, post({ revision })),
    undo: (taskId, resourceId, appInstanceId, expected = {}) =>
      request(`${resource(taskId, resourceId)}/undo`, post({ appInstanceId, ...expected })),
    saveSelection: (taskId, resourceId, body) =>
      request(`${resource(taskId, resourceId)}/selection`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      }),
    renameResource: (taskId, resourceId, title) =>
      request(resource(taskId, resourceId), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title })
      }),
    // A URL rather than a fetch: the browser has to own the download so the
    // person's own save dialog and folder choice apply.
    downloadUrl: (taskId, resourceId, format) =>
      `${resource(taskId, resourceId)}/download?format=${encodeURIComponent(format)}`,
    downloadResource: async (taskId, resourceId, format, signal) => {
      const { blob, fileName } = await fetchBytes(
        `${resource(taskId, resourceId)}/download?format=${encodeURIComponent(format)}`,
        signal
      );
      return { blob, fileName: fileName || `export.${format}` };
    },
    unbind: (taskId) => request(`${task(taskId)}/app-instances/unbind`, post({})),
    // Opening the application, not a document: the window may start empty.
    openApplication: (taskId, appType) => request(`${task(taskId)}/app-instances/open`, post({ appType })),
    // Independent launches allocate durable temporary storage by default;
    // callers can explicitly supply a persistent workspace.
    openStandaloneApplication: (appType, workspaceRoot) =>
      request("/api/workbench/open-application", post({ appType, workspaceRoot })),
    // Load the same instance into another conversation in its owning workspace.
    bindResourceToTask: (body) =>
      request(
        "/api/workbench/load-instance",
        post({
          taskId: body.taskId,
          appInstanceId: body.appInstanceId ?? body.fromAppInstanceId,
          resourceId: body.resourceId
        })
      ),
    createInApplication: (taskId, appInstanceId, body, signal) => {
      const path = `/api/workbench/instances/${encodeURIComponent(appInstanceId)}/resources`;
      if (body.nativeFile) {
        const query = new URLSearchParams({ kind: body.kind, title: body.title });
        if (body.sourceFile) {
          query.set("sourcePath", body.sourceFile.path);
          query.set("sourceVersion", body.sourceFile.contentVersion);
        }
        return request(`${path}?${query}`, {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: body.nativeFile,
          signal
        });
      }
      return request(path, { ...post(body), signal });
    },
    openResource: (taskId, resourceId) => request(`${resource(taskId, resourceId)}/open`, post({})),
    setActiveInstance: (taskId, appInstanceId) =>
      request(`${task(taskId)}/app-instances/${encodeURIComponent(appInstanceId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ active: true, status: "open" })
      }),
    closeInstance: (taskId, appInstanceId) =>
      request(`${task(taskId)}/app-instances/${encodeURIComponent(appInstanceId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "closed" })
      }),
    handoffToConversation,
    openResourceInTab,
    createAndOpen,
    // Named differently from the HTTP method above on purpose: a host callback
    // sharing that name overwrote it in this object, so calling it recursed
    // into itself instead of reaching the server.
    onDocumentCreated,
    isStandaloneTask,
    bindToConversation
  };
}

export { ApplicationRequestError };
