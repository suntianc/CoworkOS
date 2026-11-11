import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { createWebTools } from "../dist/src/tools/web-tools.js";
import { normalizeExaSources } from "../dist/src/tools/exa-search-provider.js";

async function fixture(t, handle, { sse = false } = {}) {
  const keys = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"];
  const saved = keys.map((key) => [key, process.env[key]]);
  for (const key of keys) delete process.env[key];
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req.setEncoding("utf8")) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ body, headers: req.headers, method: req.method, url: req.url });
    if (req.method === "DELETE") {
      res.writeHead(200);
      return res.end();
    }
    if (req.method === "GET") {
      res.writeHead(405);
      return res.end();
    }
    if (body.method?.startsWith("notifications/")) {
      res.writeHead(202);
      return res.end();
    }
    const respond = (result) => {
      const text = JSON.stringify({ jsonrpc: "2.0", id: body.id, result });
      res.writeHead(200, {
        "content-type": sse ? "text/event-stream" : "application/json",
        "mcp-session-id": "fixture-session"
      });
      res.end(sse ? `event: message\ndata: ${text}\n\n` : text);
    };
    if (body.method === "initialize")
      return respond({
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1" }
      });
    if (body.method === "tools/list") return respond({ tools: [] });
    await handle({ req, res, body, respond });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });
  return {
    requests,
    server,
    endpoint: `http://127.0.0.1:${server.address().port}/mcp`,
    tools: (options = {}) =>
      createWebTools({
        provider: "exa",
        exaEndpoint: `http://127.0.0.1:${server.address().port}/mcp`,
        ...options
      })
  };
}
for (const sse of [false, true])
  test(`anonymous Exa ${sse ? "SSE" : "JSON"} initialization, source search/fetch, protocol/session and limited tools`, async (t) => {
    const service = await fixture(
      t,
      ({ body, respond }) => {
        if (body.params.name === "web_search_exa")
          respond({
            content: [
              {
                type: "text",
                text: "Title: Paper\nURL: https://example.org/paper\nPublished: 2026-10-01\nHighlights:\nPublic evidence.\n\n---\n\nTitle: Undated\nURL: https://example.org/page\nPublished: N/A\nHighlights:\nOther evidence."
              }
            ]
          });
        else
          respond({
            content: [
              { type: "text", text: "# Paper\nURL: https://example.org/paper\n\nFull public source body." }
            ]
          });
      },
      { sse }
    );
    const tools = service.tools();
    const search = await tools.get("search").execute({ query: "recent paper", numResults: 2 });
    assert.equal(search.sources[0].title, "Paper");
    assert.equal(search.sources[0].date, "2026-10-01");
    assert.equal(search.sources[1].date, undefined);
    assert.equal(search.organic[0].link, "https://example.org/paper");
    assert.match(search.sources[0].text, /Public evidence/);
    const page = await tools.get("visit").execute({ url: search.sources[0].url });
    assert.equal(page.title, "Paper");
    assert.match(page.content, /Full public source body/);
    const calls = service.requests.filter((request) => request.body.method === "tools/call");
    assert.deepEqual(
      calls.map((request) => request.body.params.name),
      ["web_search_exa", "web_fetch_exa"]
    );
    assert.equal(calls[0].headers["mcp-session-id"], "fixture-session");
    assert.equal(calls[0].headers["mcp-protocol-version"], "2025-11-25");
    assert.equal(calls[0].headers["x-api-key"], undefined);
    assert.match(calls[0].headers.accept, /application\/json/);
    assert.match(calls[0].headers.accept, /text\/event-stream/);
    assert.match(calls[0].body.params.arguments.objective, /recent paper/);
    assert.ok(
      service.requests.every(
        (request) =>
          request.url === "/mcp?tools=web_search_exa%2Cweb_fetch_exa" ||
          request.url === "/mcp?tools=web_search_exa,web_fetch_exa"
      )
    );
    assert.equal(service.requests.filter((request) => request.method === "DELETE").length, 2);
  });
for (const code of [429, 402, 401, 503])
  test(`HTTP ${code} is a safe tool failure, never zero results`, async (t) => {
    const service = await fixture(t, ({ res }) => {
      res.writeHead(code);
      res.end("fixture-secret private error");
    });
    await assert.rejects(
      service.tools({ exaApiKey: "fixture-secret" }).get("search").execute({ query: "test" }),
      (error) => error.message.includes(`HTTP ${code}`) && !error.message.includes("fixture-secret")
    );
  });
test("MCP isError, invalid results and explicit empty results stay distinct", async (t) => {
  const service = await fixture(t, ({ body, respond }) =>
    respond(
      body.params.arguments.query === "empty"
        ? { content: [], structuredContent: { results: [] } }
        : { isError: true, content: [{ type: "text", text: "quota exhausted fixture-secret" }] }
    )
  );
  assert.deepEqual((await service.tools().get("search").execute({ query: "empty" })).sources, []);
  await assert.rejects(service.tools().get("search").execute({ query: "error" }), /HTTP 402/);
  assert.throws(
    () => normalizeExaSources({ content: [{ type: "text", text: "bad format" }] }, 500),
    /来源格式/
  );
  assert.equal(
    normalizeExaSources(
      {
        structuredContent: {
          results: [
            { title: "Structured", url: "https://example.org", text: "body", publishedDate: "2026-10-01" }
          ]
        }
      },
      500
    ).sources[0].title,
    "Structured"
  );
});
test(
  "cancel/timeout close stalled MCP streams and anonymous failures need no fallback key",
  { timeout: 5000 },
  async (t) => {
    let arrived;
    const called = new Promise((done) => {
      arrived = done;
    });
    const service = await fixture(t, ({ res }) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": pending\n\n");
      arrived();
    });
    const controller = new AbortController();
    const pending = service.tools().get("search").execute({ query: "test" }, controller.signal);
    await called;
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    await assert.rejects(service.tools({ timeoutMs: 80 }).get("search").execute({ query: "timeout" }), {
      name: "TimeoutError"
    });
  }
);
test("Exa honors the shared CONNECT proxy with independent request cleanup", async (t) => {
  const service = await fixture(t, ({ respond }) =>
    respond({ content: [], structuredContent: { results: [] } })
  );
  const tunnels = new Set();
  let connects = 0;
  const proxy = createServer();
  proxy.on("connect", (_req, socket, head) => {
    connects++;
    const upstream = createConnection(service.server.address().port, "127.0.0.1");
    tunnels.add(socket);
    tunnels.add(upstream);
    upstream.once("connect", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    socket.on("error", () => {});
    upstream.on("error", () => {});
    socket.on("close", () => {
      tunnels.delete(socket);
      upstream.destroy();
    });
    upstream.on("close", () => {
      tunnels.delete(upstream);
      socket.destroy();
    });
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  t.after(async () => {
    for (const socket of tunnels) socket.destroy();
    await new Promise((done) => proxy.close(done));
  });
  process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.address().port}`;
  process.env.NO_PROXY = "";
  const tools = service.tools({
    exaEndpoint: `http://exa.fixture.test:${service.server.address().port}/mcp`
  });
  assert.deepEqual((await tools.get("search").execute({ query: "proxy" })).sources, []);
  assert.ok(connects > 0);
  await new Promise((done) => setTimeout(done, 25));
  assert.equal(tunnels.size, 0, "completed Exa call releases owned proxy tunnels");
});

test("disconnected service, oversized bodies and invalid JSON are tool errors with no source claims", async (t) => {
  const service = await fixture(t, ({ res, body }) => {
    if (body.params.arguments.query === "offline") return res.destroy();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(body.params.arguments.query === "oversize" ? "x".repeat(2048) : "not-json fixture-secret");
  });
  const search = service.tools({ maxContentBytes: 1024, exaApiKey: "fixture-secret" }).get("search");
  for (const query of ["offline", "oversize", "invalid"])
    await assert.rejects(
      search.execute({ query }),
      (error) => /Exa/.test(error.message) && !error.message.includes("fixture-secret")
    );
  assert.throws(() => normalizeExaSources({ content: [] }, 500), /来源格式/);
  assert.throws(
    () => normalizeExaSources({ structuredContent: { results: [{ title: "missing URL" }] } }, 500),
    /来源格式/
  );
});

const fetchText = (text) => ({ content: [{ type: "text", text }] });
const requestedFetchUrl = "https://example.org/page";
const invalidFetchReplies = {
  "JSON empty results": fetchText(JSON.stringify({ results: [] })),
  "JSON invalid source URL": fetchText(
    JSON.stringify({ results: [{ title: "failed fetch", url: "invalid-url" }] })
  ),
  "JSON invalid results type": fetchText(JSON.stringify({ results: {} })),
  "JSON error envelope": fetchText(JSON.stringify({ error: "fetch failed" })),
  "nested JSON empty results": fetchText(JSON.stringify({ data: { results: [] } })),
  "nested JSON invalid source": fetchText(
    JSON.stringify({ structuredContent: { results: [{ url: "invalid-url" }] } })
  ),
  "structured empty results with wrapper prose": {
    ...fetchText("Wrapper text must not become source evidence."),
    structuredContent: { results: [] }
  },
  "nested structured empty results with labelled prose": {
    ...fetchText(`Title: Wrapper\nURL: ${requestedFetchUrl}\n\nWrapper text.`),
    structuredContent: { data: { results: [] } }
  },
  "structured missing source body": {
    content: [],
    structuredContent: { results: [{ title: "No body", url: requestedFetchUrl }] }
  },
  "structured blank source body with JSON wrapper": {
    ...fetchText(JSON.stringify({ results: [{ title: "No body", url: requestedFetchUrl }] })),
    structuredContent: { results: [{ title: "No body", url: requestedFetchUrl, text: " " }] }
  },
  "structured ambiguous unrelated sources": {
    content: [],
    structuredContent: {
      results: [
        { url: "https://example.org/unrelated", text: "Other source evidence." },
        { url: "https://example.org/another", text: "Another source evidence." }
      ]
    }
  },
  "labelled ambiguous unrelated sources": fetchText(
    "Title: Other\nURL: https://example.org/unrelated\n\nOther source evidence.\n---\nTitle: Another\nURL: https://example.org/another\n\nAnother source evidence."
  ),
  "labelled malformed URL": fetchText("Title: Failed\nURL: https://\n\nInvalid source."),
  "labelled metadata only": fetchText(`Title: No body\nURL: ${requestedFetchUrl}\nPublished: N/A`),
  "heading metadata only": fetchText(`# No body\nURL: ${requestedFetchUrl}\n\n`),
  "blank text": fetchText(" \n "),
  "explicit no results": fetchText("No results found."),
  "empty content": { content: [] }
};
for (const [name, result] of Object.entries(invalidFetchReplies))
  test(`real MCP fetch rejects ${name} instead of claiming source evidence`, async (t) => {
    const service = await fixture(t, ({ respond }) => respond(result));
    await assert.rejects(service.tools().get("visit").execute({ url: requestedFetchUrl }), /Exa/);
  });

test("real MCP fetch retains genuine raw, labelled and structured source bodies with requested provenance", async (t) => {
  const replies = [
    fetchText("# Raw source\n\nGenuine raw webpage evidence."),
    {
      content: [],
      structuredContent: {
        results: [
          { url: requestedFetchUrl, text: "" },
          { url: "https://example.org/other", text: "Other body." },
          { url: requestedFetchUrl, text: "Genuine matching evidence." }
        ]
      }
    },
    fetchText(`Title: Paper\nURL: ${requestedFetchUrl}\nPublished: 2026-10-01\n\nGenuine labelled evidence.`),
    {
      content: [],
      structuredContent: {
        results: [{ title: "Paper", url: requestedFetchUrl, text: "Genuine structured evidence." }]
      }
    },
    fetchText(
      JSON.stringify({
        results: [{ title: "Paper", url: requestedFetchUrl, text: "Genuine JSON evidence." }]
      })
    ),
    {
      content: [],
      structuredContent: {
        data: { results: [{ title: "Paper", url: requestedFetchUrl, text: "Genuine nested evidence." }] }
      }
    },
    {
      content: [],
      structuredContent: {
        results: [{ url: `${requestedFetchUrl}#section`, text: "Genuine anchored evidence." }]
      }
    }
  ];
  let index = 0;
  const service = await fixture(t, ({ respond }) => respond(replies[index++]));
  for (const reply of replies) {
    const page = await service.tools().get("visit").execute({ url: requestedFetchUrl });
    assert.equal(page.status, 200, JSON.stringify(reply));
    assert.match(page.content, /Genuine/);
    assert.ok(page.url.startsWith(requestedFetchUrl));
    assert.doesNotMatch(page.content, /"results"|"structuredContent"/);
  }
});

test("real MCP single-URL fetch preserves redirected source URLs and canonical provenance", async (t) => {
  const finalUrl = "https://example.org/final-page";
  const replies = [
    fetchText(`# Redirected page\nURL: ${finalUrl}\n\nGenuine redirected labelled evidence.`),
    {
      content: [],
      structuredContent: { results: [{ url: finalUrl, text: "Genuine redirected structured evidence." }] }
    },
    fetchText(
      JSON.stringify({ data: { results: [{ url: finalUrl, text: "Genuine redirected JSON evidence." }] } })
    ),
    {
      content: [],
      structuredContent: {
        results: [{ url: "https://EXAMPLE.ORG:443/page#part", text: "Genuine canonical evidence." }]
      }
    }
  ];
  let index = 0;
  const service = await fixture(t, ({ respond }) => respond(replies[index++]));
  for (let i = 0; i < replies.length; i++) {
    const page = await service.tools().get("visit").execute({ url: requestedFetchUrl });
    assert.equal(page.status, 200);
    assert.match(page.content, /Genuine/);
    assert.equal(page.url, i === 3 ? `${requestedFetchUrl}#part` : finalUrl);
  }
});
