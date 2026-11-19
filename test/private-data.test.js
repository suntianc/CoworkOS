import assert from "node:assert/strict";
import test from "node:test";
import { privateDataRefusal } from "../dist/src/tools/private-data.js";

const userHome = "/Users/example";
const home = "/Users/example/.atria";
const refused = (input) => privateDataRefusal(input, home, userHome)?.path;

test("the calls that reached the backend's credential are refused", () => {
  // The commands a Main ran to find and use the host credential.
  assert.equal(refused({ command: "ls -la ~/.atria 2>/dev/null | head -30" }), "~/.atria");
  assert.equal(
    refused({
      command:
        "cat /Users/example/.atria/runtime/projects.json; cat /Users/example/.atria/runtime/backend-instance.json"
    }),
    "/Users/example/.atria/runtime/projects.json"
  );
  assert.ok(refused({ command: 'sqlite3 /Users/example/.atria/runtime/project-data.sqlite ".tables"' }));
  assert.ok(refused({ command: "ls -la $HOME/.atria/runtime" }));
  assert.ok(refused({ path: "/Users/example/.atria/model-config.json" }));
  assert.ok(refused({ path: "/Users/example/.atria/pi/auth.json" }));
});

test("a path that climbs out of a working directory is refused", () => {
  assert.ok(
    refused({ command: "cat ~/.atria/runtime/development-workspaces/d1/../../backend-instance.json" })
  );
  assert.ok(refused({ command: "cd ~/.atria/runtime/development-workspaces/d1/../.. && ls" }));
  // Relative to an allowed directory, the name alone gives it away.
  assert.equal(refused({ command: "cd ../.. && cat backend-instance.json" }), "backend-instance.json");
});

test("the directories Agents work in stay reachable", () => {
  assert.equal(
    refused({ command: "cd /Users/example/.atria/runtime/development-workspaces/d1 && npm test" }),
    undefined
  );
  assert.equal(
    refused({ path: "/Users/example/.atria/workspace/task-1/agents/main/context/memory.md" }),
    undefined
  );
  assert.equal(refused({ command: "ls ~/.atria/runtime/temporary-workspaces/t1" }), undefined);
  assert.equal(refused({ command: "cd /Users/example/project/app && npm test" }), undefined);
  // A neighbour whose name only starts like the data home is not it.
  assert.equal(refused({ command: "ls ~/.atria-backup" }), undefined);
  // A generic file name can be the user's own.
  assert.equal(refused({ path: "/Users/example/project/app/credentials.json" }), undefined);
});

test("nested tool input is searched", () => {
  assert.ok(refused({ edits: [{ path: "x", content: "see ~/.atria/runtime" }] }));
});

test("CoworkOS's own program is refused, except its skills and guides", async () => {
  const { installRefusal } = await import("../dist/src/tools/private-data.js");
  const install = "/Users/example/project/CoworkOS";
  const project = "/Users/example/project/duration-kit";
  const refusedInstall = (input, directory = project) =>
    installRefusal(input, install, directory, userHome)?.path;
  // The calls a Main ran to learn why a write was refused.
  assert.equal(
    refusedInstall({ command: `cd ${install} && grep -rn "protected path" --include=*.ts src` }),
    install
  );
  assert.equal(
    refusedInstall({ path: `${install}/src/tools/protected-paths.ts` }),
    `${install}/src/tools/protected-paths.ts`
  );
  assert.ok(refusedInstall({ command: `sed -n 1,140p ${install}/dist/src/tools/protected-paths.js` }));
  assert.ok(refusedInstall({ command: "cat ~/project/CoworkOS/package.json" }));
  assert.ok(refusedInstall({ command: `cat ${install}/.pi/skills/../runtime/extension.ts` }));
  // Skills and the guides they link to are meant to be read.
  assert.equal(refusedInstall({ path: `${install}/.pi/skills/cua/SKILL.md` }), undefined);
  assert.equal(refusedInstall({ path: `${install}/docs/browser-use.md` }), undefined);
  assert.equal(refusedInstall({ command: `cd ${project} && npm test` }), undefined);
  assert.equal(refusedInstall({ command: "ls /Users/example/project/CoworkOS-fork" }), undefined);
  // When the project is CoworkOS itself, or holds it, the install is the work.
  assert.equal(refusedInstall({ path: `${install}/src/a.ts` }, install), undefined);
  assert.equal(refusedInstall({ path: `${install}/src/a.ts` }, `${install}/packages`), undefined);
  assert.equal(refusedInstall({ path: `${install}/src/a.ts` }, "/Users/example/project"), undefined);
});
