import assert from "node:assert/strict";
import { test } from "node:test";
import {
  configuredWebTools,
  publicWebSearchStatus,
  saveWebSearchConfig
} from "../dist/src/runtime/web-search-config.js";

test("fresh configuration discovers anonymous Exa and an explicit choice disables it", () => {
  assert.deepEqual(configuredWebTools({}, {}), { provider: "exa", exaApiKey: undefined });
  assert.equal(configuredWebTools({}, { COWORK_WEB_TOOLS: "0" }), undefined);
  assert.equal(configuredWebTools({ webSearch: { provider: "off" } }, { COWORK_WEB_TOOLS: "1" }), undefined);
  assert.equal(configuredWebTools({ webSearch: { provider: "exa" } }, {}).provider, "exa");
  assert.throws(() => configuredWebTools({}, { COWORK_WEB_TOOLS: "off" }), /0 or 1/);
  assert.throws(() => configuredWebTools({ webSearch: { provider: "invalid" } }, {}), /provider/);
});
test("optional Exa credentials stay private, are retained or explicitly cleared", () => {
  const config = { webSearch: { provider: "exa", exaApiKey: "secret" } };
  assert.equal(publicWebSearchStatus(config, {}).authenticated, true);
  assert.doesNotMatch(JSON.stringify(publicWebSearchStatus(config, {})), /secret/);
  assert.equal(saveWebSearchConfig(config, { provider: "off" }).webSearch.exaApiKey, "secret");
  assert.equal(
    saveWebSearchConfig(config, { provider: "exa", clearExaApiKey: true }).webSearch.exaApiKey,
    undefined
  );
  assert.throws(() => saveWebSearchConfig(config, { provider: "exa", exaApiKey: "bad\nkey" }), /单行/);
  assert.throws(() => saveWebSearchConfig(config, { provider: "unknown" }), /Exa 或关闭/);
});
