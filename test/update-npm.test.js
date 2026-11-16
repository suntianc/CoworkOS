import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runUpdate } from "../scripts/update.mjs";

async function fixture(t, version = "0.1.0") {
  const root = await mkdtemp(join(tmpdir(), "coworkos-npm-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "coworkos-app", version }));
  await writeFile(
    join(root, "build-info.json"),
    JSON.stringify({ version, distribution: "npm", commit: "fixture" })
  );
  await mkdir(join(root, "user-data"));
  await writeFile(join(root, "user-data/config.json"), "fixture user state\n");
  const messages = [];
  return { root, messages, print: (message) => messages.push(message) };
}

test("npm updates retain npm ownership and only print an explicit package-manager command", async (t) => {
  const options = await fixture(t);
  const before = await readdir(options.root);
  const result = await runUpdate({
    ...options,
    fetchImpl: () => assert.fail("printing an npm update command must not contact an update service")
  });
  assert.equal(result.mode, "npm");
  assert.equal(result.updated, false);
  assert.equal(result.updateCommand, "npm install --global coworkos-app@latest");
  assert.match(options.messages.join("\n"), /npm.*coworkos-app@latest/);
  assert.deepEqual(await readdir(options.root), before);
  assert.equal(await readFile(join(options.root, "user-data/config.json"), "utf8"), "fixture user state\n");
  assert.equal(JSON.parse(await readFile(join(options.root, "package.json"), "utf8")).name, "coworkos-app");
});

test("npm --check queries the public registry tag and reports newer versions without installing", async (t) => {
  const options = await fixture(t);
  const requests = [];
  const result = await runUpdate({
    ...options,
    args: ["--check"],
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ name: "coworkos-app", version: "0.1.1" }));
    }
  });
  assert.equal(result.available, true);
  assert.equal(result.version, "0.1.1");
  assert.equal(result.updated, false);
  assert.deepEqual(
    requests.map(({ url }) => url),
    ["https://registry.npmjs.org/coworkos-app/latest"]
  );
  assert.equal(requests[0].init.headers.authorization, undefined);
  assert.equal(JSON.parse(await readFile(join(options.root, "package.json"), "utf8")).version, "0.1.0");
});

test("stable npm installs check latest without downgrading to an older registry version", async (t) => {
  const options = await fixture(t, "1.0.0");
  const result = await runUpdate({
    ...options,
    args: ["--check"],
    fetchImpl: async (url) => {
      assert.equal(url, "https://registry.npmjs.org/coworkos-app/latest");
      return new Response(JSON.stringify({ name: "coworkos-app", version: "0.9.0" }));
    }
  });
  assert.equal(result.available, false);
  assert.match(options.messages[0], /最新 npm/);
});

test("npm update follows its dist-tag, rejects mismatched metadata and reports unavailable registry tags", async (t) => {
  const options = await fixture(t);
  const ignored = await runUpdate({ ...options, args: ["--channel", "preview"] });
  assert.equal(ignored.mode, "npm");
  assert.equal(ignored.updateCommand, "npm install --global coworkos-app@latest");
  await assert.rejects(
    runUpdate({
      ...options,
      args: ["--check"],
      fetchImpl: async () => new Response("missing", { status: 404 })
    }),
    /HTTP 404/
  );
  await assert.rejects(
    runUpdate({
      ...options,
      args: ["--check"],
      fetchImpl: async () => new Response(JSON.stringify({ name: "other", version: "5.0.0" }))
    }),
    /包名/
  );
  await writeFile(
    join(options.root, "build-info.json"),
    JSON.stringify({ version: "0.1.0", distribution: "release" })
  );
  await assert.rejects(runUpdate(options), /安装来源/);
});

test("update help neither reads installation metadata nor sends requests", async () => {
  const messages = [];
  await runUpdate({
    root: "/unavailable/fixture/help-only",
    args: ["--help"],
    print: (message) => messages.push(message),
    fetchImpl: () => assert.fail("help must not perform network requests")
  });
  assert.match(messages[0], /npm.*managed by npm/);
});
