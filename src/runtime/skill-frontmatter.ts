/**
 * The frontmatter subset SKILL.md files use: one YAML mapping fenced by `---`
 * at the top of the file. Skill discovery keeps its own reader so `src/runtime/`
 * does not import a Pi package just to list skills; the supported grammar is
 * what skills actually write (plain, quoted and block scalars), and keys with
 * any other structure are left alone.
 */
export interface ParsedSkillFrontmatter {
  frontmatter: Record<string, unknown>;
  body: string;
}

export function parseSkillFrontmatter(content: string): ParsedSkillFrontmatter {
  const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("---")) return { frontmatter: {}, body: normalized };
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: {}, body: normalized };
  return { frontmatter: parseMapping(normalized.slice(4, end)), body: normalized.slice(end + 4).trim() };
}

function parseMapping(block: string): Record<string, unknown> {
  const frontmatter: Record<string, unknown> = {};
  const lines = block.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    // Indented lines belong to the key above them and are consumed there.
    if (line.startsWith(" ") || line.startsWith("\t")) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (!key) continue;
    const rest = line.slice(separator + 1).trim();
    if (/^[|>][+-]?$/.test(rest)) {
      const scalar = readBlockScalar(lines, index + 1, rest);
      frontmatter[key] = scalar.value;
      index = scalar.next - 1;
      continue;
    }
    const scalar = readScalar(lines, index, rest);
    frontmatter[key] = scalar.value;
    index = scalar.next - 1;
  }
  return frontmatter;
}

function readScalar(lines: string[], start: number, first: string): { value: unknown; next: number } {
  const quote = first.startsWith('"') || first.startsWith("'") ? first[0] : undefined;
  if (quote) {
    let text = first;
    let index = start;
    while (!hasClosingQuote(text, quote) && index + 1 < lines.length) {
      index += 1;
      text = `${text} ${lines[index].trim()}`;
    }
    return { value: unquote(text, quote), next: index + 1 };
  }
  const parts = [stripComment(first)];
  let index = start;
  while (index + 1 < lines.length && /^[ \t]+\S/.test(lines[index + 1])) {
    index += 1;
    parts.push(stripComment(lines[index].trim()));
  }
  return { value: plainScalar(parts.join(" ").trim()), next: index + 1 };
}

function readBlockScalar(lines: string[], start: number, header: string): { value: string; next: number } {
  const indent = firstContentIndent(lines, start);
  if (indent === 0) return { value: "", next: start };
  const collected: string[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      collected.push("");
      index += 1;
      continue;
    }
    if (line.length - line.trimStart().length < indent) break;
    collected.push(line.slice(indent));
    index += 1;
  }
  const literal = header.startsWith("|");
  const body = literal ? collected.join("\n") : foldLines(collected);
  const trailing = body.length - body.replace(/\n+$/, "").length;
  const trimmed = body.slice(0, body.length - trailing);
  if (!trimmed) return { value: "", next: index };
  const chomp = header.includes("-") ? "strip" : header.includes("+") ? "keep" : "clip";
  const value =
    chomp === "strip" ? trimmed : chomp === "keep" ? trimmed + "\n".repeat(trailing) : `${trimmed}\n`;
  return { value, next: index };
}

function firstContentIndent(lines: string[], start: number): number {
  for (let index = start; index < lines.length; index++) {
    const line = lines[index];
    if (line.trim()) return line.length - line.trimStart().length;
  }
  return 0;
}

function foldLines(lines: string[]): string {
  let text = "";
  for (const line of lines) {
    if (!line) text += "\n";
    else text += text && !text.endsWith("\n") ? ` ${line}` : line;
  }
  return text;
}

function hasClosingQuote(text: string, quote: string): boolean {
  let count = 0;
  for (let index = 0; index < text.length; index++) {
    if (quote === '"' && text[index] === "\\") index += 1;
    else if (text[index] === quote) count += 1;
  }
  return count >= 2;
}

function unquote(text: string, quote: string): string {
  const inner = text.slice(1, text.lastIndexOf(quote));
  return quote === "'"
    ? inner.replaceAll("''", "'")
    : inner.replace(/\\(["\\/nrt])/g, (_match, escape: string) => {
        if (escape === "n") return "\n";
        if (escape === "t") return "\t";
        if (escape === "r") return "\r";
        return escape;
      });
}

function stripComment(value: string): string {
  const comment = value.search(/\s#/);
  return comment === -1 ? value : value.slice(0, comment).trimEnd();
}

function plainScalar(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}
