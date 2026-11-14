import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { withFileLock } from "../dist/src/storage/file-lock.js";

function waitForMessage(child, type) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onMessage = (message) => {
      if (message?.type !== type) return;
      cleanup();
      resolve(message);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`lock contender exited before ${type}: ${code ?? signal}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`lock contender did not send ${type}`));
    }, 3000);
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

test(
  "a delayed recovery claimant cannot delete a replacement live claim or steal its parent lock",
  { timeout: 10000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-lock-claim-race-"));
    const children = new Set();
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^(?:COWORK_|ATRIA_|PI_|SERPER_)/.test(key))
    );
    t.after(async () => {
      for (const child of children) {
        if (child.exitCode !== null || child.signalCode !== null) continue;
        const closed = once(child, "close");
        child.kill("SIGKILL");
        await closed;
      }
      await rm(root, { recursive: true, force: true });
    });
    const departed = spawn(process.execPath, ["-e", "process.exit(0)"], {
      cwd: root,
      env,
      stdio: "ignore"
    });
    children.add(departed);
    await once(departed, "close");

    const target = join(root, "projects.json.operation");
    const lockPath = `${target}.lock`;
    const ownerPath = join(lockPath, "owner.json");
    const claimPath = join(lockPath, ".dead-owner-recovery");
    await mkdir(lockPath);
    const originalOwner = JSON.stringify({ token: randomUUID(), pid: departed.pid, host: hostname() });
    await writeFile(ownerPath, originalOwner);

    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
          import fs from 'node:fs';
          import {dirname,basename} from 'node:path';
          import {syncBuiltinESMExports} from 'node:module';
          const claimPath = ${JSON.stringify(claimPath)};
          const originalWriteFile = fs.promises.writeFile;
          let paused = false;
          fs.promises.writeFile = async function(path,...args) {
            if(!paused && dirname(String(path)) === claimPath && basename(String(path)) !== 'owner.json') {
              paused = true;
              process.send({type:'claim-created',marker:String(path)});
              await new Promise(resolve => process.once('message',resolve));
            }
            return originalWriteFile.call(this,path,...args);
          };
          syncBuiltinESMExports();
          const {withFileLock} = await import(${JSON.stringify(new URL("../dist/src/storage/file-lock.js", import.meta.url).href)});
          let entered = false;
          try {
            await withFileLock(${JSON.stringify(target)},async () => {entered = true;},{
              recoverDeadOwner:true,staleMs:0,retryMs:5,timeoutMs:250
            });
            process.send({type:'result',entered});
          } catch(error) {
            process.send({type:'result',entered,error:error.message});
          } finally {
            process.disconnect();
          }
        `
      ],
      { cwd: root, env, stdio: ["ignore", "ignore", "pipe", "ipc"] }
    );
    children.add(child);
    let errors = "";
    child.stderr.on("data", (chunk) => {
      errors += String(chunk);
    });
    const paused = await waitForMessage(child, "claim-created");
    await assert.rejects(readFile(join(claimPath, "owner.json")), { code: "ENOENT" });

    // Replace the unpublished claim while the contender is paused before its first write.
    await rm(claimPath, { recursive: true });
    await mkdir(claimPath);
    const liveToken = randomUUID();
    const liveOwnerPath = join(claimPath, "owner.json");
    const liveOwner = JSON.stringify({ token: liveToken, pid: process.pid, host: hostname() });
    await writeFile(join(claimPath, liveToken), liveToken, { flag: "wx" });
    await writeFile(liveOwnerPath, liveOwner, { flag: "wx" });

    const resultPromise = waitForMessage(child, "result");
    const closed = once(child, "close");
    child.send({ type: "resume" });
    const result = await resultPromise;
    await closed;
    assert.equal(child.exitCode, 0, errors);
    assert.equal(result.entered, false, "the protected parent operation must never run");
    assert.match(result.error, /timed out acquiring file lock/);
    assert.equal(await readFile(liveOwnerPath, "utf8"), liveOwner);
    assert.equal(await readFile(join(claimPath, liveToken), "utf8"), liveToken);
    assert.equal(await readFile(paused.marker, "utf8"), basename(paused.marker));
    assert.equal(await readFile(ownerPath, "utf8"), originalOwner);
  }
);

test(
  "a delayed initial owner publication cannot overwrite a new live owner or enter its action",
  { timeout: 10000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-lock-owner-race-"));
    const target = join(root, "projects.json.operation");
    const ownerPath = `${target}.lock/owner.json`;
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^(?:COWORK_|ATRIA_|PI_|SERPER_)/.test(key))
    );
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
          import fs from 'node:fs';
          import {syncBuiltinESMExports} from 'node:module';
          const ownerPath = ${JSON.stringify(ownerPath)};
          const originalWriteFile = fs.promises.writeFile;
          let paused = false;
          fs.promises.writeFile = async function(path,...args) {
            if(!paused && String(path) === ownerPath) {
              paused = true;
              process.send({type:'owner-pending'});
              await new Promise(resolve => process.once('message',resolve));
            }
            return originalWriteFile.call(this,path,...args);
          };
          syncBuiltinESMExports();
          const {withFileLock} = await import(${JSON.stringify(new URL("../dist/src/storage/file-lock.js", import.meta.url).href)});
          let entered = false;
          try {
            await withFileLock(${JSON.stringify(target)},async () => {entered = true;},{
              recoverDeadOwner:true,staleMs:0,retryMs:5,timeoutMs:250
            });
            process.send({type:'result',entered});
          } catch(error) {
            process.send({type:'result',entered,error:error.message});
          } finally {
            process.disconnect();
          }
        `
      ],
      { cwd: root, env, stdio: ["ignore", "ignore", "pipe", "ipc"] }
    );
    let errors = "";
    child.stderr.on("data", (chunk) => {
      errors += String(chunk);
    });
    let releaseLiveOwner;
    let liveOperation;
    t.after(async () => {
      releaseLiveOwner?.();
      if (liveOperation) await liveOperation;
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, "close");
        child.kill("SIGKILL");
        await closed;
      }
      await rm(root, { recursive: true, force: true });
    });
    await waitForMessage(child, "owner-pending");
    await assert.rejects(readFile(ownerPath), { code: "ENOENT" });

    const released = new Promise((resolve) => {
      releaseLiveOwner = resolve;
    });
    let enteredLiveOwner;
    const entered = new Promise((resolve) => {
      enteredLiveOwner = resolve;
    });
    let liveEntries = 0;
    liveOperation = withFileLock(
      target,
      async () => {
        liveEntries += 1;
        enteredLiveOwner();
        await released;
      },
      { recoverDeadOwner: true, staleMs: 0, retryMs: 5, timeoutMs: 500 }
    );
    await Promise.race([entered, liveOperation]);
    const liveOwner = await readFile(ownerPath, "utf8");
    assert.equal(JSON.parse(liveOwner).pid, process.pid);
    assert.equal(JSON.parse(liveOwner).host, hostname());

    const resultPromise = waitForMessage(child, "result");
    const closed = once(child, "close");
    child.send({ type: "resume" });
    const result = await resultPromise;
    await closed;
    assert.equal(child.exitCode, 0, errors);
    assert.equal(result.entered, false, "the displaced contender must never enter the protected action");
    assert.match(result.error, /timed out acquiring file lock/);
    assert.equal(liveEntries, 1);
    assert.equal(await readFile(ownerPath, "utf8"), liveOwner);

    releaseLiveOwner();
    await liveOperation;
    await assert.rejects(readFile(ownerPath), { code: "ENOENT" });
  }
);

test(
  "a newly published owner waits for an already validated recovery claim before entering its action",
  { timeout: 10000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-lock-publication-barrier-"));
    const target = join(root, "projects.json.operation");
    const lockPath = `${target}.lock`;
    const ownerPath = join(lockPath, "owner.json");
    const claimPath = join(lockPath, ".dead-owner-recovery");
    const actionPath = join(root, "entered-action.txt");
    const children = new Set();
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^(?:COWORK_|ATRIA_|PI_|SERPER_)/.test(key))
    );
    t.after(async () => {
      for (const child of children) {
        if (child.exitCode !== null || child.signalCode !== null) continue;
        const closed = once(child, "close");
        child.kill("SIGKILL");
        await closed;
      }
      await rm(root, { recursive: true, force: true });
    });
    const start = (source) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
        cwd: root,
        env,
        stdio: ["ignore", "ignore", "pipe", "ipc"]
      });
      children.add(child);
      let errors = "";
      child.stderr.on("data", (chunk) => {
        errors += String(chunk);
      });
      return { child, errors: () => errors };
    };
    const publisher = start(`
      import fs from 'node:fs';
      import {syncBuiltinESMExports} from 'node:module';
      const ownerPath = ${JSON.stringify(ownerPath)};
      const claimPath = ${JSON.stringify(claimPath)};
      const originalWriteFile = fs.promises.writeFile;
      const originalStat = fs.promises.stat;
      let ownerWrites = 0;
      let checkpoint = false;
      fs.promises.writeFile = async function(path,...args) {
        if(String(path) === ownerPath && ownerWrites === 0) {
          process.send({type:'owner-pending'});
          await new Promise(resolve => process.once('message',resolve));
        }
        const result = await originalWriteFile.call(this,path,...args);
        if(String(path) === ownerPath) ownerWrites += 1;
        return result;
      };
      fs.promises.stat = async function(path,...args) {
        const result = await originalStat.call(this,path,...args);
        if(String(path) === claimPath && !checkpoint) {
          checkpoint = true;
          process.send({type:'checkpoint',entered:false});
        }
        return result;
      };
      syncBuiltinESMExports();
      const {withFileLock} = await import(${JSON.stringify(new URL("../dist/src/storage/file-lock.js", import.meta.url).href)});
      let entered = false;
      try {
        await withFileLock(${JSON.stringify(target)},async () => {
          entered = true;
          if(!checkpoint) process.send({type:'checkpoint',entered:true});
          await fs.promises.writeFile(${JSON.stringify(actionPath)},String(ownerWrites));
          process.send({type:'action-entered',ownerWrites});
          await new Promise(resolve => process.once('message',resolve));
        },{recoverDeadOwner:true,staleMs:0,retryMs:5,timeoutMs:1500});
        process.send({type:'result',entered});
      } catch(error) {
        process.send({type:'result',entered,error:error.message});
      } finally {
        process.disconnect();
      }
    `);
    await waitForMessage(publisher.child, "owner-pending");
    await assert.rejects(readFile(ownerPath), { code: "ENOENT" });

    const recoverer = start(`
      import fs from 'node:fs';
      import {syncBuiltinESMExports} from 'node:module';
      const lockPath = ${JSON.stringify(lockPath)};
      const originalRm = fs.promises.rm;
      let paused = false;
      fs.promises.rm = async function(path,...args) {
        if(String(path) !== lockPath || paused) return originalRm.call(this,path,...args);
        paused = true;
        process.send({type:'rm-pending'});
        await new Promise(resolve => process.once('message',resolve));
        const result = await originalRm.call(this,path,...args);
        process.send({type:'rm-complete'});
        await new Promise(resolve => process.once('message',resolve));
        return result;
      };
      syncBuiltinESMExports();
      const {withFileLock} = await import(${JSON.stringify(new URL("../dist/src/storage/file-lock.js", import.meta.url).href)});
      let entered = false;
      try {
        await withFileLock(${JSON.stringify(target)},async () => {entered = true;},{
          recoverDeadOwner:true,staleMs:0,retryMs:5,timeoutMs:1000
        });
        process.send({type:'result',entered});
      } catch(error) {
        process.send({type:'result',entered,error:error.message});
      } finally {
        process.disconnect();
      }
    `);
    await waitForMessage(recoverer.child, "rm-pending");
    assert.equal(JSON.parse(await readFile(join(claimPath, "owner.json"), "utf8")).pid, recoverer.child.pid);

    const checkpointPromise = waitForMessage(publisher.child, "checkpoint");
    publisher.child.send({ type: "publish" });
    const checkpoint = await checkpointPromise;
    assert.equal(checkpoint.entered, false, "the action must wait while the validated recovery claim lives");
    assert.equal(JSON.parse(await readFile(ownerPath, "utf8")).pid, publisher.child.pid);
    await assert.rejects(readFile(actionPath), { code: "ENOENT" });

    const enteredPromise = waitForMessage(publisher.child, "action-entered");
    const removedPromise = waitForMessage(recoverer.child, "rm-complete");
    recoverer.child.send({ type: "remove-old-generation" });
    await removedPromise;
    const entered = await enteredPromise;
    assert.equal(
      entered.ownerWrites,
      2,
      "the publisher must reacquire after recovery removed its first generation"
    );
    assert.equal(await readFile(actionPath, "utf8"), "2");
    const liveOwner = await readFile(ownerPath, "utf8");
    assert.equal(JSON.parse(liveOwner).pid, publisher.child.pid);

    const recoveredPromise = waitForMessage(recoverer.child, "result");
    const recovererClosed = once(recoverer.child, "close");
    recoverer.child.send({ type: "settle-claim" });
    const recovered = await recoveredPromise;
    await recovererClosed;
    assert.equal(recoverer.child.exitCode, 0, recoverer.errors());
    assert.equal(recovered.entered, false);
    assert.match(recovered.error, /timed out acquiring file lock/);
    assert.equal(await readFile(ownerPath, "utf8"), liveOwner);

    const publishedPromise = waitForMessage(publisher.child, "result");
    const publisherClosed = once(publisher.child, "close");
    publisher.child.send({ type: "finish-action" });
    const published = await publishedPromise;
    await publisherClosed;
    assert.equal(publisher.child.exitCode, 0, publisher.errors());
    assert.equal(published.entered, true);
    assert.equal(published.error, undefined);
    await assert.rejects(readFile(ownerPath), { code: "ENOENT" });
  }
);

test(
  "a timed-out publisher remains alive and can recover its cancelled owner after a live claim settles",
  { timeout: 10000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-lock-cancelled-publication-"));
    const target = join(root, "projects.json.operation");
    const lockPath = `${target}.lock`;
    const ownerPath = join(lockPath, "owner.json");
    const claimPath = join(lockPath, ".dead-owner-recovery");
    const children = new Set();
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^(?:COWORK_|ATRIA_|PI_|SERPER_)/.test(key))
    );
    t.after(async () => {
      for (const child of children) {
        if (child.exitCode !== null || child.signalCode !== null) continue;
        const closed = once(child, "close");
        child.kill("SIGKILL");
        await closed;
      }
      await rm(root, { recursive: true, force: true });
    });
    const start = (source) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
        cwd: root,
        env,
        stdio: ["ignore", "ignore", "pipe", "ipc"]
      });
      children.add(child);
      let errors = "";
      child.stderr.on("data", (chunk) => {
        errors += String(chunk);
      });
      return { child, errors: () => errors };
    };
    const publisher = start(`
      import fs from 'node:fs';
      import {syncBuiltinESMExports} from 'node:module';
      const ownerPath = ${JSON.stringify(ownerPath)};
      const originalWriteFile = fs.promises.writeFile;
      let paused = false;
      fs.promises.writeFile = async function(path,...args) {
        if(!paused && String(path) === ownerPath) {
          paused = true;
          process.send({type:'owner-pending'});
          await new Promise(resolve => process.once('message',resolve));
        }
        return originalWriteFile.call(this,path,...args);
      };
      syncBuiltinESMExports();
      const {withFileLock} = await import(${JSON.stringify(new URL("../dist/src/storage/file-lock.js", import.meta.url).href)});
      let firstEntered = false;
      try {
        await withFileLock(${JSON.stringify(target)},async () => {firstEntered = true;},{
          recoverDeadOwner:true,staleMs:0,retryMs:5,timeoutMs:500
        });
        process.send({type:'first-result',entered:firstEntered});
      } catch(error) {
        process.send({type:'first-result',entered:firstEntered,error:error.message});
      }
      await new Promise(resolve => process.once('message',resolve));
      let secondEntered = false;
      try {
        await withFileLock(${JSON.stringify(target)},async () => {
          secondEntered = true;
          process.send({type:'retry-entered'});
          await new Promise(resolve => process.once('message',resolve));
        },{recoverDeadOwner:true,staleMs:0,retryMs:5,timeoutMs:1000});
        process.send({type:'result',entered:secondEntered});
      } catch(error) {
        process.send({type:'result',entered:secondEntered,error:error.message});
      } finally {
        process.disconnect();
      }
    `);
    await waitForMessage(publisher.child, "owner-pending");
    const recoverer = start(`
      import fs from 'node:fs';
      import {syncBuiltinESMExports} from 'node:module';
      const ownerPath = ${JSON.stringify(ownerPath)};
      const claimPath = ${JSON.stringify(claimPath)};
      const originalReadFile = fs.promises.readFile;
      const originalRm = fs.promises.rm;
      let ownerReads = 0;
      let settled = false;
      fs.promises.readFile = async function(path,...args) {
        if(String(path) === ownerPath && ++ownerReads === 2) {
          process.send({type:'claim-ready'});
          await new Promise(resolve => process.once('message',resolve));
        }
        return originalReadFile.call(this,path,...args);
      };
      fs.promises.rm = async function(path,...args) {
        const result = await originalRm.call(this,path,...args);
        if(String(path) === claimPath && !settled) {
          settled = true;
          process.send({type:'claim-released'});
          await new Promise(resolve => process.once('message',resolve));
        }
        return result;
      };
      syncBuiltinESMExports();
      const {withFileLock} = await import(${JSON.stringify(new URL("../dist/src/storage/file-lock.js", import.meta.url).href)});
      let entered = false;
      try {
        await withFileLock(${JSON.stringify(target)},async () => {entered = true;},{
          recoverDeadOwner:true,staleMs:0,retryMs:5,timeoutMs:1500
        });
        process.send({type:'result',entered});
      } catch(error) {
        process.send({type:'result',entered,error:error.message});
      } finally {
        process.disconnect();
      }
    `);
    await waitForMessage(recoverer.child, "claim-ready");
    const liveClaim = await readFile(join(claimPath, "owner.json"), "utf8");
    assert.equal(JSON.parse(liveClaim).pid, recoverer.child.pid);
    const firstResultPromise = waitForMessage(publisher.child, "first-result");
    publisher.child.send({ type: "publish-and-timeout" });
    const firstResult = await firstResultPromise;
    assert.equal(firstResult.entered, false);
    assert.match(firstResult.error, /timed out acquiring file lock/);
    process.kill(publisher.child.pid, 0);
    const cancelledOwner = await readFile(ownerPath, "utf8");
    const cancelledToken = JSON.parse(cancelledOwner).token;
    assert.equal(JSON.parse(cancelledOwner).pid, publisher.child.pid);
    const cancellationPath = join(
      lockPath,
      `.cancelled-owner-${createHash("sha256").update(cancelledToken).digest("hex")}`
    );
    assert.equal(await readFile(cancellationPath, "utf8"), cancelledToken);
    assert.equal(await readFile(join(claimPath, "owner.json"), "utf8"), liveClaim);

    const releasedPromise = waitForMessage(recoverer.child, "claim-released");
    recoverer.child.send({ type: "validate-new-owner" });
    await releasedPromise;
    assert.equal(await readFile(ownerPath, "utf8"), cancelledOwner);
    await assert.rejects(readFile(join(claimPath, "owner.json")), { code: "ENOENT" });

    const retriedPromise = waitForMessage(publisher.child, "retry-entered");
    publisher.child.send({ type: "retry-in-same-process" });
    await retriedPromise;
    process.kill(publisher.child.pid, 0);
    const liveOwner = await readFile(ownerPath, "utf8");
    assert.equal(JSON.parse(liveOwner).pid, publisher.child.pid);
    assert.notEqual(JSON.parse(liveOwner).token, cancelledToken);
    await assert.rejects(readFile(cancellationPath), { code: "ENOENT" });

    const recoveredPromise = waitForMessage(recoverer.child, "result");
    const recovererClosed = once(recoverer.child, "close");
    recoverer.child.send({ type: "finish-recovery" });
    const recovered = await recoveredPromise;
    await recovererClosed;
    assert.equal(recoverer.child.exitCode, 0, recoverer.errors());
    assert.equal(recovered.entered, false);
    assert.match(recovered.error, /timed out acquiring file lock/);
    assert.equal(await readFile(ownerPath, "utf8"), liveOwner);

    const publishedPromise = waitForMessage(publisher.child, "result");
    const publisherClosed = once(publisher.child, "close");
    publisher.child.send({ type: "finish-retried-action" });
    const published = await publishedPromise;
    await publisherClosed;
    assert.equal(publisher.child.exitCode, 0, publisher.errors());
    assert.equal(published.entered, true);
    assert.equal(published.error, undefined);
    await assert.rejects(readFile(ownerPath), { code: "ENOENT" });
  }
);

test(
  "a lock directory left without an owner record is reclaimed once its grace has passed",
  { timeout: 15000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-lock-ownerless-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const target = join(root, "inbox-store.json");
    const lockPath = `${target}.lock`;
    // A claimant killed between `mkdir` and its owner write leaves exactly this.
    await mkdir(lockPath);
    // Inside the grace the directory may still be a live claimant's window, so
    // another reader must not take it.
    await assert.rejects(
      withFileLock(target, async () => "stolen", { timeoutMs: 200, retryMs: 20 }),
      /timed out acquiring file lock/
    );
    assert.equal((await stat(lockPath)).isDirectory(), true, "the fresh lock is left alone");
    // Past the grace nobody can still be writing the owner record: the next
    // reader reclaims the directory instead of waiting out the stale TTL.
    const aged = new Date(Date.now() - 10_000);
    await utimes(lockPath, aged, aged);
    assert.equal(
      await withFileLock(target, async () => "acquired", { timeoutMs: 2_000, retryMs: 20 }),
      "acquired"
    );
    await assert.rejects(readFile(`${lockPath}/owner.json`), { code: "ENOENT" });
  }
);
