const { randomBytes, timingSafeEqual } = require("node:crypto");

const marker = "x-cowork-desktop-nonce";

/** A window-lifetime capability lets the protocol handler add the host-only session. */
function createSessionTransport({ getSelected, requestToken }) {
  let current;
  return {
    rotate() {
      current = randomBytes(32).toString("hex");
      return current;
    },
    nonce: () => current,
    authorize(request) {
      const headers = new Headers(request.headers);
      const presented = headers.get(marker);
      headers.delete(marker);
      headers.delete("x-atria-token");
      const selected = getSelected();
      const url = new URL(request.url);
      const matches =
        typeof presented === "string" &&
        typeof current === "string" &&
        /^[a-f0-9]{64}$/.test(presented) &&
        timingSafeEqual(Buffer.from(presented), Buffer.from(current));
      if (matches && selected && url.origin === selected.url && url.pathname.startsWith("/api/")) {
        const token = requestToken(selected);
        if (token) headers.set("x-atria-token", token);
      }
      // Redirects return to the protocol handler so credentials are reevaluated
      // against the target origin instead of following a cross-origin Location.
      return new Request(request, { headers, redirect: "manual" });
    }
  };
}
module.exports = { createSessionTransport };
