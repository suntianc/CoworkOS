import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { RuntimeTool } from "./tool.js";

export interface SkillDiscoveryOptions {
  /** Only explicitly bound/delegated applications may contribute application-only skills. */
  applications?: readonly string[];
}

export interface ApplicationSkillScope {
  skillRoots: string[];
  skillApplications: string[];
}

/** Application skills take precedence over general skills with the same name. */
export function applicationSkillScope(
  baseRoots: readonly string[],
  application: { appType: string; skillRoots: string[] } | undefined,
  harnessRoot: string
): ApplicationSkillScope {
  return {
    skillRoots: [
      ...new Set([...(application?.skillRoots ?? []).map((root) => resolve(harnessRoot, root)), ...baseRoots])
    ],
    skillApplications: application ? [application.appType] : []
  };
}

export interface SkillMetadata {
  name: string;
  description: string;
  path: string;
  directory: string;
}

/**
 * Lightweight Agent Skills discovery for Cowork's custom Subagent runtime.
 * Pi coding-agent already discovers project skills for Main; this registry
 * gives the lower-level PiSession the same progressive-disclosure contract
 * without copying full skill instructions into every prompt.
 */
export async function discoverSkills(
  roots: string[],
  options: SkillDiscoveryOptions = {}
): Promise<SkillMetadata[]> {
  const found: SkillMetadata[] = [];
  const seen = new Set<string>();
  const applications = new Set(options.applications ?? []);
  for (const root of roots) await scanRoot(resolve(root), found, seen, applications);
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

export function skillCatalogPrompt(skills: SkillMetadata[]): string {
  if (skills.length === 0) return "No project skills are available for this Subagent.";
  return [
    "Project skills are available on demand. Do not load a skill unless the task matches its description.",
    "Use the load_skill tool with the skill name before following a specialized workflow; the tool returns the full SKILL.md and its directory.",
    ...skills.map((skill) => `- ${skill.name}: ${skill.description}`)
  ].join("\n");
}

export function createLoadSkillTool(skills: SkillMetadata[]): RuntimeTool {
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  return {
    description:
      "Load the full instructions for one matching project skill. Use only when the skill description applies to the current task.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The exact skill name from the available skill catalog." }
      },
      required: ["name"],
      additionalProperties: false
    },
    async execute(input) {
      const name =
        input && typeof input === "object" && typeof (input as { name?: unknown }).name === "string"
          ? (input as { name: string }).name.trim()
          : "";
      if (!name) throw new Error("load_skill requires a skill name");
      const skill = byName.get(name);
      if (!skill) throw new Error(`unknown skill: ${name}`);
      const body = await readFile(skill.path, "utf8");
      const scripts = await readdir(join(skill.directory, "scripts"), { withFileTypes: true }).catch(
        // eslint-disable-next-line no-restricted-syntax -- scripts 子目录是可选约定，没有它技能照常可用，空列表就是真实结果
        () => []
      );
      return {
        name: skill.name,
        path: skill.path,
        directory: skill.directory,
        scripts: Object.fromEntries(
          scripts
            .filter((entry) => entry.isFile())
            .map((entry) => [entry.name, join(skill.directory, "scripts", entry.name)])
        ),
        content: body
      };
    }
  };
}

async function scanRoot(
  root: string,
  found: SkillMetadata[],
  seen: Set<string>,
  applications: Set<string>
): Promise<void> {
  const add = (skill: ParsedSkill | undefined, path: string, directory: string) => {
    if (!skill || seen.has(skill.name) || (skill.application && !applications.has(skill.application))) return;
    seen.add(skill.name);
    found.push({ name: skill.name, description: skill.description, path, directory });
  };
  // Pi also accepts individual skill files. Keep those user-configured paths
  // in the same scoped catalog as the directory roots.
  if (root.endsWith(".md")) {
    add(await parseSkill(root), root, dirname(root));
    return;
  }
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
    // eslint-disable-next-line no-restricted-syntax -- 配置的 skill 根目录可能不存在或不可读，跳过它继续扫描其余根目录
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const skillPath = join(path, "SKILL.md");
      const skill = await parseSkill(skillPath);
      add(skill, skillPath, path);
      // Nested grouping directories are valid in the Agent Skills convention.
      await scanRoot(path, found, seen, applications);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      const skill = await parseSkill(path);
      add(skill, path, dirname(path));
    }
  }
}

interface ParsedSkill {
  name: string;
  description: string;
  application?: string;
}

async function parseSkill(path: string): Promise<ParsedSkill | undefined> {
  try {
    // Match Pi's YAML grammar (including multiline descriptions and inferred
    // names), rather than silently dropping SDK-selected skills on rediscovery.
    const { frontmatter } = parseFrontmatter(await readFile(path, "utf8"));
    if (frontmatter["disable-model-invocation"] === true) return undefined;
    const name =
      typeof frontmatter.name === "string" && frontmatter.name.trim()
        ? frontmatter.name.trim()
        : basename(dirname(path));
    const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
    if (!description) return undefined;
    return {
      name,
      description,
      application:
        typeof frontmatter.application === "string" ? frontmatter.application.trim() || undefined : undefined
    };
    // eslint-disable-next-line no-restricted-syntax -- 单个 SKILL.md 读不出或 frontmatter 损坏时跳过该技能，其余目录继续被发现
  } catch {
    return undefined;
  }
}
