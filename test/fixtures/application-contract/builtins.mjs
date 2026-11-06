import { ApplicationRegistry } from "../../../dist/src/applications/registry.js";
import { textRuntimeAdapter } from "../../../dist/test/fixtures/application-contract/text-runtime-adapter.js";
import { dummyCounterAdapter } from "../../../dist/src/applications/adapters/dummy-counter-adapter.js";
export function defaultRegistry() {
  const registry = new ApplicationRegistry().register(textRuntimeAdapter);
  if (process.env.COWORK_APPLICATION_DUMMY === "1") registry.register(dummyCounterAdapter);
  return registry;
}
