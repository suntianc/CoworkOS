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
