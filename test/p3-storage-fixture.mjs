import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { startDashboard } from "./dashboard-fixture.mjs";

/**
 * The two real project-data engines used by the P3 contract tests.
 *
 * The PostgreSQL instance is a disposable container owned by this run: a unique
 * name, a port bound to 127.0.0.1 and synthetic credentials. Nothing global is
 * pruned; `stop` only addresses the container this fixture created, so later
 * tickets can reuse the same helper for their own runs.
 */
export const POSTGRES_IMAGE = "postgres:18.6-alpine3.24";

export const PROJECT_DATA_ENGINES = ["sqlite", "postgres"];

async function freePort() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  await new Promise((done) => probe.close(done));
  return port;
}

function runDocker(args) {
  const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output += String(chunk);
  });
  const done = new Promise((resolve, reject) => {
    child.once("error", (error) => reject(new Error(`无法运行 docker ${args.join(" ")}：${error.message}`)));
    child.once("close", (code) => resolve({ code: code ?? 1, output }));
  });
  return { child, done };
}

/** `postgresql://...` for the isolated fixture; the password is synthetic and test-only. */
export async function startPostgresProjectDatabase() {
  const suffix = randomBytes(5).toString("hex");
  const name = `coworkos-p3-${process.pid}-${suffix}`;
  const user = "coworkos_test";
  const database = "coworkos_project_data";
  const password = `fixture_${suffix}`;
  const port = await freePort();
  const launched = runDocker([
    "run",
    "--rm",
    "--name",
    name,
    "-p",
    `127.0.0.1:${port}:5432`,
    "-e",
    `POSTGRES_USER=${user}`,
    "-e",
    `POSTGRES_PASSWORD=${password}`,
    "-e",
    `POSTGRES_DB=${database}`,
    POSTGRES_IMAGE
  ]);
  const connectionString = `postgresql://${user}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}`;
  const stop = async () => {
    if (launched.child.exitCode !== null || launched.child.signalCode !== null) return;
    const exited = once(launched.child, "exit");
    runDocker(["stop", "--time", "5", name]).done.catch(() => undefined);
    await Promise.race([exited, delay(15_000)]);
  };
  try {
    for (let attempt = 0; attempt < 160; attempt += 1) {
      if (launched.child.exitCode !== null)
        throw new Error(`PostgreSQL fixture 已退出：${launched.output || "没有输出"}`);
      const client = new pg.Client({ connectionString, connectionTimeoutMillis: 1000 });
      try {
        await client.connect();
        const { rows } = await client.query("SHOW server_version");
        await client.end();
        const digest = await runDocker([
          "image",
          "inspect",
          POSTGRES_IMAGE,
          "--format",
          "{{index .RepoDigests 0}}"
        ]).done;
        return {
          name,
          port,
          connectionString,
          serverVersion: rows[0].server_version,
          image: POSTGRES_IMAGE,
          digest: digest.output.trim(),
          stop
        };
      } catch {
        await client.end().catch(() => undefined);
        await delay(250);
      }
    }
    throw new Error(`PostgreSQL fixture 在限定时间内未就绪：${launched.output}`);
  } catch (error) {
    await stop();
    throw error;
  }
}

/**
 * A real Dashboard serving one engine, sharing one request helper.
 *
 * Later P3 tickets use this instead of rebuilding the engine wiring, so the
 * SQLite and PostgreSQL runs are the same test with a different config.
 */
export async function startProjectDataDashboard(
  t,
  engine,
  { postgres, config = {}, projectData, ...options } = {}
) {
  // The SQLite run leaves `projectData` out entirely, so it also proves the
  // default engine; a caller may still pass an explicit configuration.
  const resolved =
    projectData ?? (engine === "postgres" ? projectDataConfig(engine, { postgres }) : undefined);
  const dashboard = await startDashboard({
    defaultProject: false,
    ...options,
    config: { ...config, ...(resolved ? { projectData: resolved } : {}) }
  });
  t.after(() => dashboard.stop());
  const request = async (path, body, method = "POST") => {
    const response = await fetch(`${dashboard.base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, body: await response.json() };
  };
  return { ...dashboard, request };
}

/**
 * A `projectData` configuration for one engine.
 *
 * The SQLite path is relative to the fixture's data root so a caller without
 * the dashboard root can still prepare a mode.
 */
export function projectDataConfig(engine, { sqlitePath = "project-data/ledger.sqlite", postgres } = {}) {
  if (engine === "sqlite") return { engine, sqlite: { path: sqlitePath } };
  if (!postgres?.connectionString) throw new Error("postgres 模式需要真实连接地址");
  return { engine, postgres: { connectionString: postgres.connectionString } };
}
