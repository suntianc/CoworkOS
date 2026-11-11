import { once } from "node:events";
import { createServer } from "node:http";
import { cp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startDashboard } from "../../test/dashboard-fixture.mjs";
import { readFixtureRequestBody } from "../../test/http-request-body-fixture.mjs";

/** A reply with the blocks a long working session tends to carry. */
export function longReply(index) {
  return [
    `## 第 ${index + 1} 轮结果`,
    "",
    `主要改动在 \`web/assets/module-${index}.js:${40 + index}\` 和 \`config-${index}.json\`。`,
    "",
    "| 阶段 | 旧来源 | 新来源 |",
    "|---|---|---|",
    ...Array.from({ length: 6 }, (_, row) => `| 行 ${row} | 旧值 ${index}-${row} | 新值 ${index}-${row} |`),
    "",
    "```typescript",
    ...Array.from(
      { length: 40 },
      (_, line) => `export const value${line} = compute(${index}, ${line}); // 第 ${line} 行说明`
    ),
    "```",
    "",
    "- [x] 已完成第一项",
    "- [ ] 还要补测试",
    "",
    "其余说明：".concat("这一段是正常的正文，用来模拟较长的回复内容。".repeat(8))
  ].join("\n");
}

function chunk(response, delta, finish = null) {
  response.write(
    `data: ${JSON.stringify({ id: "perf", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
  );
}

/**
 * The provider answers each request in turn from `script`: a tool call, a
 * final reply, or a reply streamed in many small deltas.
 */
export async function startPerfDashboard() {
  const queue = [];
  const provider = createServer(async (request, response) => {
    await readFixtureRequestBody(request);
    if (request.method !== "POST") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
      return;
    }
    const step = queue.shift() ?? { text: "多余的请求。" };
    response.writeHead(200, { "content-type": "text/event-stream" });
    chunk(response, { role: "assistant" });
    if (step.tool) {
      chunk(response, {
        tool_calls: [
          {
            index: 0,
            id: step.tool.id,
            type: "function",
            function: { name: "bash", arguments: JSON.stringify({ command: step.tool.command }) }
          }
        ]
      });
      chunk(response, {}, "tool_calls");
    } else if (step.stream) {
      for (const piece of step.stream) {
        chunk(response, { content: piece });
        await new Promise((done) => setTimeout(done, step.interval ?? 16));
      }
      chunk(response, {}, "stop");
    } else {
      chunk(response, { content: step.text });
      chunk(response, {}, "stop");
    }
    response.end("data: [DONE]\n\n");
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  const dashboard = await startDashboard({
    modelEndpoint: `http://127.0.0.1:${provider.address().port}`,
    model: "fixture-model"
  });
  return {
    ...dashboard,
    queue,
    async stop() {
      await dashboard.stop();
      provider.closeAllConnections();
      await new Promise((done) => provider.close(done));
    }
  };
}

const shift = (value, offset) => {
  if (Array.isArray(value)) return value.map((item) => shift(item, offset));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (key === "timestamp" && typeof item === "number") return [key, item + offset];
      if (
        ["timestamp", "createdAt", "occurredAt", "updatedAt", "startedAt", "completedAt"].includes(key) &&
        typeof item === "string" &&
        Number.isFinite(Date.parse(item))
      )
        return [key, new Date(Date.parse(item) + offset).toISOString()];
      return [key, shift(item, offset)];
    })
  );
};

/**
 * Turn one recorded round into many: each copy of the Run directory is the
 * same round, later in time, so the conversation replays as `rounds` rounds
 * with all their tool steps, read from the same files the product reads.
 */
export async function cloneRounds(workspaceRoot, taskId, rounds) {
  const runs = join(workspaceRoot, taskId, "runs");
  const [source] = (await readdir(runs, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  const files = ["runtime-output.log", "run_events.jsonl", "run.json"];
  const original = Object.fromEntries(
    await Promise.all(
      files.map(async (name) => [name, await readFile(join(runs, source.name, name), "utf8").catch(() => "")])
    )
  );
  for (let copy = 1; copy < rounds; copy += 1) {
    const offset = -copy * 120_000;
    const target = join(runs, `${source.name}-r${String(copy).padStart(4, "0")}`);
    await cp(join(runs, source.name), target, { recursive: true });
    for (const name of files) {
      if (!original[name]) continue;
      // Each copy is its own round: ids that identify a message or request
      // get a copy-specific variant of the same shape.
      const text = original[name].replace(
        /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{8})[0-9a-f]{4}/g,
        (_match, head) => `${head}${copy.toString(16).padStart(4, "0")}`
      );
      const lines = text.split("\n").map((line) => {
        if (!line.trim()) return line;
        try {
          return JSON.stringify(shift(JSON.parse(line), offset));
        } catch {
          return line;
        }
      });
      await writeFile(join(target, name), lines.join("\n"));
    }
  }
}
