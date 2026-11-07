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

test("PDF viewer rejects forged, non-PDF and oversized payloads", () => {
  const { validatePdfPayload, MAX_PDF_BYTES } = createRequire(import.meta.url)(
    "../desktop/artifact-viewer.cjs"
  );
  const pdf = new TextEncoder().encode("%PDF-1.4\nfixture").buffer;
  assert.equal(validatePdfPayload({ mime: "application/pdf", bytes: pdf }).byteLength, pdf.byteLength);
  for (const payload of [
    null,
    { mime: "text/html", bytes: pdf },
    { mime: "application/pdf", bytes: new TextEncoder().encode("<script>bad</script>").buffer },
    { mime: "application/pdf", bytes: new ArrayBuffer(0) },
    { mime: "application/pdf", bytes: new ArrayBuffer(MAX_PDF_BYTES + 1) }
  ])
    assert.throws(() => validatePdfPayload(payload));
});

test("isolated PDF source blocks unrelated network and releases document", async () => {
  const { installPdfSession, PDF_VIEWER_URL } = createRequire(import.meta.url)(
    "../desktop/artifact-viewer.cjs"
  );
  let requestHandler, protocolHandler, downloadHandler, permissionCheck, permissionRequest;
  let clears = 0;
  const session = {
    protocol: {
      handle: (_scheme, handler) => {
        protocolHandler = handler;
      },
      unhandle: () => {}
    },
    webRequest: {
      onBeforeRequest: (_filter, handler) => {
        requestHandler = handler;
      }
    },
    setPermissionCheckHandler: (handler) => {
      permissionCheck = handler;
    },
    setPermissionRequestHandler: (handler) => {
      permissionRequest = handler;
    },
    on: (_name, handler) => {
      downloadHandler = handler;
    },
    removeListener: () => {},
    clearStorageData: async () => {
      clears += 1;
    },
    clearCache: async () => {
      clears += 1;
    }
  };
  const bytes = new TextEncoder().encode("%PDF-1.4\nfixture").buffer;
  const release = installPdfSession(session, bytes);
  const request = (url) => new Promise((resolve) => requestHandler({ url }, resolve));
  assert.equal((await request(PDF_VIEWER_URL)).cancel, false);
  for (const url of [
    "https://example.invalid/",
    "http://127.0.0.1:1234/",
    "file:///tmp/x",
    "wss://example.invalid/"
  ])
    assert.equal((await request(url)).cancel, true);
  const response = await protocolHandler({ url: PDF_VIEWER_URL });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(await response.text(), /^%PDF-/);
  assert.equal(permissionCheck(), false);
  let granted;
  permissionRequest(null, "notifications", (result) => {
    granted = result;
  });
  assert.equal(granted, false);
  let cancelled = false;
  downloadHandler({
    preventDefault: () => {
      cancelled = true;
    }
  });
  assert.equal(cancelled, true);
  const first = release();
  assert.equal(release(), first);
  await first;
  assert.equal(clears, 2);
  assert.equal((await protocolHandler({ url: PDF_VIEWER_URL })).status, 410);
  assert.equal((await request(PDF_VIEWER_URL)).cancel, true);
});

test("PDF cleanup still clears cache after storage cleanup fails", async () => {
  const { installPdfSession } = createRequire(import.meta.url)("../desktop/artifact-viewer.cjs");
  let cacheClears = 0;
  const session = {
    protocol: { handle: () => {}, unhandle: () => {} },
    webRequest: { onBeforeRequest: () => {} },
    setPermissionCheckHandler: () => {},
    setPermissionRequestHandler: () => {},
    on: () => {},
    removeListener: () => {},
    clearStorageData: async () => {
      throw new Error("storage cleanup failed");
    },
    clearCache: async () => {
      cacheClears += 1;
    }
  };
  const release = installPdfSession(session, new TextEncoder().encode("%PDF-test"));
  const first = release();
  await assert.rejects(first, /storage cleanup failed/);
  await assert.rejects(release(), /storage cleanup failed/);
  assert.equal(cacheClears, 1);
});

test("PDF setup failure removes installed resources and clears document", async () => {
  const { installPdfSession, PDF_VIEWER_URL } = createRequire(import.meta.url)(
    "../desktop/artifact-viewer.cjs"
  );
  let protocolHandler;
  const calls = [];
  const session = {
    protocol: {
      handle: (_scheme, handler) => {
        protocolHandler = handler;
      },
      unhandle: () => calls.push("unhandle")
    },
    webRequest: { onBeforeRequest: () => {} },
    setPermissionCheckHandler: () => {
      throw new Error("permission setup failed");
    },
    setPermissionRequestHandler: () => {},
    on: () => {},
    removeListener: () => calls.push("remove-listener"),
    clearStorageData: async () => {
      calls.push("clear-storage");
    },
    clearCache: async () => {
      calls.push("clear-cache");
    }
  };
  assert.throws(
    () => installPdfSession(session, new TextEncoder().encode("%PDF-test")),
    /permission setup failed/
  );
  assert.equal((await protocolHandler({ url: PDF_VIEWER_URL })).status, 410);
  assert.deepEqual(calls, ["unhandle", "remove-listener", "clear-storage", "clear-cache"]);
});

test("PDF release attempts all cleanup when operations throw synchronously", async () => {
  const { installPdfSession, PDF_VIEWER_URL } = createRequire(import.meta.url)(
    "../desktop/artifact-viewer.cjs"
  );
  const calls = [];
  let protocolHandler;
  const session = {
    protocol: {
      handle: (_scheme, handler) => {
        protocolHandler = handler;
      },
      unhandle: () => {
        calls.push("unhandle");
        throw new Error("unhandle failed");
      }
    },
    webRequest: { onBeforeRequest: () => {} },
    setPermissionCheckHandler: () => {},
    setPermissionRequestHandler: () => {},
    on: () => {},
    removeListener: () => {
      calls.push("remove-listener");
      throw new Error("remove failed");
    },
    clearStorageData: () => {
      calls.push("clear-storage");
      throw new Error("storage failed");
    },
    clearCache: () => {
      calls.push("clear-cache");
      return Promise.resolve();
    }
  };
  const release = installPdfSession(session, new TextEncoder().encode("%PDF-test"));
  const first = release();
  assert.equal(release(), first);
  await assert.rejects(first, /PDF session cleanup failed/);
  assert.equal((await protocolHandler({ url: PDF_VIEWER_URL })).status, 410);
  assert.deepEqual(calls, ["unhandle", "remove-listener", "clear-storage", "clear-cache"]);
});

test("reentrant PDF close shares the in-progress cleanup", async () => {
  const { installPdfSession } = createRequire(import.meta.url)("../desktop/artifact-viewer.cjs");
  let release,
    reentered,
    unhandles = 0;
  const session = {
    protocol: {
      handle: () => {},
      unhandle: () => {
        unhandles += 1;
        if (unhandles === 1) reentered = release();
      }
    },
    webRequest: { onBeforeRequest: () => {} },
    setPermissionCheckHandler: () => {},
    setPermissionRequestHandler: () => {},
    on: () => {},
    removeListener: () => {},
    clearStorageData: async () => {},
    clearCache: async () => {}
  };
  release = installPdfSession(session, new TextEncoder().encode("%PDF-test"));
  const first = release();
  assert.equal(reentered, first);
  await first;
  assert.equal(unhandles, 1);
});
