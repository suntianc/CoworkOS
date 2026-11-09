/**
 * Read a unified diff into the files and numbered lines a preview shows.
 *
 * The text comes from `git diff`, so hunk headers are the only reliable source
 * of line numbers: added lines count in the new file, removed lines in the old
 * one, context lines in both. File headers and index lines are not content and
 * are dropped, so the reader sees the change and not Git's bookkeeping.
 */
function headerPath(line) {
  const target = line.slice(4).trim();
  if (!target || target === "/dev/null") return undefined;
  return target.startsWith("b/") || target.startsWith("a/") ? target.slice(2) : target;
}

export function parseUnifiedDiff(patch) {
  const files = [];
  const lines = String(patch || "").split("\n");
  let file;
  let hunk;
  let oldLine = 0;
  let newLine = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (raw.startsWith("diff --git ")) {
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(raw);
      file = { path: match ? match[2] : raw.slice(11), lines: [] };
      files.push(file);
      hunk = undefined;
      continue;
    }
    if (!file) continue;
    // The extended headers name the file itself; a rename keeps the new path.
    if (raw.startsWith("--- ")) {
      const path = headerPath(raw);
      if (path) file.path = path;
      continue;
    }
    if (raw.startsWith("+++ ")) {
      const path = headerPath(raw);
      if (path) file.path = path;
      continue;
    }
    if (raw.startsWith("@@")) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      oldLine = match ? Number(match[1]) : 1;
      newLine = match ? Number(match[2]) : 1;
      hunk = { header: raw, lines: [] };
      file.lines.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (raw.startsWith("\\ No newline")) continue;
    const sign = raw[0];
    if (sign !== "+" && sign !== "-" && sign !== " ") continue;
    const text = raw.slice(1);
    if (sign === "+") {
      hunk.lines.push({ kind: "add", number: newLine, text });
      newLine += 1;
    } else if (sign === "-") {
      hunk.lines.push({ kind: "delete", number: oldLine, text });
      oldLine += 1;
    } else {
      hunk.lines.push({ kind: "context", number: newLine, text });
      newLine += 1;
      oldLine += 1;
    }
  }
  return files;
}

/** One file's patch text, for downloading exactly the file that is previewed. */
export function filePatchText(files, path) {
  const file = files.find((entry) => entry.path === path);
  if (!file) return "";
  return file.lines
    .flatMap((hunk) => [
      hunk.header,
      ...hunk.lines.map(
        (line) => `${line.kind === "add" ? "+" : line.kind === "delete" ? "-" : " "}${line.text}`
      )
    ])
    .join("\n");
}
