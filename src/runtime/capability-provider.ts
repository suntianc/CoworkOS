import type { RuntimeTool } from "./tool.js";

/** Serializable grants survive queue recovery; providers live outside the coordinator. */
export interface CapabilityGrant {
  provider: string;
  scope: unknown;
}

export interface CapabilityContext {
  taskId: string;
  runId: string;
  callId: string;
  agentId: string;
  workspaceRoot: string;
  workingDirectory: string;
  supportsImages: boolean;
}

export interface ProvidedCapabilities {
  tools: ReadonlyMap<string, RuntimeTool>;
  prompt?: string;
  skillRoots?: string[];
}

export type CapabilityProvider = (
  grants: readonly CapabilityGrant[],
  context: CapabilityContext
) => Promise<ProvidedCapabilities>;

/**
 * Grants a launched process receives in its environment.
 *
 * The backend passes them as JSON so the delegated process can register the
 * matching capability tools itself; an unreadable value is refused instead of
 * silently widening or narrowing what the model may call.
 */
export function parseCapabilityGrants(raw: string | undefined): CapabilityGrant[] {
  if (raw === undefined || raw.trim() === "") return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("CoworkOS 子代理能力授权无法读取");
  }
  if (!Array.isArray(value)) throw new Error("CoworkOS 子代理能力授权格式不合法");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error("CoworkOS 子代理能力授权格式不合法");
    const grant = entry as Record<string, unknown>;
    if (typeof grant.provider !== "string" || !grant.provider.trim())
      throw new Error("CoworkOS 子代理能力授权缺少提供方");
    return { provider: grant.provider, scope: grant.scope };
  });
}

/** Refuse collisions rather than silently replacing a core or another provider's tool. */
export function addCapabilityTools(
  target: Map<string, RuntimeTool>,
  source: ReadonlyMap<string, RuntimeTool>
) {
  for (const [name, tool] of source) {
    if (target.has(name)) throw new Error(`Capability tool collides with existing tool: ${name}`);
    target.set(name, tool);
  }
}

/** Compose independent providers without importing domain code into the runtime. */
export function capabilityProvider(providers: ReadonlyMap<string, CapabilityProvider>): CapabilityProvider {
  return async (grants, context) => {
    const tools = new Map<string, RuntimeTool>();
    const prompt: string[] = [];
    const skillRoots = new Set<string>();
    for (const name of new Set(grants.map((grant) => grant.provider))) {
      const provide = providers.get(name);
      if (!provide) throw new Error(`Unsupported capability provider: ${name}`);
      const result = await provide(
        grants.filter((grant) => grant.provider === name),
        context
      );
      addCapabilityTools(tools, result.tools);
      if (result.prompt) prompt.push(result.prompt);
      for (const root of result.skillRoots ?? []) skillRoots.add(root);
    }
    return {
      tools,
      prompt: prompt.join("\n\n"),
      skillRoots: [...skillRoots]
    };
  };
}
