import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

/** Deliberately has no duplicate-submission protection: each POST creates a receipt. */
export async function cuaProgressFixture(directory, operation) {
  const ledgerPath = join(directory, "receipts.json");
  await writeFile(ledgerPath, "[]\n");
  const requests = [];
  const failures = [];
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://fixture");
      requests.push({ method: request.method, path: url.pathname });
      if (request.method === "POST" && url.pathname === "/submit") {
        let body = "";
        for await (const chunk of request.setEncoding("utf8")) body += chunk;
        if (JSON.parse(body).operation !== operation) throw new Error("Wrong submission operation");
        const receipts = JSON.parse(await readFile(ledgerPath, "utf8"));
        receipts.push({ operation, receiptId: `receipt-${receipts.length + 1}`, saved: true });
        await writeFile(ledgerPath, `${JSON.stringify(receipts)}\n`);
        response.writeHead(202, { "content-type": "application/json" });
        return response.end('{"acceptedForProcessing":true}');
      }
      const receipts = JSON.parse(await readFile(ledgerPath, "utf8"));
      const receipt = receipts.find((item) => item.operation === operation);
      if (url.pathname === "/receipt") {
        if (!receipt) {
          response.writeHead(404);
          return response.end("Receipt not found");
        }
        response.writeHead(200, {
          "content-type": "application/json",
          "content-disposition": 'attachment; filename="receipt.json"'
        });
        return response.end(`${JSON.stringify(receipt)}\n`);
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      if (url.pathname === "/status")
        return response.end(`<!doctype html><title>Live submission status</title>
          <h1>Submission status</h1><p role="status">${receipt ? `Saved ${receipt.receiptId} for ${operation}` : "No saved receipt"}</p>
          ${receipt ? '<a href="/receipt" download>Download receipt</a>' : ""}`);
      response.end(`<!doctype html><title>Submit report</title>
        <button id="submit">Submit report</button><p role="status" id="status">Ready</p>
        <script>document.querySelector('#submit').onclick=async()=>{
          await fetch('/submit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({operation:${JSON.stringify(operation)}})});
          document.querySelector('#status').textContent='Request dispatched; business result unverified';
        }</script>`);
    } catch (error) {
      failures.push(error.stack ?? error.message);
      response.writeHead(500);
      response.end("Fixture failed");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    requests,
    failures,
    async receipts() {
      return JSON.parse(await readFile(ledgerPath, "utf8"));
    },
    receiptBytes(receipt) {
      const bytes = Buffer.from(`${JSON.stringify(receipt)}\n`);
      return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
    },
    async close() {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
  };
}
