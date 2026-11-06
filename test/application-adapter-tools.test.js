import "./application-fixture.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
const { textRuntimeAdapter } =
  await import("../dist/test/fixtures/application-contract/text-runtime-adapter.js");
const { dummyCounterAdapter } = await import("../dist/src/applications/adapters/dummy-counter-adapter.js");

/**
 * Every tool an Adapter declares must work against its own application.
 *
 * The bug this file exists for: `counter_reset_all` emitted
 * `{operationType: "counter.set", payload: {key, value: 0}}` while its own
 * schema required `amount`. Every operation it produced was refused with
 * "amount 必须是数字", from the day it was written. Nothing caught it, because
 * the only test asserted the tool appeared in the model's tool list.
 *
 * A tool that emits an operation its own adapter refuses is not a tool. So
 * each one is run against a fixture and its output pushed all the way through
 * `applyOperation`, which is the only check that means anything.
 */

const cases = [
  {
    adapter: textRuntimeAdapter,
    content: "# 产品方案\n\n## 目标用户\n待补充。\n\n## 核心功能\n另外再说。\n",
    resource: { resourceId: "r", appType: "text-editor", kind: "text/markdown", title: "a.md", revision: 0 },
    // Every declared tool needs a fixture here; the assertion below fails if a
    // new one is added without it, so this table cannot quietly fall behind.
    // The anchor is deliberately unique — `patch_document` refuses an ambiguous
    // one, which is its whole point and is covered on its own below.
    calls: {
      read_document: [{}, { heading: "目标用户" }],
      outline_document: [{}],
      patch_document: [{ oldText: "待补充。", newText: "研究员和产品经理。" }],
      write_document: [{ content: "# 全新方案\n" }]
    }
  },
  {
    adapter: dummyCounterAdapter,
    content: { counters: { opened: 3, closed: 1 } },
    resource: {
      resourceId: "r",
      appType: "dummy-counter",
      kind: "model/counter+json",
      title: "c",
      revision: 0
    },
    calls: {
      list_counters: [{}],
      counter_reset_all: [{}]
    }
  }
];

for (const { adapter, content, resource, calls } of cases) {
  const appType = adapter.definition.appType;

  test(`${appType}: every declared tool emits operations its own application accepts`, async () => {
    const declared = adapter.agentTools?.() ?? [];
    assert.deepEqual(
      declared.map((tool) => tool.name).sort(),
      Object.keys(calls).sort(),
      `${appType}: every declared tool needs a fixture in this table`
    );

    for (const tool of declared) {
      for (const params of calls[tool.name]) {
        const outcome = await tool.execute({ params, content, resource });
        for (const operation of outcome.operations ?? []) {
          assert.ok(
            operation.operationType in adapter.definition.operationSchemas,
            `${tool.name} emitted an undeclared operation: ${operation.operationType}`
          );
          const schema = adapter.definition.operationSchemas[operation.operationType];
          for (const field of schema.required) {
            assert.ok(
              field in operation.payload,
              `${tool.name} emitted ${operation.operationType} without the required "${field}"`
            );
          }
          // The one that matters: the adapter's own reducer must accept it.
          assert.doesNotThrow(
            () =>
              adapter.applyOperation({
                operationType: operation.operationType,
                payload: operation.payload,
                content,
                actor: { type: "agent", id: "main" }
              }),
            `${tool.name}'s ${operation.operationType} is refused by its own application`
          );
        }
      }
    }
  });

  test(`${appType}: a bound model can read its resource without a generic tool`, async () => {
    // There is no `get_resource` any more. An application that declares no way
    // to read its own resource leaves a bound model unable to see the thing it
    // is editing — so this is a structural requirement on every adapter, now
    // and for every one added later.
    const declared = adapter.agentTools?.() ?? [];
    const reads = [];
    for (const tool of declared) {
      const outcome = await tool
        .execute({ params: calls[tool.name][0], content, resource })
        .catch(() => undefined);
      // A read reports something and changes nothing.
      if (outcome && !(outcome.operations ?? []).length && outcome.result !== undefined)
        reads.push(tool.name);
    }
    assert.ok(
      reads.length > 0,
      `${appType} declares no read-only tool; a bound model could not see its document`
    );
  });

  test(`${appType}: the shape line names what the resource is made of, never where`, () => {
    const summary = adapter.summarizeContext({ resource, content, changes: [] });
    assert.ok(summary.shape.length > 0, "a resource must say what it is made of");
    assert.equal(summary.shape.includes("\n"), false, "the shape is one line");
    for (const address of [
      /第\s*\d+\s*[行列页节个]/,
      /\b[A-Z]{1,3}\d+\s*:\s*[A-Z]{1,3}\d+/,
      /\b(line|row|col|column|page|offset|index)\s*[:#]?\s*\d+/i,
      /\[\s*\d+\s*,\s*\d+\s*[)\]]/
    ]) {
      assert.equal(
        address.test(summary.shape),
        false,
        `${appType} put an address in its shape: ${JSON.stringify(summary.shape)} matched ${address}`
      );
    }
    // And it is not a second copy of the document.
    assert.ok(summary.shape.length <= 240, `the shape is bounded, got ${summary.shape.length}`);
  });
}

test("the text editor's read tool narrows by heading rather than by offset", async () => {
  const tools = Object.fromEntries(
    (textRuntimeAdapter.agentTools?.() ?? []).map((tool) => [tool.name, tool])
  );
  const content = "# 标题\n\n## 甲\n甲的正文\n\n## 乙\n乙的正文\n";
  const resource = {
    resourceId: "r",
    appType: "text-editor",
    kind: "text/markdown",
    title: "a.md",
    revision: 7
  };

  const section = await tools.read_document.execute({ params: { heading: "甲" }, content, resource });
  assert.match(section.result.content, /甲的正文/);
  assert.equal(
    section.result.content.includes("乙的正文"),
    false,
    "a section stops at the next heading of equal rank"
  );
  assert.equal(section.result.revision, 7, "a read reports the revision a write will need");

  // A heading that is not there says which ones are, so the model can retry
  // with something real instead of guessing at a position.
  await assert.rejects(
    () => tools.read_document.execute({ params: { heading: "丙" }, content, resource }),
    (error) =>
      error.code === "operation_precondition_failed" && /甲/.test(error.message) && /乙/.test(error.message)
  );
});

test("a document past the read limit comes back with its headings, not an offset to resume from", async () => {
  const tools = Object.fromEntries(
    (textRuntimeAdapter.agentTools?.() ?? []).map((tool) => [tool.name, tool])
  );
  const content = `# 很长的文档\n${"填充段落\n".repeat(30_000)}## 末尾一节\n收尾\n`;
  const resource = {
    resourceId: "r",
    appType: "text-editor",
    kind: "text/markdown",
    title: "a.md",
    revision: 0
  };

  const read = await tools.read_document.execute({ params: {}, content, resource });
  assert.equal(read.result.truncated, true);
  assert.ok(read.result.content.length < content.length);
  // Narrowing is something a model can act on; arithmetic is what it gets
  // wrong. So the truncation hands back names, never a position to resume at.
  assert.deepEqual(read.result.headings, ["很长的文档", "末尾一节"]);
  assert.equal("endOffset" in read.result, false, "no offset to resume from");
  assert.equal("nextOffset" in read.result, false, "no offset to resume from");
});
