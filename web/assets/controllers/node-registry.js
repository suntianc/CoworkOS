const NODES_KEY = "formicand.nodes.v1";

const validRole = (value) => value === "internal" || value === "external";

/**
 * The nodes this client has been connected to.
 *
 * A connected node is a device-local record, like the session token kept per
 * node origin: it never travels with shared project data. The local node is not
 * stored here — the page derives it from the origin it is served from — so this
 * list only holds other nodes, which #09 adds, renames and removes.
 */
export function readNodes(storage) {
  let parsed;
  try {
    parsed = JSON.parse(storage?.getItem(NODES_KEY) || "[]");
    // eslint-disable-next-line no-restricted-syntax -- a record written by an older build may not parse; the page then lists only this machine
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter(
      (node) =>
        node &&
        typeof node.origin === "string" &&
        /^https?:\/\//.test(node.origin) &&
        typeof node.name === "string" &&
        node.name.trim() &&
        validRole(node.role)
    )
    .map((node) => ({
      origin: node.origin,
      name: node.name.trim(),
      role: node.role,
      ...(node.state === "offline" ? { state: "offline" } : { state: "online" }),
      ...(typeof node.lastSeen === "string" ? { lastSeen: node.lastSeen } : {})
    }));
}
