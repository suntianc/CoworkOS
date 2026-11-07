import { test, expect, _electron as electron } from "@playwright/test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { modelProtocolFixture } from "../test/model-protocol-fixture.mjs";
import { stopNativeBackend } from "../test/native-backend-fixture.mjs";

async function inspectSettings(page, testInfo) {
  await expect(page.locator("#composer-input")).toBeVisible();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const overview = page.getByRole("dialog", { name: "设置", exact: true });
  await expect(overview).toBeVisible();
  await expect(overview.getByRole("button", { name: "管理模型连接", exact: true })).toBeVisible();
  await expect(overview.getByRole("button", { name: "管理科学环境", exact: true })).toHaveCount(0);
  await expect(overview.getByText("科学计算", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("settings.png") });
  await overview.getByRole("button", { name: "关闭设置", exact: true }).click();
  await expect(overview).toBeHidden();
}

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

test("browser settings omit retired science controls with old configuration", async ({ page }, testInfo) => {
  const dashboard = await startDashboard({
    config: { science: { enabled: true } },
    env: { COWORK_SCIENCE_TOOLS: "1" }
  });
  try {
    await page.goto(dashboard.base);
    await inspectSettings(page, testInfo);
    expect((await page.request.get(dashboard.base + "/api/science-settings")).status()).toBe(404);
  } finally {
    await dashboard.stop();
  }
});

test("packaged Electron removes science controls and opens and downloads deliveries", async ({}, testInfo) => {
  test.skip(process.platform !== "darwin", "Packaged Electron acceptance requires macOS");
  test.setTimeout(120_000);
  if (!process.env.ATRIA_DESKTOP_APP) throw new Error("ATRIA_DESKTOP_APP must name the candidate app");
  const root = await mkdtemp(join(tmpdir(), "cowork-prune-desktop-"));
  const provider = await modelProtocolFixture("openai-completions", () => ({ text: "fixture" }));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(?:COWORK_|ATRIA_|PI_|SERPER_|EXA_)/.test(name))
  );
  Object.assign(env, {
    COWORK_DESKTOP_DATA: root,
    ATRIA_HOME: join(root, "home"),
    COWORK_SCIENCE_TOOLS: "1",
    COWORK_DISABLE_WATCH_SUPERVISOR: "1",
    PI_CODING_AGENT_DIR: join(root, "pi"),
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0"
  });
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await electron.launch({
      executablePath: join(process.env.ATRIA_DESKTOP_APP, "Contents", "MacOS", "CoworkOS"),
      args: ["--use-mock-keychain"],
      env
    });
    console.log(JSON.stringify({ desktopPid: app.process().pid }));
    const page = await app.firstWindow();
    const dialog = page.getByRole("dialog", { name: "连接模型", exact: true });
    await expect(dialog).toBeVisible();
    await dialog.locator('[name="baseUrl"]').fill(provider.baseUrl);
    await dialog.locator('[name="api"]').selectOption("openai-completions");
    await dialog.locator('[name="model"]').fill("protocol-fixture");
    await dialog.locator('[name="apiKey"]').fill("local-fixture");
    await dialog.getByRole("button", { name: "保存连接", exact: true }).click();
    await expect(dialog).toBeHidden();
    await inspectSettings(page, testInfo);
    const status = await page.evaluate(
      async () =>
        (
          await fetch("/api/science-settings", {
            headers: window.bookmanDesktop?.transportNonce
              ? { "x-cowork-desktop-nonce": window.bookmanDesktop.transportNonce }
              : {}
          })
        ).status
    );
    expect(status).toBe(404);
    const projectDirectory = join(root, "project");
    await mkdir(projectDirectory);
    const post = (path, body) =>
      page.evaluate(
        async ({ path, body }) => {
          const response = await fetch(path, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(window.bookmanDesktop?.transportNonce
                ? { "x-cowork-desktop-nonce": window.bookmanDesktop.transportNonce }
                : {})
            },
            body: JSON.stringify(body)
          });
          return { status: response.status, body: await response.json() };
        },
        { path, body }
      );
    const created = await post("/api/projects", { projectName: "交付验收", projectDirectory });
    expect(created.status).toBe(201);
    expect(
      (
        await post("/api/tasks", {
          taskId: "native-delivery",
          goal: "验证交付",
          projectId: created.body.project.projectId
        })
      ).status
    ).toBe(201);
    const artifacts = join(root, "workspace", "native-delivery", "artifacts");
    await mkdir(artifacts, { recursive: true });
    await writeFile(join(artifacts, "report.txt"), "native delivery");
    const pdf = pdfFixture();
    await writeFile(join(artifacts, "document.pdf"), pdf);
    await app.evaluate(
      ({ session }, output) => {
        globalThis.pruneDownload = { state: "waiting", output };
        session.defaultSession.on("will-download", (_event, item) => {
          item.setSavePath(output);
          item.once("done", (_event, state) => {
            globalThis.pruneDownload.state = state;
          });
        });
      },
      join(root, "download.txt")
    );
    await page.reload();
    await page.locator('#project-list [data-task="native-delivery"]').click();
    await page.locator("#output-pane-toggle").click();
    await page.locator('[data-artifact="report.txt"]').click();
    const drawer = page.locator("#artifact-drawer");
    await expect(drawer).toContainText("native delivery");
    const textWindow = app.waitForEvent("window");
    await drawer.getByRole("link", { name: "打开 ↗" }).click();
    const textViewer = await textWindow;
    await expect(textViewer.locator("body")).toContainText("native delivery");
    await textViewer.close();
    await drawer.getByRole("link", { name: "下载", exact: true }).click();
    await expect.poll(() => app.evaluate(() => globalThis.pruneDownload?.state)).toBe("completed");
    expect(await readFile(join(root, "download.txt"), "utf8")).toBe("native delivery");
    await drawer.locator('[data-drawer-file="document.pdf"]').click();
    const pdfWindow = app.waitForEvent("window");
    await drawer.getByRole("link", { name: "打开 ↗" }).click();
    const pdfViewer = await pdfWindow;
    await expect.poll(() => pdfViewer.url()).toBe("https://artifact.invalid/document.pdf");
    await pdfViewer.waitForLoadState("load");
    await expect
      .poll(
        async () => {
          const image = PNG.sync.read(await pdfViewer.screenshot());
          let nonwhite = 0;
          for (let offset = 0; offset < image.data.length; offset += 4)
            if (image.data[offset] < 220 || image.data[offset + 1] < 220 || image.data[offset + 2] < 220)
              nonwhite += 1;
          return nonwhite;
        },
        { timeout: 15000 }
      )
      .toBeGreaterThan(5000);
    await pdfViewer.screenshot({ path: testInfo.outputPath("pdf-viewer.png") });
    await pdfViewer.close();
  } finally {
    await app?.close();
    await stopNativeBackend(root);
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});
