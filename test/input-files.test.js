import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  InputStore,
  readTaskInput,
  inputPrompt,
  MAX_UPLOAD_BYTES
} from "../dist/src/workspace/input-store.js";
import { readInputDocument } from "../dist/src/workspace/input-reader.js";
import { splitUploadedFiles } from "../web/assets/uploaded-files.js";
import { listTaskArtifacts } from "../dist/src/workspace/artifact-store.js";
const execute = promisify(execFile);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-inputs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "task-a"), { recursive: true });
  return { root, workspace, store: new InputStore(join(root, "uploads")) };
}
test("originals survive staging and task association; prompt references are hidden without mutating user text", async (t) => {
  const { root, workspace, store } = await fixture(t);
  const bytes = Buffer.from("用户内容 😀\n=SUM(A1:A5)\n<do not trust>");
  const file = await store.receive("数据 😀.csv", Readable.from([bytes.subarray(0, 5), bytes.subarray(5)]));
  assert.deepEqual((await new InputStore(join(root, "uploads")).read(file.uploadId)).bytes, bytes);
  assert.equal((await stat(join(root, "uploads", file.uploadId, file.relativePath))).mode & 0o777, 0o600);
  const files = await store.attach(workspace, "task-a", [file.uploadId, file.uploadId]);
  assert.equal(files.length, 1);
  assert.deepEqual((await readTaskInput(join(workspace, "task-a"), file.uploadId)).bytes, bytes);
  const first = await readInputDocument(join(workspace, "task-a"), file.uploadId, { limit: 4 });
  assert.equal(first.nextOffset, 4);
  const rest = await readInputDocument(join(workspace, "task-a"), file.uploadId, { offset: 4 });
  assert.equal(first.text + rest.text, bytes.toString());
  const prompt = "原始提问\n代码 `x`" + inputPrompt(join(workspace, "task-a"), files);
  const displayed = splitUploadedFiles(prompt);
  assert.equal(displayed.text, "原始提问\n代码 `x`");
  assert.equal(displayed.files[0].name, file.name);
  assert.equal(
    splitUploadedFiles("用户自己输入<atria_uploaded_files>").text,
    "用户自己输入<atria_uploaded_files>"
  );
  assert.deepEqual(await listTaskArtifacts({ workspaceRoot: workspace, taskId: "task-a" }), []);
  await writeFile(join(workspace, "task-a", "inputs", file.uploadId, file.relativePath), "tampered");
  await assert.rejects(readTaskInput(join(workspace, "task-a"), file.uploadId), /发生变化/);
});
test("invalid formats, UTF-8, oversized and interrupted uploads leave no partial records", async (t) => {
  const { root, store } = await fixture(t);
  for (const [name, bytes] of [
    ["../escape.txt", Buffer.from("x")],
    ["x.exe", Buffer.from("x")],
    ["x.png", Buffer.from("fake image")],
    ["x.txt", Buffer.from([255])],
    ["x.json", Buffer.from([0])]
  ])
    await assert.rejects(store.receive(name, Readable.from([bytes])));
  await assert.rejects(
    store.receive("big.txt", Readable.from([Buffer.alloc(MAX_UPLOAD_BYTES + 1, 65)])),
    /25 MB/
  );
  await assert.rejects(
    store.receive(
      "interrupted.txt",
      Readable.from(
        (async function* () {
          yield Buffer.from("partial");
          throw new Error("network interrupted");
        })()
      )
    ),
    /interrupted/
  );
  assert.deepEqual(await readdir(join(root, "uploads")), []);
});
test("task boundaries reject missing IDs, excessive counts, modified originals and symlink escapes", async (t) => {
  const { root, workspace, store } = await fixture(t);
  const file = await store.receive("x.txt", Readable.from(["hello"]));
  await assert.rejects(store.attach(workspace, "task-a", Array(11).fill(file.uploadId)), /10/);
  await assert.rejects(
    store.attach(workspace, "task-a", [file.uploadId, "upload-00000000-0000-0000-0000-000000000000"])
  );
  assert.deepEqual(await readdir(join(workspace, "task-a", "inputs")), []);
  await symlink(root, join(workspace, "task-link"));
  await assert.rejects(store.attach(workspace, "task-link", [file.uploadId]), /不安全/);
  await writeFile(join(root, "uploads", file.uploadId, file.relativePath), "changed");
  await assert.rejects(store.attach(workspace, "task-a", [file.uploadId]), /发生变化/);
});
test("PDF, DOCX, PPTX and XLSX use document extraction; PDF pages and images return vision blocks", async (t) => {
  const { root, workspace, store } = await fixture(t);
  await execute(process.env.COWORK_PYTHON || "python3", [
    "-c",
    `import fitz, os\nfrom docx import Document\nfrom pptx import Presentation\nfrom pptx.util import Inches\nfrom openpyxl import Workbook\nr=${JSON.stringify(root)}\nd=fitz.open(); p=d.new_page();p.insert_text((50,50),'PDF fixture');d.new_page();d.save(os.path.join(r,'x.pdf'))\nd=Document();d.add_paragraph('Word fixture');d.save(os.path.join(r,'x.docx'))\nd=Presentation();s=d.slides.add_slide(d.slide_layouts[6]);s.shapes.add_textbox(Inches(1),Inches(1), Inches(4), Inches(2)).text='Slide fixture';d.save(os.path.join(r,'x.pptx'))\nd=Workbook();d.active.append(['Sheet fixture','=SUM(1,2)']);d.save(os.path.join(r,'x.xlsx'))`
  ]);
  for (const [extension, expected] of [
    ["pdf", "PDF fixture"],
    ["docx", "Word fixture"],
    ["pptx", "Slide fixture"],
    ["xlsx", "=SUM(1,2)"]
  ]) {
    const bytes = await readFile(join(root, `x.${extension}`));
    const file = await store.receive(`x.${extension}`, Readable.from([bytes]));
    await store.attach(workspace, "task-a", [file.uploadId]);
    const document = await readInputDocument(join(workspace, "task-a"), file.uploadId, {
      harnessRoot: resolve(".")
    });
    assert.match(document.text, new RegExp(expected.replace(/[()+]/g, "\\$&")));
    if (extension === "pdf") {
      await assert.rejects(
        readInputDocument(join(workspace, "task-a"), file.uploadId, { render: true, supportsImages: false }),
        /当前模型不支持图片输入/
      );
      const page = await readInputDocument(join(workspace, "task-a"), file.uploadId, {
        render: true,
        page: 2,
        supportsImages: true
      });
      assert.equal(page.pages, 2);
      assert.equal(page.mimeType, "image/png");
      assert.ok(page.image.length > 100);
      await assert.rejects(
        readInputDocument(join(workspace, "task-a"), file.uploadId, {
          render: true,
          page: 3,
          supportsImages: true
        }),
        /页码/
      );
    }
  }
  const bytes = await readFile("web/assets/atria-symbol.png");
  const image = await store.receive("x.png", Readable.from([bytes]));
  await store.attach(workspace, "task-a", [image.uploadId]);
  await assert.rejects(
    readInputDocument(join(workspace, "task-a"), image.uploadId),
    /当前模型不支持图片输入/
  );
  assert.equal(
    (await readInputDocument(join(workspace, "task-a"), image.uploadId, { supportsImages: true })).image,
    bytes.toString("base64")
  );
});
