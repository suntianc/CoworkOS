// Explicit test-only registry injection. Production tests must not import this file.
// Dynamic imports in contract tests ensure the hook is installed before services load.
import { registerHooks } from "node:module";
const production = new URL("../dist/src/applications/builtins.js", import.meta.url).href;
const fixture = new URL("./fixtures/application-contract/builtins.mjs", import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    return resolved.url === production ? { ...resolved, url: fixture } : resolved;
  }
});
// Dashboard, MCP and Pi subprocesses in these tests use the same test registry.
export const applicationFixtureNodeOptions = `--import=${import.meta.url}`;
const preload = applicationFixtureNodeOptions;
if (!(process.env.NODE_OPTIONS || "").includes(preload))
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ""} ${preload}`.trim();
