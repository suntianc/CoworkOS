import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createMacComputerApproval } from "../dist/src/gui/macos-approval.js";

async function helper(t, script) {
  const root = await mkdtemp(join(tmpdir(), "cowork-native-approval-"));
  const directory = join(root, "dist/src/gui");
  await mkdir(directory, { recursive: true });
  const source = typeof script === "function" ? script(root) : script;
  await writeFile(join(directory, "atria-computer-use"), `#!${process.execPath}\n${source}\n`, {
    mode: 0o700
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test(
  "native adapter passes the backend identity over its owned pipe without business environment",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const root = await helper(
      t,
      `let data="";process.stdin.on("data",c=>data+=c);process.stdin.on("end",()=>{const value=JSON.parse(data);process.stdout.write(JSON.stringify({approved:value.operation==="host-approval"&&value.backendId==="backend_fixture"&&!process.env.COWORK_API_TOKEN}));});`
    );
    const old = process.env.COWORK_API_TOKEN;
    process.env.COWORK_API_TOKEN = "synthetic-business-token";
    try {
      const authenticate = createMacComputerApproval(root);
      assert.equal(await authenticate({ backendId: "backend_fixture" }, new AbortController().signal), true);
    } finally {
      if (old === undefined) delete process.env.COWORK_API_TOKEN;
      else process.env.COWORK_API_TOKEN = old;
    }
  }
);

test(
  "native adapter terminates its helper when approval is cancelled",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const root = await helper(
      t,
      (directory) =>
        `const fs=require("node:fs");process.stdin.resume();process.stdin.on("end",()=>{fs.writeFileSync(${JSON.stringify(join(directory, "ready"))},"ready");setInterval(()=>{},1000);});`
    );
    const authenticate = createMacComputerApproval(root);
    const controller = new AbortController();
    const pending = authenticate({ backendId: "backend_fixture" }, controller.signal);
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          await readFile(join(root, "ready"));
          break;
        } catch (error) {
          if (error.code !== "ENOENT" || attempt === 200) throw error;
          await new Promise((done) => setTimeout(done, 10));
        }
      }
    } finally {
      controller.abort();
    }
    await assert.rejects(pending);
  }
);
