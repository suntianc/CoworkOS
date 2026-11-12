import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";
import { CoordinatorWorker } from "../dist/src/runtime/worker.js";

const loops = {
  worker: () => {
    const loop = new CoordinatorWorker({ recoverRun: async () => [] });
    return { loop, run: (options) => loop.run({ pollMs: 250, ...options }) };
  }
};

for (const [name, create] of Object.entries(loops)) {
  test(`${name} releases the abort listener after every completed polling wait`, async () => {
    const controller = new AbortController();
    const { loop, run } = create();
    let cycles = 0;
    await run({
      signal: controller.signal,
      onCycle: () => {
        assert.equal(getEventListeners(controller.signal, "abort").length, 0);
        if (++cycles === 4) loop.stop();
      }
    });
    assert.equal(cycles, 4);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });

  test(`${name} cancels a pending wait and leaves no abort listener`, async () => {
    const controller = new AbortController();
    const { run } = create();
    let cycles = 0;
    await run({
      signal: controller.signal,
      onCycle: () => {
        cycles++;
        setImmediate(() => controller.abort());
      }
    });
    assert.equal(cycles, 1);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });
}
