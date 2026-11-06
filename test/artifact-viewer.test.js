import assert from "node:assert/strict";
import { test } from "node:test";
import { createArtifactViewer, isArtifactRawPath } from "../web/assets/controllers/artifact-viewer.js";

const path = "/api/tasks/t1/artifact?path=report.md&raw=1";

function fixture({
  read = async () => ({ blob: new Blob(["from A"], { type: "text/markdown" }) }),
  open
} = {}) {
  let identity = { backendId: "A", baseUrl: "", sessionId: "one", status: "connected" };
  let closed;
  const sent = [],
    revoked = [],
    blobs = [];
  const host = {
    open: async (url) => {
      sent.push(url);
      await open?.(url);
    },
    onClosed: (handler) => {
      closed = handler;
      return () => {
        closed = undefined;
      };
    }
  };
  const viewer = createArtifactViewer({
    read,
    identity: () => identity,
    host,
    createObjectURL: (blob) => {
      blobs.push(blob);
      return `blob:http://127.0.0.1:1234/${blobs.length}`;
    },
    revokeObjectURL: (url) => revoked.push(url)
  });
  return {
    viewer,
    sent,
    revoked,
    blobs,
    close: (url) => closed?.(url),
    setIdentity: (value) => {
      identity = value;
    }
  };
}

test("artifact viewer opens session bytes and releases only its own closed URLs", async () => {
  const f = fixture();
  await f.viewer.open(path);
  assert.equal(await f.blobs[0].text(), "from A");
  assert.equal(f.blobs[0].type, "text/plain");
  assert.deepEqual(f.sent, ["blob:http://127.0.0.1:1234/1"]);
  f.close("blob:http://127.0.0.1:1234/foreign");
  assert.deepEqual(f.revoked, []);
  f.close(f.sent[0]);
  assert.deepEqual(f.revoked, f.sent);
  f.viewer.dispose();
  assert.equal(f.revoked.length, 1);
});

test("a pending file cannot open after backend switch or a failed viewer request", async () => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const f = fixture({ read: () => held });
  const pending = f.viewer.open(path);
  f.setIdentity({ backendId: "B", baseUrl: "", sessionId: "two", status: "connected" });
  release({ blob: new Blob(["old"]) });
  await assert.rejects(pending, /切换后端/);
  assert.deepEqual(f.sent, []);
  assert.deepEqual(f.blobs, []);
  const rejected = fixture({
    open: () => {
      throw new Error("viewer failed");
    }
  });
  await assert.rejects(rejected.viewer.open(path), /viewer failed/);
  assert.deepEqual(rejected.revoked, rejected.sent);
});

test("only local raw task-artifact routes can be sent to the viewer", () => {
  assert.equal(isArtifactRawPath(path), true);
  for (const invalid of [
    "blob:http://127.0.0.1:1234/id",
    "https://example.com/api/tasks/t1/artifact?path=x&raw=1",
    "/api/tasks/t1/artifact?path=x&download=1",
    "/api/tasks/t1/artifact?path=x&raw=1&raw=0",
    "/api/uploads/x"
  ])
    assert.equal(isArtifactRawPath(invalid), false);
});

test("PDF and SVG keep their media type in the sandboxed host; reset releases viewers", async () => {
  for (const type of ["application/pdf", "image/svg+xml"]) {
    const f = fixture({ read: async () => ({ blob: new Blob(["file"], { type }) }) });
    await f.viewer.open(path);
    assert.equal(f.blobs[0].type, type);
    f.viewer.reset();
    assert.deepEqual(f.revoked, f.sent);
    f.close(f.sent[0]);
    assert.equal(f.revoked.length, 1);
  }
});

test("browser popup is closed when a file read fails", async () => {
  const popup = {
    closed: false,
    opener: "parent",
    close() {
      this.closed = true;
    }
  };
  const viewer = createArtifactViewer({
    read: async () => {
      throw new Error("network error");
    },
    identity: () => ({ status: "connected", backendId: "A", sessionId: "one", baseUrl: "" }),
    openWindow: () => popup
  });
  await assert.rejects(viewer.open(path), /network error/);
  assert.equal(popup.opener, null);
  assert.equal(popup.closed, true);
});

test("browser SVG opens as an inert image wrapper and releases both blobs after close", async () => {
  const blobs = [],
    revoked = [],
    callbacks = [];
  const popup = {
    closed: false,
    opener: "present",
    location: {
      replace(value) {
        this.url = value;
      }
    },
    close() {
      this.closed = true;
    }
  };
  const viewer = createArtifactViewer({
    read: async () => ({
      blob: new Blob(['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'], {
        type: "image/svg+xml"
      })
    }),
    identity: () => ({ status: "connected", backendId: "A", sessionId: "one", baseUrl: "" }),
    openWindow: () => popup,
    createObjectURL: (blob) => {
      blobs.push(blob);
      return `blob:http://127.0.0.1:1234/${blobs.length}`;
    },
    revokeObjectURL: (value) => revoked.push(value),
    setTimer: (handler) => {
      callbacks.push(handler);
      return 1;
    },
    clearTimer: () => {}
  });
  await viewer.open(path);
  assert.equal(popup.opener, null);
  assert.equal(blobs[0].type, "image/svg+xml");
  assert.equal(blobs[1].type, "text/html");
  assert.match(await blobs[1].text(), /default-src 'none'/);
  assert.match(await blobs[1].text(), /<img src="blob:http:\/\/127\.0\.0\.1:1234\/1"/);
  popup.closed = true;
  callbacks[0]();
  assert.deepEqual(revoked.sort(), ["blob:http://127.0.0.1:1234/1", "blob:http://127.0.0.1:1234/2"]);
});
