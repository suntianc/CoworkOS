import { test, expect } from "@playwright/test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repository = resolve(new URL("..", import.meta.url).pathname);
const { startBackend, stopBackend } = await import(
  pathToFileURL(join(repository, "dist/src/cli/backend.js"))
);

function pdfFixture() {
  const stream = "BT /F1 18 Tf 72 720 Td (Fixture PDF) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  let content = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, value] of objects.entries()) {
    offsets.push(Buffer.byteLength(content));
    content += `${index + 1} 0 obj\n${value}\nendobj\n`;
  }
  const xref = Buffer.byteLength(content);
  content += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) content += `${String(offset).padStart(10, "0")} 00000 n \n`;
  return Buffer.from(
    `${content}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  );
}

test("artifact open displays authorized bytes for each isolated backend", async ({ page, context }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    const create = URL.createObjectURL.bind(URL);
    window.testArtifactBlobs = new Map();
    URL.createObjectURL = (blob) => {
      const url = create(blob);
      window.testArtifactBlobs.set(url, blob);
      return url;
    };
  });
  const pdfRawStatuses = [];
  const cspErrors = [];
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (
      url.pathname.endsWith("/artifact") &&
      url.searchParams.get("path") === "document.pdf" &&
      url.searchParams.get("raw") === "1"
    )
      pdfRawStatuses.push(response.status());
  });
  page.on("console", (message) => {
    if (message.text().includes("violates the following Content Security Policy"))
      cspErrors.push(message.text());
  });
  const root = await mkdtemp(join(tmpdir(), "cowork-artifact-open-e2e-"));
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(?:COWORK_|PI_|ATRIA_|ELECTRON_)/.test(name))
  );
  const hosts = [];
  try {
    for (const name of ["A", "B"]) {
      const base = join(root, name),
        home = join(base, "data"),
        project = join(base, "project");
      await mkdir(project, { recursive: true });
      const config = join(base, "config.json");
      await writeFile(config, "{}\n");
      const env = {
        ...inherited,
        HOME: base,
        ATRIA_HOME: home,
        COWORK_HARNESS_ROOT: repository,
        COWORK_WORKSPACE: join(base, "workspace"),
        COWORK_CONFIG: config,
        COWORK_DISABLE_WATCH_SUPERVISOR: "1",
        PI_CODING_AGENT_DIR: join(base, "pi"),
        PI_OFFLINE: "1",
        PI_TELEMETRY: "0",
        COWORK_API_TOKEN: `synthetic-host-${name}`
      };
      const result = await startBackend(env, repository);
      const instance = JSON.parse(await readFile(join(home, "runtime/backend-instance.json"), "utf8"));
      hosts.push({ env, instance });
      expect(result.pid).toBe(instance.pid);
      const host = async (path, data) => {
        const response = await fetch(instance.url + path, {
          method: "POST",
          headers: { "x-atria-token": instance.token, "content-type": "application/json" },
          body: JSON.stringify(data)
        });
        expect(response.ok).toBeTruthy();
        return response.json();
      };
      const created = await host("/api/projects", {
        projectName: `artifact-${name}`,
        projectDirectory: project
      });
      await host("/api/tasks", {
        taskId: "artifact-shared",
        goal: `task-${name}`,
        projectId: created.project.projectId
      });
      const artifacts = join(base, "workspace/artifact-shared/artifacts");
      await mkdir(artifacts, { recursive: true });
      await writeFile(join(artifacts, "report.md"), `# real backend ${name}\n`);
      await writeFile(
        join(artifacts, "picture.svg"),
        '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><script>localStorage.setItem("artifact-attack", "svg")</script><rect width="20" height="20" fill="red"/></svg>'
      );
      await writeFile(
        join(artifacts, "document.html"),
        '<script>localStorage.setItem("artifact-attack", "html")</script><p>SAFE HTML CONTENT</p>'
      );
      await writeFile(join(artifacts, "document.pdf"), pdfFixture());
      const raw = `${instance.url}/api/tasks/artifact-shared/artifact?path=report.md&raw=1`;
      expect((await fetch(raw)).status).toBe(401);
      await context.addCookies([
        { name: "atria-session", value: instance.token, url: instance.url, httpOnly: true }
      ]);
      await page.goto(`${instance.url}/?task=artifact-shared`);
      await expect
        .poll(async () => page.locator("[data-backend-status]").textContent())
        .toContain(instance.backendId.replace(/^backend_/, "").slice(0, 8));
      await context.clearCookies();
      await page.evaluate(() => localStorage.setItem("artifact-attack", "untouched"));
      const model = page.locator('[aria-labelledby="model-settings-title"]');
      if (await model.isVisible()) await model.locator("[data-model-close]").click();
      await page.locator("#output-pane-toggle").click();
      await page.locator('[data-artifact="report.md"]').click();
      const drawer = page.locator("#artifact-drawer");
      await expect(drawer).toBeVisible();
      const popupPromise = page.waitForEvent("popup");
      await drawer.getByRole("link", { name: "打开 ↗" }).click();
      const popup = await popupPromise;
      await expect(popup.locator("body")).toContainText(`real backend ${name}`);
      expect(popup.url()).toMatch(/^blob:/);
      await popup.close();

      await drawer.locator('[data-drawer-file="picture.svg"]').click();
      const svgPromise = page.waitForEvent("popup");
      await drawer.getByRole("link", { name: "打开 ↗" }).click();
      const svg = await svgPromise;
      await expect(svg.locator("img")).toBeVisible();
      expect(await svg.locator("img").evaluate((image) => image.naturalWidth)).toBe(20);
      expect(await page.evaluate(() => localStorage.getItem("artifact-attack"))).toBe("untouched");
      await svg.close();

      await drawer.locator('[data-drawer-file="document.html"]').click();
      const htmlPromise = page.waitForEvent("popup");
      await drawer.getByRole("link", { name: "打开 ↗" }).click();
      const html = await htmlPromise;
      await expect(html.locator("body")).toContainText("SAFE HTML CONTENT");
      expect(await page.evaluate(() => localStorage.getItem("artifact-attack"))).toBe("untouched");
      await html.close();

      const pdfResponse = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.pathname.endsWith("/artifact") &&
          url.searchParams.get("path") === "document.pdf" &&
          url.searchParams.get("raw") === "1" &&
          response.status() === 200
        );
      });
      await drawer.locator('[data-drawer-file="document.pdf"]').click();
      await expect(drawer.locator(".drawer-content")).toContainText("点击“打开 ↗”查看 PDF。");
      const response = await pdfResponse;
      expect(response.headers()["content-type"]).toBe("application/pdf");
      const blobContents = await page.evaluate(async () => {
        const blobs = [...window.testArtifactBlobs.values()];
        const blob = blobs.filter((value) => value.type === "application/pdf").at(-1);
        return { type: blob.type, bytes: [...new Uint8Array(await blob.arrayBuffer())] };
      });
      expect(blobContents.type).toBe("application/pdf");
      expect(Buffer.from(blobContents.bytes)).toEqual(pdfFixture());
      const downloadPromise = page.waitForEvent("download");
      await drawer.getByRole("link", { name: "下载", exact: true }).click();
      const download = await downloadPromise;
      expect(await readFile(await download.path())).toEqual(pdfFixture());
      expect(pdfRawStatuses).not.toContain(401);
      expect(cspErrors).toEqual([]);
    }
  } finally {
    for (const host of hosts) {
      const stopped = await stopBackend(host.env);
      expect(stopped.state).toBe("stopped");
      expect(stopped.pid).toBe(host.instance.pid);
    }
    await rm(root, { recursive: true, force: true });
  }
});
