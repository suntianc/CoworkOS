import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PNG } from "pngjs";
import { createImageTools } from "../dist/src/tools/read-image.js";
import { createImageArchive } from "../dist/src/tools/image-archive.js";
import { cropPng } from "../dist/src/tools/image-crop.js";
import { createBuiltinTools } from "../dist/src/tools/builtin.js";

function frame(width = 8, height = 6) {
  const image = new PNG({ width, height });
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      image.data.set([x * 20, y * 30, x + y, x === 0 ? 128 : 255], i);
    }
  return PNG.sync.write(image);
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-visual-observation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const work = join(root, "work"),
    task = join(root, "task"),
    other = join(root, "other");
  await Promise.all([work, task, other].map((path) => mkdir(path)));
  const data = frame();
  await writeFile(join(work, "frame.png"), data);
  return {
    root,
    work,
    task,
    other,
    data,
    tools: createImageTools({ rootDirectory: work, taskDirectory: task, supportsImages: true })
  };
}

test("PNG crop and zoom preserve actual pixels and map rounded output coordinates to source", () => {
  const data = frame(),
    source = PNG.sync.read(data),
    region = { x: 1, y: 2, width: 3, height: 2 };
  for (const scale of [0.25, 1, 1.5, 2, 8]) {
    const crop = cropPng({ data, region, scale }),
      decoded = PNG.sync.read(crop.data);
    assert.equal(crop.scaleX, decoded.width / region.width);
    assert.equal(crop.scaleY, decoded.height / region.height);
    for (let y = 0; y < decoded.height; y++)
      for (let x = 0; x < decoded.width; x++) {
        const sx = region.x + Math.floor(x / crop.scaleX),
          sy = region.y + Math.floor(y / crop.scaleY);
        assert.deepEqual(
          decoded.data.subarray((y * decoded.width + x) * 4, (y * decoded.width + x + 1) * 4),
          source.data.subarray((sy * source.width + sx) * 4, (sy * source.width + sx + 1) * 4)
        );
      }
  }
  assert.throws(() => cropPng({ data, region: { ...region, x: -1 } }), /integer/);
  assert.throws(() => cropPng({ data, region: { ...region, x: 7 } }), /outside/);
  assert.throws(() => cropPng({ data, region, scale: 9 }), /scale/);
  assert.throws(() => cropPng({ data, region, maxImageBytes: data.length - 1 }), /byte/);
  const broken = Buffer.from(data);
  broken[broken.length - 1] ^= 1;
  assert.throws(() => cropPng({ data: broken, region }), /decoded/);
  const giant = Buffer.from(data);
  giant.writeUInt32BE(65536, 16);
  giant.writeUInt32BE(65536, 20);
  assert.throws(() => cropPng({ data: giant, region }), /pixel limit/);
});

test("read/crop/multi-image/history tools share immutable Task images and preserve order", async (t) => {
  const { tools, work, task, data } = await fixture(t);
  const first = await tools.read_image.execute({ path: "frame.png" });
  assert.match(first.details.imageRef, /^img_/);
  assert.equal(first.content[1].data, data.toString("base64"));
  await writeFile(join(work, "frame.png"), frame(2, 2));
  const historical = await tools.read_image.execute({ imageRef: first.details.imageRef });
  assert.equal(historical.content[1].data, first.content[1].data);
  assert.equal(historical.details.imageRef, first.details.imageRef);
  const crop = await tools.crop_image.execute({
    imageRef: first.details.imageRef,
    region: { x: 1, y: 1, width: 3, height: 2 },
    scale: 2
  });
  assert.equal(crop.details.width, 6);
  assert.equal(crop.details.height, 4);
  assert.equal(crop.details.mapping.sourceImageRef, first.details.imageRef);
  assert.equal(crop.details.mapping.scaleX, 2);
  assert.ok(crop.content[0].text.includes('"scaleX":2'));
  assert.equal(crop.details.observationId, undefined);
  const multi = await tools.read_images.execute({
    images: [{ imageRef: first.details.imageRef }, { imageRef: crop.details.imageRef }]
  });
  assert.deepEqual(
    multi.content.filter((block) => block.type === "image").map((block) => block.data),
    [first.content[1].data, crop.content[1].data]
  );
  assert.equal(multi.details.count, 2);
  const history = await tools.list_images.execute({});
  assert.equal(history.details.images.length, 2);
  assert.ok(history.details.images.some((item) => item.source.kind === "derived"));
  const builtin = createBuiltinTools({ rootDirectory: work, workspaceDirectory: task, supportsImages: true });
  for (const name of ["read_image", "crop_image", "read_images", "list_images"]) assert.ok(builtin.has(name));
  assert.equal(
    (await builtin.get("read_image").execute({ imageRef: first.details.imageRef })).details.imageRef,
    first.details.imageRef
  );
});

test("image input boundaries, formats, combined byte limit and cancellation are enforced", async (t) => {
  const { tools, work, other, data, task } = await fixture(t);
  await writeFile(join(other, "outside.png"), data);
  await symlink(join(other, "outside.png"), join(work, "linked.png"));
  for (const input of [{ path: "linked.png" }, { path: "../other/outside.png" }, { path: "/outside.png" }])
    await assert.rejects(tools.read_image.execute(input), /escapes|relative/);
  await assert.rejects(tools.read_image.execute({ path: "frame.png", imageRef: "img_no" }), /exactly one/);
  await assert.rejects(tools.read_image.execute({ imageRef: "../other" }), /imageRef/);
  await assert.rejects(tools.read_images.execute({ images: [] }), /1–4/);
  await assert.rejects(tools.read_images.execute({ images: Array(5).fill({ path: "frame.png" }) }), /1–4/);
  await assert.rejects(
    tools.crop_image.execute({ path: "frame.png", region: { x: 0, y: 0, width: 1, height: 1 }, scale: "2" }),
    /number/
  );
  await writeFile(join(work, "image.gif"), Buffer.from("GIF89a00000000"));
  assert.equal((await tools.read_image.execute({ path: "image.gif" })).details.mimeType, "image/gif");
  await assert.rejects(
    tools.crop_image.execute({ path: "image.gif", region: { x: 0, y: 0, width: 1, height: 1 } }),
    /PNG screenshots only/
  );
  const bounded = createImageTools({
    rootDirectory: work,
    taskDirectory: task,
    supportsImages: true,
    maxBatchBytes: data.length
  });
  await assert.rejects(
    bounded.read_images.execute({ images: [{ path: "frame.png" }, { path: "frame.png" }] }),
    /combined byte limit/
  );
  const signal = AbortSignal.abort();
  for (const name of ["read_image", "read_images", "crop_image", "list_images"]) {
    const params = name === "read_images" ? { images: [{ path: "frame.png" }] } : { path: "frame.png" };
    await assert.rejects(tools[name].execute(params, signal), { name: "AbortError" });
  }
  await assert.rejects(tools.list_images.execute({ limit: 51 }), /1–50/);
});

test("paths comparisons keep main aliases and yield reusable archived images alongside historical sources", async (t) => {
  const { tools, work, data } = await fixture(t);
  const changed = frame(3, 2);
  await writeFile(join(work, "after.png"), changed);
  const compared = await tools.read_image.execute({
    path: "",
    paths: ["frame.png", "after.png"],
    imageRef: null
  });
  assert.deepEqual(
    compared.content.filter((block) => block.type === "image").map((block) => block.data),
    [data.toString("base64"), changed.toString("base64")]
  );
  assert.equal(compared.details.images.length, 2);
  assert.ok(compared.details.images.every((image) => /^img_/.test(image.imageRef)));
  const [before, after] = compared.details.images;
  const historical = await tools.read_image.execute({ paths: [], imageRef: before.imageRef });
  assert.equal(historical.content[1].data, data.toString("base64"));
  const alias = await tools.read_image.execute({ path: "after.png", paths: ["after.png"], imageRef: "" });
  assert.equal(alias.content.filter((block) => block.type === "image").length, 1);
  assert.equal(alias.details.path, "after.png");
  const mixed = await tools.read_images.execute({
    images: [{ path: "frame.png" }, { imageRef: after.imageRef }]
  });
  assert.deepEqual(
    mixed.details.images.map((image) => image.imageHash),
    compared.details.images.map((image) => image.imageHash)
  );
  await assert.rejects(
    tools.read_image.execute({ paths: ["frame.png"], imageRef: before.imageRef }),
    /exactly one/
  );
  await assert.rejects(
    tools.read_images.execute({
      images: [{ path: "frame.png" }, { imageRef: before.imageRef }],
      review: true
    }),
    /one page at a time/
  );
});

test("unused image sources accept empty/null placeholders without weakening source or path boundaries", async (t) => {
  const { tools, data } = await fixture(t);
  const original = await tools.read_image.execute({ path: "frame.png" });
  const imageRef = original.details.imageRef;
  for (const placeholder of [undefined, null, "", " \t "]) {
    const reread = await tools.read_image.execute({ path: placeholder, imageRef });
    assert.equal(reread.content[1].data, data.toString("base64"));
    const local = await tools.read_image.execute({ path: "frame.png", imageRef: placeholder });
    assert.equal(local.content[1].data, data.toString("base64"));
    const crop = await tools.crop_image.execute({
      path: placeholder,
      imageRef,
      region: { x: 1, y: 1, width: 2, height: 2 },
      scale: 2
    });
    assert.equal(crop.details.width, 4);
    assert.equal(crop.details.mapping.sourceImageRef, imageRef);
    const images = await tools.read_images.execute({
      images: [
        { path: "frame.png", imageRef: placeholder },
        { path: placeholder, imageRef }
      ]
    });
    assert.equal(images.details.count, 2);
    await assert.rejects(
      tools.read_image.execute({ path: placeholder, imageRef: placeholder }),
      /exactly one/
    );
  }
  for (const path of ["frame.png", "/", "../outside.png"])
    for (const execute of [
      () => tools.read_image.execute({ path, imageRef }),
      () => tools.crop_image.execute({ path, imageRef, region: { x: 0, y: 0, width: 1, height: 1 } }),
      () => tools.read_images.execute({ images: [{ path, imageRef }] })
    ])
      await assert.rejects(execute(), /exactly one/);
  for (const placeholder of [null, ""])
    await assert.rejects(
      tools.read_image.execute({ path: "/outside.png", imageRef: placeholder }),
      /relative/
    );
  await assert.rejects(tools.read_image.execute({ path: 0, imageRef: "" }), /relative/);
  await assert.rejects(tools.read_image.execute({ path: "", imageRef: false }), /imageRef must be a string/);
});

test("archive rejects cross-Task refs, altered bytes and malformed records, retaining source provenance", async (t) => {
  const { task, other, data } = await fixture(t);
  const archive = createImageArchive({ taskDirectory: task });
  const record = await archive.put({
    data,
    mimeType: "image/png",
    source: { kind: "computer", sourceObservationId: "old-observation" }
  });
  assert.equal(record.source.historical, true);
  assert.equal(record.source.sourceObservationId, "old-observation");
  await assert.rejects(createImageArchive({ taskDirectory: other }).read(record.imageRef), {
    code: "ENOENT"
  });
  const directory = join(task, "visual", "images");
  await writeFile(
    join(directory, `${record.imageRef}.data`),
    frame(8, 6).map((value, i) => (i === 40 ? value ^ 1 : value))
  );
  await assert.rejects(archive.read(record.imageRef), /integrity/);
  await writeFile(join(directory, `${record.imageRef}.json`), "{");
  await assert.rejects(archive.list(), /Corrupt image record/);
  assert.equal(await readFile(join(directory, `${record.imageRef}.json`), "utf8"), "{");
});

test("archive put/read/list reject directory and file symlinks without writing outside", async (t) => {
  const { task, other, data } = await fixture(t);
  const archive = createImageArchive({ taskDirectory: task });
  await symlink(other, join(task, "visual"));
  for (const run of [
    () => archive.put({ data, mimeType: "image/png" }),
    () => archive.list(),
    () => archive.read(`img_${randomUUID()}`)
  ])
    await assert.rejects(run(), /escapes/);
  assert.deepEqual(await readdir(other), []);
  await rm(join(task, "visual"));
  const record = await archive.put({ data, mimeType: "image/png" });
  const body = join(task, "visual", "images", `${record.imageRef}.data`);
  await rm(body);
  await writeFile(join(other, "outside"), data);
  await symlink(join(other, "outside"), body);
  await assert.rejects(archive.read(record.imageRef), (error) => ["ELOOP", "EMLINK"].includes(error.code));
  await assert.rejects(archive.list(), /Invalid image archive entry/);
});

test("archive concurrent writers enforce byte and count budgets; list ignores interrupted metadata publication", async (t) => {
  const { task, other, data } = await fixture(t);
  const budget = data.length + 500;
  const archive = createImageArchive({ taskDirectory: task, maxArchiveBytes: budget });
  const pending = [
    archive.put({ data, mimeType: "image/png" }),
    archive.put({ data, mimeType: "image/png" })
  ];
  const writes = await Promise.allSettled(pending);
  assert.equal(writes.filter((item) => item.status === "fulfilled").length, 1);
  assert.match(writes.find((item) => item.status === "rejected").reason.message, /byte limit/);
  assert.equal((await archive.list()).length, 1);
  const counted = createImageArchive({ taskDirectory: other, maxRecords: 2 });
  const operations = await Promise.allSettled(
    [1, 2, 3].map(() => counted.put({ data, mimeType: "image/png" }))
  );
  assert.equal(operations.filter((item) => item.status === "fulfilled").length, 2);
  assert.equal((await counted.list()).length, 2);
  const crashRef = `img_${randomUUID()}`,
    directory = join(task, "visual", "images");
  await writeFile(join(directory, `${crashRef}.data`), data);
  await writeFile(join(directory, `${crashRef}.pending`), '{"version":');
  assert.equal((await archive.list()).length, 1);
  await assert.rejects(archive.put({ data, mimeType: "image/png" }), /byte limit/);
  assert.equal(await readFile(join(directory, `${crashRef}.pending`), "utf8"), '{"version":');
});

test("put/list concurrency never exposes a partially published image record", async (t) => {
  const { task, data } = await fixture(t);
  const archive = createImageArchive({ taskDirectory: task });
  for (let i = 0; i < 6; i++) {
    const [record, records] = await Promise.all([
      archive.put({ data, mimeType: "image/png" }),
      archive.list()
    ]);
    assert.ok(records.length === i || records.length === i + 1);
    assert.deepEqual((await archive.read(record.imageRef)).data, data);
  }
  assert.equal((await archive.list()).length, 6);
});

test("archive record budget remains exclusive across independent Node processes", async (t) => {
  const { task, data } = await fixture(t);
  const exec = promisify(execFile);
  const source = `import { createImageArchive } from ${JSON.stringify(new URL("../dist/src/tools/image-archive.js", import.meta.url).href)};
    await createImageArchive({ taskDirectory: process.argv[1], maxRecords: 1 }).put({ data: Buffer.from(process.argv[2], 'base64'), mimeType: 'image/png' });`;
  const results = await Promise.allSettled(
    Array.from({ length: 4 }, () =>
      exec(process.execPath, ["--input-type=module", "-e", source, task, data.toString("base64")], {
        cwd: resolve("."),
        timeout: 5000
      })
    )
  );
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  for (const result of results.filter((item) => item.status === "rejected"))
    assert.match(result.reason.stderr, /record limit/);
  const archive = createImageArchive({ taskDirectory: task });
  assert.equal((await archive.list()).length, 1);
});
