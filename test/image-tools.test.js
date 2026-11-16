import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createImageTools } from "../dist/src/tools/read-image.js";

export const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

test("image paths reject outside symlinks in both work and task scopes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-image-boundary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const work = join(root, "work"),
    task = join(root, "task"),
    outside = join(root, "outside");
  await Promise.all([work, task, outside].map((path) => mkdir(path)));
  await writeFile(join(outside, "dummy.png"), pixel);
  await symlink(join(outside, "dummy.png"), join(work, "linked.png"));
  await symlink(outside, join(task, "linked-directory"));
  await writeFile(join(work, "pixel.png"), pixel);
  await writeFile(join(task, "pixel.png"), pixel);
  const tool = createImageTools({
    rootDirectory: work,
    taskDirectory: task,
    supportsImages: true
  }).read_image;
  await assert.rejects(tool.execute({ path: "linked.png" }), /escapes/);
  await assert.rejects(tool.execute({ path: "linked-directory/dummy.png", scope: "task" }), /escapes/);
  assert.equal((await tool.execute({ path: "pixel.png" })).content[1].type, "image");
  assert.equal((await tool.execute({ path: "pixel.png", scope: "task" })).details.scope, "task");
  await writeFile(join(work, "invalid.png"), "not an image");
  await assert.rejects(tool.execute({ path: "invalid.png" }), /header/);
  await assert.rejects(tool.execute({ path: "pixel.png", scope: "unknown" }), /scope/);
  await assert.rejects(tool.execute({ path: "pixel.png", review: "true" }), /boolean/);
});

test("cancelled image reads stop before loading pixels", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-image-cancel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "pixel.png"), pixel);
  const tool = createImageTools({
    rootDirectory: root,
    taskDirectory: root,
    supportsImages: true
  }).read_image;
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(tool.execute({ path: "pixel.png" }, cancelled.signal), { name: "AbortError" });
});

test("native comparison keeps per-image evidence and validates every image before sending", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-image-comparison-boundary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "pixel.png"), pixel);
  const tool = createImageTools({
    rootDirectory: root,
    taskDirectory: root,
    supportsImages: true
  }).read_image;
  const result = await tool.execute({ paths: ["pixel.png", "pixel.png"] });
  assert.equal(result.content.filter((part) => part.type === "image").length, 2);
  assert.equal(result.content[0].text, "Image 1: pixel.png");
  for (const input of [
    {},
    { path: "pixel.png", paths: ["different.png"] },
    { paths: [] },
    { paths: Array(5).fill("pixel.png") },
    { paths: ["pixel.png", "../outside.png"] },
    { paths: ["pixel.png", "pixel.png"], review: true }
  ])
    await assert.rejects(tool.execute(input));
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(tool.execute({ paths: ["pixel.png", "pixel.png"] }, cancelled.signal), {
    name: "AbortError"
  });
  const large = Buffer.alloc(11 * 1024 * 1024);
  pixel.copy(large);
  await writeFile(join(root, "large.png"), large);
  await assert.rejects(tool.execute({ paths: ["large.png", "large.png"] }), /total byte limit/);
});

test("image selection accepts matching aliases and empty alternatives without duplicating pixels", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-image-selection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "pixel.png"), pixel);
  const tool = createImageTools({
    rootDirectory: root,
    taskDirectory: root,
    supportsImages: true
  }).read_image;
  for (const args of [
    { path: "pixel.png", paths: ["pixel.png"] },
    { path: "pixel.png", paths: [""] },
    { path: "pixel.png", paths: [" "] },
    { path: "pixel.png", paths: [] }
  ]) {
    const result = await tool.execute(args);
    assert.equal(result.content.filter((part) => part.type === "image").length, 1);
    assert.equal(result.details.path, "pixel.png");
    assert.equal(result.details.images, undefined);
  }
  for (const path of ["", " "]) {
    const result = await tool.execute({ path, paths: ["pixel.png"] });
    assert.equal(result.content.filter((part) => part.type === "image").length, 1);
    assert.equal(result.details.images.length, 1);
    assert.equal(result.details.images[0].path, "pixel.png");
  }
});

test("image selection rejects conflicting aliases, incomplete comparisons and malformed alternatives", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-image-selection-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "pixel.png"), pixel);
  const tool = createImageTools({
    rootDirectory: root,
    taskDirectory: root,
    supportsImages: true
  }).read_image;
  for (const args of [
    {},
    { path: "", paths: [""] },
    { paths: [] },
    { path: "pixel.png", paths: ["other.png"] },
    { path: "pixel.png", paths: ["pixel.png", "other.png"] },
    { path: "pixel.png", paths: ["pixel.png", ""] },
    { path: "pixel.png", paths: [null] },
    { path: 42, paths: ["pixel.png"] },
    { path: "pixel.png", paths: "pixel.png" }
  ])
    await assert.rejects(tool.execute(args));
});

test("image tools accept the retired goal and review arguments without a visual-analysis pass", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-image-legacy-arguments-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "pixel.png"), pixel);
  const tools = createImageTools({ rootDirectory: root, taskDirectory: root, supportsImages: true });
  // The removed vision connection used these descriptions to route a second
  // model; the tool now returns pixels to the current connection.
  for (const name of ["read_image", "read_images", "crop_image"]) {
    const { description } = tools[name];
    assert.doesNotMatch(description, /visual qa|vision|second model/i, `${name} still promises an analysis`);
  }
  const single = await tools.read_image.execute({
    path: "pixel.png",
    goal: "find the submit button",
    review: true
  });
  assert.equal(single.content.filter((part) => part.type === "image").length, 1);
  assert.equal(single.details.mode, "direct");
  const batch = await tools.read_image.execute({
    paths: ["pixel.png"],
    goal: "compare the two states",
    review: false
  });
  assert.equal(batch.details.images.length, 1);
  const cropped = await tools.crop_image.execute({
    path: "pixel.png",
    region: { x: 0, y: 0, width: 1, height: 1 },
    goal: "zoom in"
  });
  assert.equal(cropped.content.filter((part) => part.type === "image").length, 1);
  // Acceptance is not permission: review=true still requires one image.
  await assert.rejects(
    tools.read_images.execute({ images: [{ path: "pixel.png" }, { path: "pixel.png" }], review: true }),
    /single image/
  );
});

test("a text-only connection refuses image pixels without contacting another model", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-image-text-only-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "pixel.png"), pixel);
  // No supportsImages: the tool must refuse instead of handing pixels to a
  // second model, which the removed vision role used to do.
  const tools = createImageTools({ rootDirectory: root, taskDirectory: root });
  await assert.rejects(tools.read_image.execute({ path: "pixel.png" }), /当前模型不支持图片/);
  await assert.rejects(tools.read_images.execute({ images: [{ path: "pixel.png" }] }), /当前模型不支持图片/);
  await assert.rejects(
    tools.crop_image.execute({ path: "pixel.png", region: { x: 0, y: 0, width: 1, height: 1 } }),
    /当前模型不支持图片/
  );
});
