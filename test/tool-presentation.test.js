import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { presentToolCall, toolArgumentSummary, friendlyToolName } from "../web/assets/tool-presentation.js";
import { escapeHtml } from "../web/assets/workbench/html.js";

const args = { command: "python3 agents/main/work/create_harness_ppt.py", timeout: 120 };
const envelope = (details) => ({
  content: [{ type: "text", text: JSON.stringify(details) }],
  details,
  ...(details.isError === true ? { isError: true } : {})
});
const command = (overrides = {}) => ({ name: "bash", arguments: JSON.stringify(args), ...overrides });
const result = (overrides = {}) =>
  envelope({
    command: "python3",
    args: ["agents/main/work/create_harness_ppt.py"],
    cwd: "/synthetic/project",
    stdout: "",
    stderr: "",
    exitCode: 0,
    ...overrides
  });

test("a Python command describes its actual action and script, never a guessed successful deliverable", () => {
  const presentation = presentToolCall(command());
  assert.equal(presentation.title, "运行 Python 脚本");
  assert.equal(presentation.subject, "create_harness_ppt.py");
  assert.equal(presentation.status, "running");
  assert.equal(presentation.resultSummary, "");
  assert.equal(presentation.durationLabel, "");
  assert.doesNotMatch(
    [presentation.title, presentation.subject, presentation.summary].join(" "),
    /command=|timeout=|生成.*成功|PPT.*完成/
  );
  assert.match(presentation.details, /python3 agents\/main\/work\/create_harness_ppt\.py/);
  assert.match(presentation.details, /"timeout": 120/);
  assert.equal(toolArgumentSummary(JSON.stringify(args)), "create_harness_ppt.py");
});

test("successful command evidence remains distinct from artifact validation and the requested deadline", () => {
  const presentation = presentToolCall(
    command({ completed: true, result: result(), startedAt: 1000, endedAt: 2250 })
  );
  assert.equal(presentation.statusLabel, "调用完成");
  assert.equal(presentation.resultSummary, "命令执行完成");
  assert.equal(presentation.durationMs, 1250);
  assert.equal(presentation.durationLabel, "1.3 秒");
  assert.equal(presentation.failureReason, "");
  assert.doesNotMatch(presentation.resultSummary, /已生成|PPT|文件已创建/);
  const unmeasured = presentToolCall(command({ completed: true, result: result({ durationMs: 120000 }) }));
  assert.equal(unmeasured.durationMs, undefined);
  assert.equal(unmeasured.durationLabel, "");
});

test("literal command descriptions support quoted names, argv, inline code and modules without evaluating shell syntax", () => {
  for (const [arguments_, title, subject] of [
    [{ command: "python3 'work/report draft.py'" }, "运行 Python 脚本", "report draft.py"],
    [{ command: "/usr/bin/python3", args: ["-u", "work/check.py"] }, "运行 Python 脚本", "check.py"],
    [{ command: "python3 -m pytest" }, "运行 Python 模块", "pytest"],
    [{ command: "python3 -c 'print(1)'" }, "运行 Python 代码", "内联代码"],
    [{ command: "node scripts/check.mjs" }, "运行 Node.js 脚本", "check.mjs"],
    [{ command: "python3 report.py --help" }, "运行 Python 脚本", "report.py"],
    [{ command: "node report.js -e value" }, "运行 Node.js 脚本", "report.js"],
    [{ command: "node --require preload.js main.js" }, "运行 Node.js 脚本", "main.js"],
    [{ command: "node --import preload.mjs main.mjs" }, "运行 Node.js 脚本", "main.mjs"],
    [{ command: "python3", args: ["report.py", "&&", "echo", "ready"] }, "执行组合命令", "python3 等命令"],
    [{ command: "npm run test:browser" }, "运行测试", "npm run test:browser"],
    [{ command: "python3 work/create.py && echo ready" }, "执行组合命令", "python3 等命令"],
    [{ command: "python3 $(touch /synthetic/should-not-exist).py" }, "执行组合命令", "python3"]
  ]) {
    const presentation = presentToolCall({ name: "bash", arguments: arguments_ });
    assert.equal(presentation.title, title);
    assert.equal(presentation.subject, subject);
  }
});

test("partial streamed arguments and unknown configuration fields stay in the technical disclosure", () => {
  assert.equal(toolArgumentSummary('{"command":"python3 work/create'), "");
  const presentation = presentToolCall({
    name: "custom_tool",
    arguments: { timeout: 120, retry: 3, evalToken: "synthetic-secret" }
  });
  assert.equal(presentation.subject, "");
  assert.equal(presentation.summary, "");
  assert.match(presentation.details, /synthetic-secret/);
  assert.equal(toolArgumentSummary({ timeout: 120, retry: 3 }), "");
  assert.equal(toolArgumentSummary({ query: "界".repeat(200) }, 170).length, 170);
});

test("file actions retain useful relative objects and only count returned content", () => {
  const presentation = presentToolCall(
    {
      name: "read_file",
      arguments: { path: "/projects/demo/task/artifacts/结果.md", limit: 500 },
      completed: true,
      result: envelope({ content: "one\ntwo", path: "artifacts/结果.md" })
    },
    { workspaceRoot: "/projects/demo", taskId: "task" }
  );
  assert.equal(presentation.title, "读取文件");
  assert.equal(presentation.subject, "artifacts/结果.md");
  assert.equal(presentation.resultSummary, "返回 2 行内容");
  assert.match(presentation.details, /\/projects\/demo\/task\/artifacts\/结果.md/);
  assert.equal(
    presentToolCall(
      { name: "read", arguments: { path: "/projects/demolition/file.md" } },
      { workspaceRoot: "/projects/demo" }
    ).subject,
    "…/demolition/file.md"
  );
});

test("compact file subjects retain workspace context and keep full external paths in details", () => {
  for (const [path, subject] of [
    ["/Users/fixture/Documents/research/draft.md", "…/research/draft.md"],
    ["C:\\Users\\fixture\\Documents\\research\\draft.md", "…/research/draft.md"],
    ["\\\\fixture-server\\share\\research\\draft.md", "…/research/draft.md"]
  ]) {
    const presentation = presentToolCall({ name: "read_file", arguments: { path } });
    assert.equal(presentation.subject, subject);
    const parameters = JSON.parse(
      presentation.detailSections.find((section) => section.label === "参数").text
    );
    assert.equal(parameters.path, path);
  }
  const inside = presentToolCall(
    { name: "read_file", arguments: { path: "C:\\workspace\\task\\artifacts\\draft.md" } },
    { workspaceRoot: "C:\\workspace", taskId: "task" }
  );
  assert.equal(inside.subject, "artifacts/draft.md");
});

test("command file subjects and search scopes shorten machine paths without changing literal commands", () => {
  for (const [commandText, subject, summary] of [
    ["ls /Users/fixture/Documents/research", "…/Documents/research", ""],
    ["find /Users/fixture/Documents/research -name '*.md'", "…/Documents/research", "匹配：*.md"],
    ["pytest /Users/fixture/Documents/research/test.py", "…/research/test.py", ""],
    ["rg TODO /Users/fixture/Documents/research", "TODO", "范围：…/Documents/research"]
  ]) {
    const presentation = presentToolCall({ name: "bash", arguments: { command: commandText } });
    assert.equal(presentation.subject, subject);
    assert.equal(presentation.summary, summary);
    const parameters = JSON.parse(
      presentation.detailSections.find((section) => section.label === "参数").text
    );
    assert.equal(parameters.command, commandText);
  }
});

test("unknown technical failures stay complete in details with a short readable collapsed reason", () => {
  const diagnostic = "RuntimeError: unable to process /Users/fixture/Documents/private/report.md\n".repeat(
    20
  );
  const presentation = presentToolCall({
    name: "read_file",
    arguments: { path: "/Users/fixture/Documents/private/report.md" },
    completed: true,
    failed: true,
    result: envelope({ error: diagnostic })
  });
  assert.equal(presentation.status, "failed");
  assert.equal(presentation.failureReason, "执行未成功，展开查看详情");
  const returned = JSON.parse(
    presentation.detailSections.find((section) => section.label === "返回结果").text
  );
  assert.equal(returned.details.error, diagnostic);
});

test("search previews explain the query and actual returned count rather than parameter budgets", () => {
  const presentation = presentToolCall({
    name: "search_files",
    arguments: { path: "src", pattern: "TODO", limit: 100 },
    completed: true,
    result: envelope({ matches: [{ path: "a.js" }, { path: "b.js" }] })
  });
  assert.equal(presentation.title, "搜索文件内容");
  assert.equal(presentation.subject, "src");
  assert.equal(presentation.summary, "TODO");
  assert.equal(presentation.resultSummary, "返回 2 项结果");
  assert.doesNotMatch(presentation.summary, /limit|100|pattern=/);
});

test("delegation names the concrete task without exposing coordination parameters in its preview", () => {
  const presentation = presentToolCall({
    name: "call_subagent",
    arguments: { task: "核对 README 启动步骤", mode: "async" },
    completed: true,
    result: envelope({ name: "Ara", callId: "synthetic-call" })
  });
  assert.equal(presentation.title, "委派任务");
  assert.equal(presentation.subject, "Ara");
  assert.equal(presentation.summary, "核对 README 启动步骤");
  assert.match(presentation.details, /"mode": "async"/);
});

test("specific failures require actual diagnostics, including the real missing script and syntax scenarios", () => {
  for (const [stderr, explanation, exitCode] of [
    [
      "Error: Cannot find module '/synthetic/skills/office-documents/scripts/check_backend.mjs'\ncode: 'MODULE_NOT_FOUND'\nCommand exited with code 1",
      "Node.js 脚本或模块不存在",
      1
    ],
    [
      "Traceback (most recent call last):\nModuleNotFoundError: No module named 'pptx'",
      "缺少 Python 模块：pptx",
      1
    ],
    [
      "/usr/bin/python3: can't open file '/synthetic/project/agents/main/work/create_harness_ppt.py': [Errno 2] No such file or directory\nCommand exited with code 2",
      "文件或目录不存在",
      2
    ],
    ["FileNotFoundError: [Errno 2] No such file or directory: 'input.csv'", "文件或目录不存在", 1],
    ["PermissionError: [Errno 13] Permission denied: 'protected.txt'", "没有访问权限", 1],
    [
      "  File 'create_harness_ppt.py', line 226\nSyntaxError: EOL while scanning string literal",
      "Python 第 226 行语法错误",
      1
    ]
  ]) {
    const presentation = presentToolCall(
      command({ completed: true, failed: true, result: result({ exitCode, stderr, isError: true }) })
    );
    assert.equal(presentation.failureReason, explanation);
    assert.equal(presentation.statusLabel, "调用失败");
    assert.equal(presentation.durationLabel, "");
    assert.doesNotMatch(presentation.failureReason, /超时|120/);
    assert.ok(presentation.details.includes(stderr));
    assert.equal(presentation.resultSummary, "");
  }
});

test("syntax line numbers come from actual traceback locations and internal connection timeouts stay distinct", () => {
  for (const quote of ["'", '"']) {
    const stderr = `  File ${quote}work/outer.py${quote}, line 11\n  File ${quote}work/create.py${quote}, line 480\nSyntaxError: EOL while scanning string literal`;
    const presentation = presentToolCall(
      command({ completed: true, failed: true, result: result({ exitCode: 1, stderr }) })
    );
    assert.equal(presentation.failureReason, "Python 第 480 行语法错误");
    assert.ok(presentation.details.includes("EOL while scanning string literal"));
  }
  const withoutLocation = presentToolCall(
    command({
      completed: true,
      failed: true,
      result: result({ exitCode: 1, stderr: "SyntaxError: invalid syntax" })
    })
  );
  assert.equal(withoutLocation.failureReason, "Python 语法错误");
  const connectionTimeout = presentToolCall(
    command({
      completed: true,
      failed: true,
      result: result({ exitCode: 1, stderr: "Error: connect ETIMEDOUT fixture.example:443" })
    })
  );
  assert.equal(connectionTimeout.failureReason, "连接超时");
  assert.doesNotMatch(connectionTimeout.failureReason, /命令执行超时|120/);
});

test("public web search and local file search retain different action labels", () => {
  assert.equal(
    presentToolCall({ name: "search", arguments: { query: "JavaScript documentation" } }).title,
    "搜索资料"
  );
  assert.equal(
    presentToolCall({ name: "grep", arguments: { pattern: "TODO", path: "src" } }).title,
    "搜索文件内容"
  );
  assert.equal(
    presentToolCall({ name: "fetch", arguments: { url: "https://fixture.example/docs" } }).title,
    "读取网页"
  );
});

test("real timeout and exit evidence remain distinct from requested timeout parameters", () => {
  const actualTimeout = presentToolCall(
    command({
      completed: true,
      result: result({ isError: true, timedOut: true, timeoutMs: 500, signal: "SIGTERM", exitCode: 1 })
    })
  );
  assert.equal(actualTimeout.failureReason, "命令执行超时（0.5 秒）");
  assert.equal(actualTimeout.durationLabel, "");
  const genericFailure = presentToolCall(
    command({ completed: true, failed: true, result: result({ exitCode: 3 }) })
  );
  assert.equal(genericFailure.failureReason, "命令退出码 3");
  assert.doesNotMatch(genericFailure.failureReason, /超时/);
  const launchFailure = presentToolCall(
    command({
      completed: true,
      failed: true,
      result: result({ exitCode: 1, stderr: "Error: spawn python3 ENOENT" })
    })
  );
  assert.equal(launchFailure.failureReason, "无法启动命令（ENOENT）");
  const missingCommand = presentToolCall(
    command({
      completed: true,
      failed: true,
      result: result({ exitCode: 127, stderr: "bash: python3: command not found" })
    })
  );
  assert.equal(missingCommand.failureReason, "找不到可执行命令");
  const unknown127 = presentToolCall(
    command({ completed: true, failed: true, result: result({ exitCode: 127 }) })
  );
  assert.equal(unknown127.failureReason, "命令退出码 127");
});

test("successful payload fields and stderr warnings never become invented tool errors", () => {
  for (const fixture of [
    {
      name: "business_payload",
      result: envelope({
        failed: true,
        error: "ModuleNotFoundError: No module named 'business'",
        timeoutMs: 500
      })
    },
    { name: "bash", arguments: args, result: result({ stderr: "Warning: deprecated API", exitCode: 0 }) }
  ]) {
    const presentation = presentToolCall({ ...fixture, completed: true, failed: false });
    assert.equal(presentation.status, "completed");
    assert.equal(presentation.failureReason, "");
  }
});

test("incomplete finish results keep waiting precedence and interrupted calls never become complete", () => {
  assert.equal(
    presentToolCall({
      name: "finish_task",
      completed: true,
      failed: true,
      result: envelope({ completed: false, ok: false })
    }).status,
    "waiting"
  );
  const stopped = presentToolCall(command(), { active: false });
  assert.equal(stopped.status, "interrupted");
  assert.equal(stopped.statusLabel, "已停止");
  assert.equal(stopped.resultSummary, "");
  const invalidTiming = presentToolCall(command({ startedAt: 10, endedAt: 5 }));
  assert.equal(invalidTiming.durationLabel, "");
  const readBusinessJson = presentToolCall({
    name: "read",
    completed: true,
    result: { content: [{ type: "text", text: '{"completed":false,"content":"business content"}' }] }
  });
  assert.equal(readBusinessJson.status, "completed");
  assert.equal(readBusinessJson.resultSummary, "");
});

test("environment assignments stay out of compact command previews and prototype names remain plain text", () => {
  const presentation = presentToolCall(
    command({ arguments: { command: "API_KEY=synthetic-key python3 report.py" } })
  );
  assert.equal(presentation.subject, "report.py");
  assert.doesNotMatch(presentation.subject, /synthetic-key/);
  assert.match(presentation.details, /synthetic-key/);
  assert.equal(friendlyToolName("__proto__"), "调用 __proto__");
});

test("application and runtime tools have readable names and unfamiliar tools expose their actual identity", () => {
  for (const [name, title] of [
    ["enable_tools", "启用所需工具"],
    ["read_attachment", "读取附件"],
    ["grant_capabilities", "授权执行能力"],
    ["custom_inspection", "调用 custom_inspection"]
  ]) {
    assert.equal(friendlyToolName(name), title);
    assert.equal(presentToolCall({ name }).title, title);
  }
  assert.equal(friendlyToolName(""), "准备调用工具");
});

test("command previews retain literal queries and task directories from native-shaped commands", () => {
  for (const [commandText, title, subject, summary] of [
    ["find agents/main/work -type f -name '*.pptx'", "查找文件", "agents/main/work", "匹配：*.pptx"],
    ["find -L . -iname '*harness*'", "查找文件", ".", "匹配：*harness*"],
    ["ls -la agents/main/work", "查看文件列表", "agents/main/work", ""],
    ["ls --ignore '*.tmp' work", "查看文件列表", "work", ""],
    ["mkdir -p agents/main/work/previews", "创建目录", "agents/main/work/previews", ""],
    ["mkdir -m 700 'work/private draft'", "创建目录", "work/private draft", ""],
    ["rg -n 'create_harness_ppt' agents", "搜索文件内容", "create_harness_ppt", "范围：agents"],
    ["rg --hidden -g '*.py' -e 'SyntaxError' agents", "搜索文件内容", "SyntaxError", "范围：agents"],
    ["grep -RIn -- 'TODO' src", "搜索文件内容", "TODO", "范围：src"],
    ["rg --files -g '*.pptx' agents/main/work", "查找文件", "agents/main/work", "文件名：*.pptx"]
  ]) {
    const presentation = presentToolCall({ name: "bash", arguments: { command: commandText, timeout: 120 } });
    assert.equal(presentation.title, title, commandText);
    assert.equal(presentation.subject, subject, commandText);
    assert.equal(presentation.summary, summary, commandText);
    assert.doesNotMatch(
      [presentation.title, presentation.subject, presentation.summary].join(" "),
      /command=|timeout=/
    );
    assert.equal(
      JSON.parse(presentation.detailSections.find((section) => section.label === "参数").text).command,
      commandText
    );
  }
});

test("document command previews name actual input files rather than claiming produced or validated artifacts", () => {
  for (const [commandText, title, subject] of [
    ["officecli help", "查看文档操作帮助", "officecli"],
    ["officecli help view", "查看文档操作帮助", "view"],
    ["officecli validate agents/main/work/harness.pptx --json", "检查演示文稿", "harness.pptx"],
    ["officecli view --input 'agents/main/work/harness draft.pptx'", "查看演示文稿", "harness draft.pptx"],
    ["officecli view --output output.pptx input.pptx", "查看演示文稿", "input.pptx"],
    [
      "soffice --headless --convert-to pdf --outdir agents/main/work/previews agents/main/work/harness.pptx",
      "导出 PDF",
      "harness.pptx"
    ],
    [
      "soffice --headless --convert-to pdf:impress_pdf_Export --outdir 'work/draft previews' 'work/harness draft.pptx'",
      "导出 PDF",
      "harness draft.pptx"
    ]
  ]) {
    const presentation = presentToolCall({
      name: "bash",
      arguments: { command: commandText },
      completed: true,
      result: result()
    });
    assert.equal(presentation.title, title, commandText);
    assert.equal(presentation.subject, subject, commandText);
    assert.doesNotMatch(presentation.summary, /已生成|文件已创建|校验通过|验证通过/);
    assert.equal(presentation.failureReason, "");
  }
});

test("only a fully closed standalone Python heredoc describes an embedded script", () => {
  for (const commandText of [
    "python3 - <<'PY'\nprint('preview')\nPY",
    'python3 - <<"PY"\nprint("preview")\nPY\n',
    "python3 - <<-PY\n\tprint('preview')\n\tPY"
  ]) {
    const presentation = presentToolCall({ name: "bash", arguments: { command: commandText } });
    assert.equal(presentation.title, "运行 Python 脚本");
    assert.equal(presentation.subject, "内嵌脚本");
    assert.equal(presentation.status, "running");
    assert.ok(presentation.details.includes("print"));
  }
  for (const commandText of [
    "python3 - <<'PY'\nprint('preview')",
    "python3 - <<'PY'\nprint('preview')\nPY\nls work",
    "python3 - <<'PY' | tee preview.log\nprint('preview')\nPY",
    "python3 - <<'PY'\nPY\nprint('after delimiter')\nPY",
    "python3 -m app - <<'PY'\nprint('not executed as stdin code')\nPY"
  ]) {
    const presentation = presentToolCall({ name: "bash", arguments: { command: commandText } });
    assert.equal(presentation.title, "执行组合命令", commandText);
    assert.equal(presentation.subject, "python3", commandText);
  }
});

test("one literal pipeline explicitly limits the action label to its first step", () => {
  for (const [commandText, title, subject, next] of [
    ["find agents -name '*.pptx' | head -20", "查找文件", "agents", "head"],
    ["rg -n 'SyntaxError' agents | head -30", "搜索文件内容", "SyntaxError", "head"],
    ["ls -la work | sort", "查看文件列表", "work", "sort"]
  ]) {
    const presentation = presentToolCall({
      name: "bash",
      arguments: { command: commandText },
      completed: true,
      result: result()
    });
    assert.equal(presentation.title, title);
    assert.equal(presentation.subject, subject);
    assert.match(presentation.summary, /首步/);
    assert.ok(presentation.summary.includes(next));
    assert.doesNotMatch(presentation.summary, /全部成功|已找到|已生成/);
  }
});

test("compound or dynamic shell operations retain only a safe executable and never infer their full success", () => {
  for (const [commandText, executable] of [
    ["ls work && officecli validate work/report.pptx", "ls 等命令"],
    ["rg TODO src || echo no_matches", "rg 等命令"],
    ["printf ready; ls work", "printf 等命令"],
    ["printf ready\nls work", "printf 等命令"],
    ["python3 report.py > output.log", "python3"],
    ["python3 report.py > output.log 2>&1", "python3"],
    ["find agents | grep report | head", "find 等命令"],
    ["mkdir $(echo private)", "mkdir"],
    ['python3 "$REPORT_PATH"', "python3"],
    ["UNKNOWN_TOKEN=$(printf 'synthetic private') custom-preview report.pptx", "custom-preview"]
  ]) {
    const presentation = presentToolCall({ name: "bash", arguments: { command: commandText } });
    assert.equal(presentation.title, "执行组合命令", commandText);
    assert.equal(presentation.subject, executable, commandText);
    assert.equal(presentation.summary, "");
    assert.doesNotMatch(presentation.subject, /synthetic|private|secret|\$/);
    assert.ok(presentation.details.length > 0);
  }
  const unknown = presentToolCall({
    name: "bash",
    arguments: { command: "API_KEY='synthetic secret' custom-preview 'work/report.pptx'" }
  });
  assert.equal(unknown.title, "运行命令");
  assert.equal(unknown.subject, "custom-preview");
  assert.equal(unknown.summary, "");
  const wrappedUnknown = presentToolCall({
    name: "bash",
    arguments: {
      command: "API_KEY=synthetic-private env UNKNOWN_TOKEN='secret literal' custom-preview report.pptx"
    }
  });
  assert.equal(wrappedUnknown.title, "运行命令");
  assert.equal(wrappedUnknown.subject, "custom-preview");
  assert.equal(wrappedUnknown.summary, "");
  const unsafeFind = presentToolCall({ name: "bash", arguments: { command: "find work -delete" } });
  assert.equal(unsafeFind.title, "运行命令");
  assert.equal(unsafeFind.subject, "find");
  const unknownFlag = presentToolCall({
    name: "bash",
    arguments: { command: "ls --future-option option-value work" }
  });
  assert.equal(unknownFlag.subject, "ls");
  const officeUnknownFlag = presentToolCall({
    name: "bash",
    arguments: { command: "officecli validate --future-output output.pptx input.pptx" }
  });
  assert.equal(officeUnknownFlag.subject, "officecli");
  const envUnknownFlag = presentToolCall({
    name: "bash",
    arguments: { command: "env -i --future-option synthetic-value python3 report.py" }
  });
  assert.equal(envUnknownFlag.subject, "env");
});

test("raw Pi command envelopes retain partial output and attribute failure to the whole command chain", () => {
  for (const fixture of [
    {
      command:
        "printf 'PATH=%s\\n' \"$PATH\"; command -v python3; command -v soffice; ls /synthetic/local/share /synthetic/nvm/versions/node 2>/dev/null",
      output: "PATH=/usr/bin:/bin\n/usr/bin/python3\n/synthetic/local/share:\nuv\n",
      subject: "printf 等命令",
      failureReason: "命令退出码 1"
    },
    {
      command:
        "PATH=/synthetic/bin:$PATH fc-list :lang=zh family | head -15; ls /synthetic/task/agents/main/work",
      output: "Hiragino Sans GB\nls: /synthetic/task/agents/main/work: No such file or directory\n",
      subject: "fc-list 等命令",
      failureReason: "文件或目录不存在"
    }
  ]) {
    const rawResult = {
      content: [{ type: "text", text: `${fixture.output}\n\nCommand exited with code 1` }],
      details: {}
    };
    const presentation = presentToolCall({
      name: "bash",
      arguments: { command: fixture.command, timeout: 20 },
      completed: true,
      failed: true,
      rawResult
    });
    assert.equal(presentation.title, "执行组合命令");
    assert.equal(presentation.subject, fixture.subject);
    assert.equal(presentation.status, "failed");
    assert.equal(presentation.statusLabel, "调用失败");
    assert.equal(presentation.failureReason, fixture.failureReason);
    assert.equal(presentation.resultSummary, "");
    const returned = JSON.parse(
      presentation.detailSections.find((section) => section.label === "返回结果").text
    );
    assert.equal(returned.content[0].text, rawResult.content[0].text);
  }
});

test("empty Pi details retain JSON-content diagnostics and real detail fields override compatibility content", () => {
  const diagnostic = { exitCode: 1, stderr: "SyntaxError: invalid syntax", stdout: "partial output" };
  const rawResult = { content: [{ type: "text", text: JSON.stringify(diagnostic) }], details: {} };
  const presentation = presentToolCall(command({ completed: true, rawResult }));
  assert.equal(presentation.status, "failed");
  assert.equal(presentation.failureReason, "Python 语法错误");
  assert.equal(
    presentation.detailSections.find((section) => section.label === "标准错误").text,
    diagnostic.stderr
  );
  assert.equal(
    presentation.detailSections.find((section) => section.label === "标准输出").text,
    diagnostic.stdout
  );
  assert.deepEqual(rawResult.details, {});
  const overridden = presentToolCall(
    command({
      completed: true,
      rawResult: { ...rawResult, details: { exitCode: 0, stderr: "", stdout: "confirmed output" } }
    })
  );
  assert.equal(overridden.status, "completed");
  assert.equal(overridden.failureReason, "");
  assert.equal(
    overridden.detailSections.find((section) => section.label === "标准输出").text,
    "confirmed output"
  );
  const business = presentToolCall({
    name: "business_payload",
    completed: true,
    rawResult: {
      content: [
        {
          type: "text",
          text: JSON.stringify({ failed: true, error: "SyntaxError: business value", exitCode: 1 })
        }
      ],
      details: {}
    }
  });
  assert.equal(business.status, "completed");
  assert.equal(business.failureReason, "");
});

test("textual technical details remain complete, binary blocks retain metadata without base64 expansion", () => {
  const presentation = presentToolCall({
    name: "computer_observe",
    completed: true,
    result: {
      content: [
        { type: "image", mimeType: "image/png", data: "synthetic-binary-data" },
        { type: "text", text: "Visible window title" }
      ]
    }
  });
  assert.match(presentation.details, /Visible window title/);
  assert.match(presentation.details, /image\/png/);
  assert.match(presentation.details, /图片二进制内容/);
  assert.doesNotMatch(presentation.details, /synthetic-binary-data/);
  assert.equal(presentation.failureReason, "");
});

test("plain text presentation can be safely escaped in summaries and disclosures without executing output", () => {
  const malicious = '<img src=x onerror="globalThis.toolInjected=true">';
  const presentation = presentToolCall({
    name: "read_file",
    arguments: { path: malicious },
    completed: true,
    result: { content: [{ type: "text", text: malicious }] }
  });
  const { document } = parseHTML(
    `<main><strong>${escapeHtml(presentation.title)}</strong><span>${escapeHtml(presentation.subject)}</span><details><pre>${escapeHtml(presentation.details)}</pre></details></main>`
  );
  assert.equal(document.querySelectorAll("img,script").length, 0);
  assert.match(document.querySelector("pre").textContent, /onerror/);
  assert.ok(document.querySelector("span").textContent.includes(malicious));
});
