import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
// Keep legacy untouched files stable. A changed file must meet the common formatter.
// CI compares against the PR base; locally include staged, unstaged and new files.
let base = process.env.FORMAT_BASE;
if (base) {
  try {
    execFileSync("git", ["rev-parse", "--verify", `${base}^{commit}`], { stdio: "ignore" });
    // eslint-disable-next-line no-restricted-syntax -- FORMAT_BASE 指向的提交在本地可能不存在（如只 fetch 了默认分支），此时回退到 HEAD
  } catch {
    base = "HEAD";
  }
}
const commands = base
  ? [["diff", "--name-only", "--diff-filter=d", "-z", `${base}...HEAD`]]
  : [
      // git rm --cached can leave a retired/private file on disk. Existence
      // alone must not make a repository deletion a formatting target.
      ["diff", "--name-only", "--diff-filter=d", "-z", "HEAD"],
      ["ls-files", "--others", "--exclude-standard", "-z"]
    ];
const files = [
  ...new Set(commands.flatMap((args) => execFileSync("git", args, { encoding: "utf8" }).split("\0")))
].filter(
  (file) =>
    existsSync(file) &&
    // A running harness can create task workspaces inside this checkout.
    // Their user content and live supervisor state are not product source.
    !/^task-[^/]+\//.test(file) &&
    !file.startsWith(".watch-supervisor.lock/") &&
    !file.startsWith("applications/") &&
    !file.startsWith("workspace/") &&
    /\.(?:ts|js|mjs|cjs|json|md|css|html|ya?ml)$/.test(file) &&
    file !== "package-lock.json"
);
if (files.length) {
  execFileSync(
    process.execPath,
    [
      resolve("node_modules/prettier/bin/prettier.cjs"),
      process.argv.includes("--write") ? "--write" : "--check",
      ...files
    ],
    { stdio: "inherit" }
  );
} else console.log("No changed files to format");
