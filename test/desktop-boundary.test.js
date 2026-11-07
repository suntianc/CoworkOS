import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
const { isDashboardUrl, assertTrustedSender, externalNavigationUrl } = createRequire(import.meta.url)(
  "../desktop/trusted-content.cjs"
);

test("desktop native capabilities are limited to the trusted main renderer", () => {
  const url = "http://127.0.0.1:3881";
  const frame = { url: `${url}/` };
  const sender = { mainFrame: frame };
  const window = { webContents: sender };
  assert.doesNotThrow(() => assertTrustedSender({ sender, senderFrame: frame }, window, url));
  for (const event of [
    { sender: { mainFrame: frame }, senderFrame: frame },
    { sender, senderFrame: { url: `${url}/` } },
    { sender }
  ])
    assert.throws(() => assertTrustedSender(event, window, url), /Untrusted/);
  frame.url = "https://untrusted.invalid/";
  assert.throws(() => assertTrustedSender({ sender, senderFrame: frame }, window, url), /Untrusted/);
  frame.url = `${url}/api/tasks/task/artifact`;
  assert.throws(() => assertTrustedSender({ sender, senderFrame: frame }, window, url), /Untrusted/);
  frame.url = `${url}/assets/untrusted.html`;
  assert.throws(() => assertTrustedSender({ sender, senderFrame: frame }, window, url), /Untrusted/);
});

test("desktop external navigation accepts only bounded HTTP(S) links without credentials", () => {
  const dashboard = "http://127.0.0.1:3881";
  assert.equal(
    externalNavigationUrl("https://example.com/reference?q=atria#section", dashboard),
    "https://example.com/reference?q=atria#section"
  );
  assert.equal(externalNavigationUrl("http://example.com", dashboard), "http://example.com/");
  for (const target of [
    `${dashboard}/api/tasks/task/artifact?raw=1`,
    "file:///tmp/document.txt",
    "mailto:user@example.com",
    "data:text/plain,reference",
    "ftp://example.com/file",
    "https://user:password@example.com/",
    "https://example.com/\nreference",
    `https://example.com/${"x".repeat(4096)}`,
    "/relative-path",
    undefined,
    7
  ])
    assert.equal(externalNavigationUrl(target, dashboard), undefined);
});

test("desktop navigation allows the configured local origin and refuses other schemes or ports", () => {
  const url = "http://127.0.0.1:3881";
  assert.equal(isDashboardUrl(`${url}/?view=workbench`, url), true);
  for (const target of [
    "http://127.0.0.1:3880/",
    "https://untrusted.invalid/",
    "file:///tmp/doc.html",
    "javascript:alert(1)",
    "invalid"
  ]) {
    assert.equal(isDashboardUrl(target, url), false);
  }
});
