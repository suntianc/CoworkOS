function isDashboardUrl(value, dashboardUrl) {
  try {
    return new URL(value).origin === new URL(dashboardUrl).origin;
    // eslint-disable-next-line no-restricted-syntax -- dashboardUrl is undefined before an execution host is selected, so new URL() throws and nothing can be trusted
  } catch {
    return false;
  }
}

/** External links leave the application only through the system browser. */
function externalNavigationUrl(value, dashboardUrl) {
  // eslint-disable-next-line no-control-regex
  if (typeof value !== "string" || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) return;
  try {
    const target = new URL(value);
    if (
      !["http:", "https:"].includes(target.protocol) ||
      target.username ||
      target.password ||
      isDashboardUrl(target.href, dashboardUrl)
    )
      return;
    return target.href;
    // eslint-disable-next-line no-restricted-syntax -- value is the page-supplied URL argument and is not necessarily an absolute, parseable URL
  } catch {
    return;
  }
}

/** The only document backed by bundled code is the main application page. */
function isTrustedDocument(value, dashboardUrl) {
  if (!isDashboardUrl(value, dashboardUrl)) return false;
  const pathname = new URL(value).pathname;
  return pathname === "/" || pathname === "/index.html";
}

/** Only our main renderer may invoke native capabilities, never an iframe or another window. */
function assertTrustedSender(event, mainWindow, dashboardUrl) {
  if (
    !mainWindow ||
    event.sender !== mainWindow.webContents ||
    !event.senderFrame ||
    event.senderFrame !== event.sender.mainFrame ||
    !isTrustedDocument(event.senderFrame.url, dashboardUrl)
  ) {
    throw new Error("Untrusted desktop IPC sender");
  }
}

module.exports = { isDashboardUrl, assertTrustedSender, externalNavigationUrl };
