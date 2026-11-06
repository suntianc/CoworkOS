// Test-only adapter fixture for resource, recovery and MCP contracts. Not shipped.
/**
 * What a heading is, for the text application.
 *
 * Shared heading logic for the in-process Adapter and MCP server, keeping
 * section selection consistent without requiring a child process for reads.
 *
 * Offsets here are UTF-16 code units, the same indices `String.prototype`
 * uses. They are an implementation detail of locating a section; no offset
 * computed here is ever handed to a model.
 */

/** One heading and the span of the section it owns, in UTF-16 offsets. */
export interface Section {
  level: number;
  title: string;
  /** Offset of the heading line itself. */
  start: number;
  /** Offset just past this section's body, i.e. the next heading of equal or higher rank. */
  end: number;
}

export function outline(body: string): Section[] {
  const found: Array<{ level: number; title: string; start: number; bodyStart: number }> = [];
  const pattern = /^(#{1,6})[ \t]+(.+?)[ \t]*$/gm;
  for (let match = pattern.exec(body); match; match = pattern.exec(body)) {
    found.push({
      level: match[1].length,
      title: match[2].trim(),
      start: match.index,
      bodyStart: match.index + match[0].length
    });
  }
  return found.map((entry, index) => {
    // A section ends where the next heading of equal or higher rank begins —
    // a deeper subheading is part of it, which is the distinction a plain
    // offset-based tool cannot make.
    const next = found.slice(index + 1).find((candidate) => candidate.level <= entry.level);
    return {
      level: entry.level,
      title: entry.title,
      start: entry.start,
      end: next ? next.start : body.length
    };
  });
}

/**
 * The headings' titles, for the one line the Adapter contributes to the prompt.
 *
 * Titles only — no level markers, no line numbers. What this feeds is a shape
 * line, and a shape line may say what a document is made of but never where
 * any of it is.
 */
export function headingTitles(body: string, limit: number): string[] {
  return outline(body)
    .slice(0, limit)
    .map((section) => section.title);
}

/** Find a section by title, case-insensitively as a fallback. */
export function findSection(sections: Section[], heading: string): Section | undefined {
  const wanted = heading.trim();
  return (
    sections.find((section) => section.title === wanted) ??
    sections.find((section) => section.title.toLowerCase() === wanted.toLowerCase())
  );
}
