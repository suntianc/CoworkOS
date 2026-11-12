const engineIdentity =
  "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";
/** Product roles describe responsibility, never a model's training provenance. */
export function atriaRoleIdentity(role: "Agent" | "Main" | "Subagent"): string {
  if (role === "Main")
    return "You are CoworkOS Main, the agent responsible for completing the user's tasks in CoworkOS.";
  if (role === "Subagent") return "You are a CoworkOS Subagent, completing the task delegated by Main.";
  return "You are CoworkOS Agent, helping the user complete tasks in CoworkOS.";
}
const atriaIdentity = atriaRoleIdentity("Main");
const legacyIdentity =
  "You are Atria Main, the agent responsible for completing the user's tasks in Atria Cowork.";
const engineDocsHeader =
  "Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):";
const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// SDK 0.87.1's complete default template. Only the three filesystem paths vary.
const engineDocsPattern = new RegExp(
  "^" +
    [
      escapePattern(engineDocsHeader),
      "- Main documentation: [^\\r\\n]+",
      "- Additional docs: [^\\r\\n]+",
      "- Examples: [^\\r\\n]+" + escapePattern(" (extensions, custom tools, SDK)"),
      escapePattern(
        "- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory"
      ),
      escapePattern(
        "- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md), environment variables (docs/environment-variables.md)"
      ),
      escapePattern(
        "- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing"
      ),
      escapePattern(
        "- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)"
      )
    ].join("\n") +
    "$"
);

/** Project SDK defaults at the request/export boundary; preserve custom prompts and tool patches. */
export function projectAtriaSystemMessage<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  const message = value as Record<string, unknown>;
  // Forced prompts are content-only; mixed snapshots may include user-added
  // instructions. Preserve that custom state whole, including its sections.
  if (message.content !== undefined && message.content !== "") return value;
  if (
    message.role !== "system" ||
    !message.sections ||
    typeof message.sections !== "object" ||
    Array.isArray(message.sections)
  )
    return value;
  const sections = { ...(message.sections as Record<string, unknown>) };
  if (
    sections.preamble !== engineIdentity &&
    sections.preamble !== atriaIdentity &&
    sections.preamble !== legacyIdentity
  )
    return value;
  let changed = false;
  if (sections.preamble === engineIdentity || sections.preamble === legacyIdentity) {
    sections.preamble = atriaIdentity;
    changed = true;
  }
  const docs =
    typeof sections.docs === "string"
      ? sections.docs.replace(/^<docs>\n([\s\S]*)\n<\/docs>$/, "$1")
      : undefined;
  if (docs !== undefined && engineDocsPattern.test(docs)) {
    sections.docs = null;
    changed = true;
  }
  return changed ? ({ ...message, sections } as T) : value;
}
