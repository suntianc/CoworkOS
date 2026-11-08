import { resolveModelRole } from "../dist/src/runtime/role-models.js";

/**
 * The single connection a RunService unit test describes.
 *
 * Production injects the execution host's role resolver; these tests build the
 * service by hand, so they resolve one explicit connection through the same
 * function. It keeps the base/key/model they already supplied and adds no role.
 */
export function singleConnectionMainModel({
  baseUrl = "http://127.0.0.1:1",
  apiKey = "fixture",
  model = "fixture"
} = {}) {
  return (request) => resolveModelRole({ baseUrl, apiKey, model }, request);
}
