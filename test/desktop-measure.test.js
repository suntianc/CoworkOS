import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  splitByRole,
  cpuPercent,
  logOffsets,
  backendListening
} from "../scripts/desktop-measure-support.mjs";

test("measurement includes the app root and detached backend descendants without unrelated processes", () => {
  const table = [
    { pid: 10, ppid: 1, rssKb: 100, time: "0:01.00", command: "CoworkOS" },
    { pid: 11, ppid: 10, rssKb: 50, time: "0:02.00", command: "renderer" },
    { pid: 20, ppid: 1, rssKb: 200, time: "0:03.00", command: "backend" },
    { pid: 21, ppid: 20, rssKb: 25, time: "0:04.00", command: "backend worker" },
    { pid: 30, ppid: 1, rssKb: 999, time: "0:00.00", command: "unrelated" }
  ];
  assert.deepEqual(splitByRole(table, 10, [20]), {
    client: { processes: 2, rssKb: 150 },
    backend: { processes: 2, rssKb: 225 },
    pids: { client: [10, 11], backend: [20, 21] }
  });
});

test("CPU uses actual elapsed time and reports incomplete snapshots", () => {
  const first = [
    { pid: 10, time: "0:02.00" },
    { pid: 11, time: "0:03.00" }
  ];
  const second = [
    { pid: 10, time: "0:03.00" },
    { pid: 11, time: "0:03.50" }
  ];
  assert.equal(cpuPercent(first, second, [10, 11], 6000), 25);
  assert.equal(cpuPercent(first, second.slice(0, 1), [10, 11], 6000), null);
});

test("backend readiness ignores copied logs and observes the new launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-measure-log-"));
  try {
    const log = join(root, "dashboard.log");
    await writeFile(log, "listening on http://127.0.0.1:1000\n");
    const offsets = await logOffsets(root);
    assert.equal(await backendListening(root, offsets), undefined);
    await appendFile(log, "listening on http://127.0.0.1:2000\n");
    assert.equal(await backendListening(root, offsets), "http://127.0.0.1:2000");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("footprint selects the de-duplicated multi-process total and requires all PIDs", async () => {
  const { parseFootprint } = await import("../scripts/desktop-measure-support.mjs");
  const output = "Renderer [11]: Footprint: 8 B\nGPU [12]: Footprint: 5 B\nSummary Footprint: 10 B\n";
  assert.equal(parseFootprint(output, [11, 12]), 10);
  assert.equal(parseFootprint("Renderer [11]: Footprint: 8 B\n", [11]), 8);
  assert.throws(() => parseFootprint(output, [11, 13]), /missing process/);
  assert.throws(
    () => parseFootprint("Renderer [11]: Footprint: 8 B\nGPU [12]: Footprint: 5 B\n", [11, 12]),
    /missing summary/
  );
});

test("measured fixture paths belong to each copied root and the source hash stays stable", async () => {
  const { prepareMeasuredFixture, hashFixture } = await import("../scripts/desktop-measure-fixture.mjs");
  const root = await mkdtemp(join(tmpdir(), "desktop-fixture-test-"));
  try {
    const source = join(root, "template");
    const { mkdir, readFile } = await import("node:fs/promises");
    await mkdir(join(source, "runtime"), { recursive: true });
    await mkdir(join(source, "workspace", "one"), { recursive: true });
    await writeFile(
      join(source, "runtime", "projects.json"),
      JSON.stringify({ projects: [{ projectDirectory: join(source, "projects", "one") }] })
    );
    await writeFile(
      join(source, "runtime", "workspaces.json"),
      JSON.stringify({ workspaces: [{ workspaceRoot: join(source, "workspace") }] })
    );
    await writeFile(
      join(source, "workspace", "one", "task.json"),
      JSON.stringify({
        projectCatalogPath: join(source, "runtime", "projects.json"),
        projectDirectory: join(source, "projects", "one")
      })
    );
    const original = await hashFixture(source);
    const first = join(root, "first");
    const second = join(root, "second");
    await prepareMeasuredFixture(source, first);
    await prepareMeasuredFixture(source, second);
    for (const dest of [first, second]) {
      const project = JSON.parse(await readFile(join(dest, "runtime", "projects.json"), "utf8"));
      const task = JSON.parse(await readFile(join(dest, "workspace", "one", "task.json"), "utf8"));
      assert.equal(project.projects[0].projectDirectory, join(dest, "projects", "one"));
      assert.equal(task.projectCatalogPath, join(dest, "runtime", "projects.json"));
    }
    assert.equal(await hashFixture(source), original);
    await writeFile(
      join(source, "runtime", "workspaces.json"),
      JSON.stringify({ workspaces: [{ workspaceRoot: "/outside" }] })
    );
    await assert.rejects(prepareMeasuredFixture(source, join(root, "bad")), /outside fixture/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
