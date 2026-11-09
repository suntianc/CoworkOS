import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test, expect } from "@playwright/test";
import { startConfiguredDashboard } from "../test/dashboard-fixture.mjs";

const evidenceRoot = process.env.P45_EVIDENCE_DIR;
const run = promisify(execFile);
const git = (cwd, args) =>
  run("git", ["-C", cwd, ...args], { maxBuffer: 8 * 1024 * 1024 }).then((result) => result.stdout.trim());

async function seedRepository(root) {
  const work = join(root, "seed");
  await mkdir(work, { recursive: true });
  await git(work, ["init", "-b", "main"]);
  await git(work, ["config", "user.email", "fixture@example.test"]);
  await git(work, ["config", "user.name", "Fixture"]);
  await writeFile(join(work, "README.md"), "克隆夹具\n");
  await git(work, ["add", "."]);
  await git(work, ["commit", "-m", "initial"]);
  await git(work, ["checkout", "-b", "release"]);
  await writeFile(join(work, "release.txt"), "release branch\n");
  await git(work, ["add", "."]);
  await git(work, ["commit", "-m", "release"]);
  await git(work, ["checkout", "main"]);
  const bare = join(root, "remote.git");
  await run("git", ["clone", "--bare", work, bare], { maxBuffer: 8 * 1024 * 1024 });
  return bare;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function screenshot(page, name) {
  if (!evidenceRoot) return;
  await page.screenshot({ path: join(evidenceRoot, `${name}.png`) });
}

test("the sidebar plus adds a project from a local folder and from a Git clone", async ({ page }, info) => {
  const dashboard = await startConfiguredDashboard({ defaultProject: false });
  try {
    const bare = await seedRepository(dashboard.root);
    const localDirectory = join(dashboard.root, "local-project");
    await mkdir(localDirectory);
    await page.goto(dashboard.base);

    await page.locator("#new-project").click();
    let dialog = page.getByRole("dialog", { name: "添加项目", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("tab", { name: "本地目录" })).toHaveAttribute("aria-selected", "true");
    await expect(dialog.locator("#add-project-panel-git")).toBeHidden();
    await dialog.getByRole("textbox", { name: "项目名称" }).fill("本地项目");
    await page.evaluate((directory) => {
      window.bookmanDesktop = { chooseProject: async () => directory };
    }, localDirectory);
    await dialog.getByRole("button", { name: "选择文件夹" }).click();
    await expect(dialog.locator("#add-project-directory")).toHaveValue(localDirectory);
    await screenshot(page, "add-project-local");
    await dialog.getByRole("button", { name: "添加项目", exact: true }).click();
    await expect(dialog).toBeHidden();
    const localGroup = page.locator(".project-group", { hasText: "本地项目" });
    await expect(localGroup).toHaveCount(1);
    await expect(localGroup.locator(".project-name")).toHaveText("本地项目");
    await expect(localGroup).toHaveClass(/is-selected/);

    await page.locator("#new-project").click();
    dialog = page.getByRole("dialog", { name: "添加项目", exact: true });
    await dialog.getByRole("tab", { name: "Git 地址" }).click();
    await expect(dialog.locator("#add-project-panel-git")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "克隆并添加" })).toBeVisible();
    const remote = dialog.locator("#add-project-remote");
    const destination = dialog.locator("#add-project-destination");
    await remote.fill("git@github.com:acme/website.git");
    await destination.fill("~/Projects/website");
    await expect(dialog.locator("#add-project-branch")).toHaveAttribute("placeholder", "默认分支");
    if (evidenceRoot) {
      await screenshot(page, "add-project-git-dark");
      await page.locator(".add-project-dialog").screenshot({
        path: join(evidenceRoot, "add-project-dialog-dark.png")
      });
    }

    const cloneDirectory = join(dashboard.root, "website");
    await remote.fill(`file://${bare}`);
    await destination.fill(cloneDirectory);
    await dialog.locator("#add-project-branch").fill("release");
    await dialog.getByRole("button", { name: "克隆并添加" }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    const cloneGroup = page.locator(".project-group", { hasText: "website" });
    await expect(cloneGroup).toHaveCount(1);
    await expect(cloneGroup.locator(".project-name")).toHaveText("website");
    expect(await readFile(join(cloneDirectory, "release.txt"), "utf8")).toBe("release branch\n");
    const catalog = await (await page.request.get(`${dashboard.base}/api/tasks`)).json();
    expect(catalog.projects.map((project) => project.projectDirectory)).toHaveLength(2);
    expect(catalog.projects.map((project) => project.projectDirectory)).toEqual(
      expect.arrayContaining([localDirectory, cloneDirectory])
    );
    await page.screenshot({ path: info.outputPath("added-projects.png") });

    if (evidenceRoot) {
      await page.evaluate(() => localStorage.setItem("atria.appearance", "light"));
      await page.reload();
      await page.locator("#new-project").click();
      const light = page.getByRole("dialog", { name: "添加项目", exact: true });
      await light.getByRole("tab", { name: "Git 地址" }).click();
      await light.locator("#add-project-remote").fill("git@github.com:acme/website.git");
      await light.locator("#add-project-destination").fill("~/Projects/website");
      await screenshot(page, "add-project-git-light");
      await page.locator(".add-project-dialog").screenshot({
        path: join(evidenceRoot, "add-project-dialog-light.png")
      });
      await light.getByRole("button", { name: "取消", exact: true }).click();
      await expect(light).toBeHidden();
    }
  } finally {
    await dashboard.stop();
  }
});

test("a clone shows progress, cancels on close, and keeps its input after a readable failure", async ({
  page
}, info) => {
  const root = await mkdtemp(join(tmpdir(), "add-project-clone-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "git"),
    `#!/bin/sh\nfor arg in "$@"; do\n  case "$arg" in\n    *denied*)\n      echo "git@example.test: Permission denied (publickey)." >&2\n      exit 128;;\n    *slow*)\n      echo "Cloning into 'website'..." >&2\n      sleep 0.3\n      echo "Receiving objects:  42% (42/100)" >&2\n      sleep 60\n      exit 0;;\n  esac\ndone\nexit 1\n`,
    { mode: 0o755 }
  );
  const dashboard = await startConfiguredDashboard({
    defaultProject: false,
    env: { PATH: `${bin}:${process.env.PATH}` }
  });
  try {
    const destination = join(dashboard.root, "slow-website");
    await page.goto(dashboard.base);
    await page.locator("#new-project").click();
    const dialog = page.getByRole("dialog", { name: "添加项目", exact: true });
    await dialog.getByRole("tab", { name: "Git 地址" }).click();
    await dialog.locator("#add-project-remote").fill("https://example.test/slow.git");
    await dialog.locator("#add-project-destination").fill(destination);
    await dialog.getByRole("button", { name: "克隆并添加" }).click();
    await expect(dialog.locator("#add-project-state")).toContainText("克隆中");
    await expect(dialog.locator("#add-project-state")).toContainText("42%");
    await screenshot(page, "add-project-cloning");
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => exists(destination)).toBe(false);
    await expect(page.locator(".project-group")).toHaveCount(0);

    await page.locator("#new-project").click();
    await expect(dialog.getByRole("tab", { name: "Git 地址" })).toHaveAttribute("aria-selected", "true");
    await expect(dialog.locator("#add-project-remote")).toHaveValue("https://example.test/slow.git");
    await expect(dialog.locator("#add-project-destination")).toHaveValue(destination);
    await dialog.locator("#add-project-remote").fill("https://example.test/denied.git");
    await dialog.getByRole("button", { name: "克隆并添加" }).click();
    await expect(dialog.locator("#add-project-state")).toContainText(
      "克隆失败：Permission denied (publickey)"
    );
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("#add-project-remote")).toHaveValue("https://example.test/denied.git");
    await expect(dialog.locator("#add-project-destination")).toHaveValue(destination);
    await expect(page.locator(".project-group")).toHaveCount(0);
    await screenshot(page, "add-project-failed");
    await page.screenshot({ path: info.outputPath("clone-failure.png") });
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(dialog).toBeHidden();
  } finally {
    await dashboard.stop();
  }
});
