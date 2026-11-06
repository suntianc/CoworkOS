import { ApplicationRegistry } from "../../../dist/src/applications/registry.js";
import { textRuntimeAdapter } from "../../../dist/test/fixtures/application-contract/text-runtime-adapter.js";
import { dummyCounterAdapter } from "../../../dist/src/applications/adapters/dummy-counter-adapter.js";

// A second registration of the counter model whose MCP server refuses stdin
// EOF and SIGTERM. Shutdown regressions use it to hold teardown open; no other
// fixture sees it.
const slowShutdownAdapter =
  process.env.COWORK_APPLICATION_SLOW_SHUTDOWN === "1"
    ? {
        ...dummyCounterAdapter,
        definition: {
          ...dummyCounterAdapter.definition,
          appType: "slow-shutdown",
          displayName: "慢关闭夹具",
          mcpServer: {
            command: process.execPath,
            args: ["test/fixtures/mcp-slow-shutdown-server.mjs"]
          }
        }
      }
    : undefined;

export function defaultRegistry() {
  const registry = new ApplicationRegistry().register(textRuntimeAdapter);
  if (process.env.COWORK_APPLICATION_DUMMY === "1") registry.register(dummyCounterAdapter);
  if (slowShutdownAdapter) registry.register(slowShutdownAdapter);
  return registry;
}
