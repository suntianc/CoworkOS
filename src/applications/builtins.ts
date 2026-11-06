import { ApplicationRegistry } from "./registry.js";
import { dummyCounterAdapter } from "./adapters/dummy-counter-adapter.js";

/** Trusted runtime adapters are assembled here, independently of business services. */
export function defaultRegistry(): ApplicationRegistry {
  const registry = new ApplicationRegistry();
  // A different data model exercises the contract without shipping a demo app by default.
  if (process.env.COWORK_APPLICATION_DUMMY === "1") registry.register(dummyCounterAdapter);
  return registry;
}
