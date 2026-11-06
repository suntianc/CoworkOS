import assert from "node:assert/strict";
import { test } from "node:test";
import { ESLint } from "eslint";

const eslint = new ESLint();
async function imports(filePath, source) {
  const [result] = await eslint.lintText(source, { filePath });
  return result.messages.filter((message) => message.ruleId === "no-restricted-imports");
}

test("shared modules cannot import a CLI entrypoint or dashboard orchestration", async () => {
  for (const file of ["src/runtime/worker.ts", "src/applications/registry.ts"]) {
    for (const target of ["../cli/cowork.js", "../dashboard/application.js"]) {
      assert.equal((await imports(file, `import { example } from "${target}";`)).length, 1);
    }
  }
  assert.equal(
    (
      await imports(
        "src/applications/mcp/local-api-client.ts",
        'import { example } from "../../cli/cowork.js";'
      )
    ).length,
    1
  );
  assert.equal(
    (await imports("src/runtime/worker.ts", 'import { example } from "../domain/types.js";')).length,
    0
  );
  assert.equal(
    (await imports("src/cli/dashboard.ts", 'import { example } from "../dashboard/application.js";')).length,
    0
  );
});

test("HTTP routers cannot launch processes and run orchestration cannot write HTTP responses", async () => {
  for (const file of [
    "src/dashboard/routes.ts",
    "src/dashboard/application-routes.ts",
    "src/dashboard/computer-routes.ts",
    "src/dashboard/upload-routes.ts"
  ]) {
    for (const target of ["node:child_process", "../runtime/process-host.js"]) {
      assert.equal((await imports(file, `import { example } from "${target}";`)).length, 1);
    }
    assert.equal((await imports(file, 'import { example } from "./http.js";')).length, 0);
  }
  for (const target of ["node:http", "./http.js"]) {
    assert.equal(
      (await imports("src/dashboard/run-service.ts", `import { example } from "${target}";`)).length,
      1
    );
  }
  assert.equal(
    (await imports("src/dashboard/run-service.ts", 'import { example } from "../runtime/process-host.js";'))
      .length,
    0
  );
});

test("GUI drivers remain independent of application persistence and CLI hosts", async () => {
  for (const target of [
    "../applications/application-service.js",
    "../dashboard/routes.js",
    "../cli/cowork.js"
  ]) {
    assert.equal(
      (await imports("src/gui/macos-driver.ts", `import { example } from "${target}";`)).length,
      1
    );
  }
});
