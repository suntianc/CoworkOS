#!/usr/bin/env node
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const candidates = [
  ["officecli", process.env.COWORK_OFFICECLI_PATH ?? "officecli"],
  ["soffice", "soffice"],
  ["libreoffice", "libreoffice"],
  ["pandoc", "pandoc"]
];
const result = [];
for (const [kind, executable] of candidates) {
  let available = false;
  let version = "";
  try {
    if (executable.includes("/")) await access(executable, constants.X_OK);
    const output = await exec(executable, ["--version"], { timeout: 5_000, maxBuffer: 8_192 });
    available = true;
    version = `${output.stdout}${output.stderr}`.trim().split("\n")[0] ?? "";
  } catch {
    // A missing optional backend is expected on a fresh Cowork installation.
  }
  result.push({ kind, executable, available, ...(version ? { version } : {}) });
}
const python = await probePython();
result.push(python);
console.log(JSON.stringify({ preferred: "officecli", backends: result }, null, 2));

async function probePython() {
  const executable = process.env.COWORK_PYTHON ?? "python3";
  try {
    const output = await exec(
      executable,
      [
        "-c",
        [
          "import importlib.util, json, platform, sys",
          'packages = {name: bool(importlib.util.find_spec(module)) for name, module in {"docx": "docx", "openpyxl": "openpyxl"}.items()}',
          'print(json.dumps({"version": platform.python_version(), "packages": packages}))'
        ].join("; ")
      ],
      { timeout: 5_000, maxBuffer: 8_192 }
    );
    const details = JSON.parse(output.stdout.trim());
    return {
      kind: "python",
      executable,
      available: true,
      version: `Python ${details.version}`,
      packages: details.packages,
      capabilities: {
        docx: details.packages.docx ? "structured-edit" : "unavailable",
        xlsx: details.packages.openpyxl ? "structured-edit" : "unavailable",
        render: "unavailable"
      }
    };
  } catch (error) {
    return {
      kind: "python",
      executable,
      available: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
