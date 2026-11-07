const { isDashboardUrl } = require("./trusted-content.cjs");

/** Skip only the exact controlled main-document navigation after old sessions were released. */
function createComputerNavigationGuard({ release, closeViewers }) {
  let pending;
  return {
    async navigate(url, load) {
      const ticket = { url };
      pending = ticket;
      try {
        return await load();
      } finally {
        if (pending === ticket) pending = undefined;
      }
    },
    started(event, previousUrl) {
      if (!event.isMainFrame || event.isSameDocument || !previousUrl) return;
      closeViewers();
      const ticket = pending;
      pending = undefined;
      let mainDocument = false;
      try {
        const pathname = new URL(event.url).pathname;
        mainDocument = pathname === "/" || pathname === "/index.html";
      } catch {
        // Malformed navigation is never a trusted main document.
      }
      if (ticket && mainDocument && isDashboardUrl(event.url, ticket.url)) return;
      release();
    }
  };
}
module.exports = { createComputerNavigationGuard };
