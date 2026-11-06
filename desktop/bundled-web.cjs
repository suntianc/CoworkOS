const fs = require("node:fs/promises");
const path = require("node:path");

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".gz": "application/gzip",
  ".txt": "text/plain; charset=utf-8"
};

// The host navigates the bundled client to the selected execution host origin.
const documentPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "frame-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join("; ");

function createBundledWebHandler({ root, getOrigin, fetch }) {
  return async (request) => {
    const url = new URL(request.url);
    let origin;
    try {
      origin = new URL(getOrigin()).origin;
    } catch {
      return fetch(request, { bypassCustomProtocolHandlers: true });
    }
    const document = url.pathname === "/" || url.pathname === "/index.html";
    const asset =
      url.pathname === "/app.js" || url.pathname === "/styles.css" || url.pathname.startsWith("/assets/");
    if (url.origin !== origin || (!document && !asset))
      return fetch(request, { bypassCustomProtocolHandlers: true });
    if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
    let relative;
    try {
      relative = document ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    } catch {
      return new Response(null, { status: 400 });
    }
    if (
      relative.includes("\\") ||
      relative.split("/").some((part) => part === ".." || part === ".") ||
      /%2f/i.test(url.pathname)
    )
      return new Response(null, { status: 400 });
    try {
      const base = await fs.realpath(root);
      const file = await fs.realpath(path.join(base, relative));
      if (!file.startsWith(`${base}${path.sep}`)) return new Response(null, { status: 403 });
      const bytes = await fs.readFile(file);
      const headers = {
        "content-type": contentTypes[path.extname(file).toLowerCase()] || "application/octet-stream",
        "cache-control": "no-cache",
        "x-content-type-options": "nosniff"
      };
      if (document) headers["content-security-policy"] = documentPolicy;
      return new Response(request.method === "HEAD" ? null : bytes, { status: 200, headers });
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "EISDIR")
        return new Response(null, { status: 404 });
      throw error;
    }
  };
}

function installBundledWeb({ session, net, root, getOrigin }) {
  session.protocol.handle("http", createBundledWebHandler({ root, getOrigin, fetch: net.fetch.bind(net) }));
}

module.exports = { createBundledWebHandler, installBundledWeb };
