import { createServer } from "node:net";
import { once } from "node:events";
import { expect } from "@playwright/test";

/** A free loopback port for one more backend. */
export async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Publish one external need, as another channel would. */
export async function publishNeed(page, dashboard, projectId, { requestId, title }) {
  const response = await page.request.post(
    `${dashboard.base}/api/projects/${encodeURIComponent(projectId)}/board`,
    {
      data: {
        action: "publish",
        requestId,
        title,
        content: `${title}的内容。`,
        source: { kind: "external" }
      }
    }
  );
  expect(response.status(), await response.text()).toBeLessThan(300);
}

/**
 * Add one node from the settings page, the way a person would, and return to
 * the shell with that node connected.
 */
export async function addNode(page, { base, name, role = "internal" }) {
  await page.locator("#user-menu-button").click();
  await page.locator('[data-settings-section="nodes"]').click();
  await page.locator("#settings-node-add").click();
  const dialog = page.getByRole("dialog", { name: "添加节点" });
  await dialog.locator("#node-address").fill(base);
  await dialog.locator("#node-name").fill(name);
  await dialog.locator(`[data-node-role="${role}"]`).click();
  await dialog.locator("#node-submit").click();
  await expect(dialog).toBeHidden();
  await page.locator("#settings-back").click();
}

/** Open observation, which is where every view lives. */
export async function openObservation(page) {
  await page.getByRole("tab", { name: "观测", exact: true }).click();
  await expect(page.locator("#observe-entry")).toBeVisible();
}
