import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "../../../dist/src/storage/atomic-file.js";
import { LocalWorkspaceStore } from "../../../dist/src/workspace/workspace-store.js";
import { resolveCapabilities } from "../../../dist/src/runtime/task-capabilities.js";

export const CORE_TOOLS = [
  "load_skill",
  "read_image",
  "read_images",
  "crop_image",
  "list_images",
  "browse_workspace",
  "call_subagent",
  "send_subagent_message",
  "cancel_subagent",
  "get_subagent_status",
  "wait_for_subagents",
  "get_task_status",
  "finish_task",
  "askhuman",
  "clear_context",
  "sleep_until",
  "grant_capabilities",
  "enable_tools"
];
const GROUPS = {
  attachments: {
    description: "Read Task uploads as text or actual page/image pixels.",
    tools: ["read_attachment"]
  },
  delivery: {
    description: "Publish an existing verified file as a downloadable Task artifact.",
    tools: ["publish_artifact"]
  },
  jobs: {
    description: "Supervised background jobs. Requires a recorded longRunning grant.",
    tools: ["start_job", "check_job", "kill_job"]
  },
  browser: {
    description:
      "Operate a Task's isolated Chromium browser using semantic locators, screenshots, condition waits and verified downloads. Requires an installed browser executable.",
    tools: ["browser_open", "browser_observe", "browser_act", "browser_wait", "browser_close"]
  },
  cua: {
    description:
      "Run bounded JavaScript with persistent state and a CUA SDK. Also enable browser or computer as needed; scripts can only call currently active tools and cannot grant desktop access.",
    tools: ["cua_script", "cua_reset"]
  },
  computer: {
    description:
      "Consume an active human window grant or the enabled desktop global policy. Paused access requires human resume. Host dependent.",
    tools: [
      "computer_status",
      "computer_discover",
      "computer_select",
      "computer_release",
      "computer_observe",
      "computer_wait",
      "computer_act"
    ]
  }
} as const;
type Group = string;
type DesktopSession = { state?: string; mode?: string; expiresAt?: number };

/** Availability is shared policy; presence of a UI never grants resource or desktop access. */
export function registerCapabilityTools(
  pi: ExtensionAPI,
  input: {
    workspaceRoot: string;
    taskId: string;
    mainRunId: string;
    /** Desktop, browser and CUA tools deliver screenshots, so a text-only Main never sees them. */
    supportsImages: boolean;
    additionalGroups?: Record<string, { description: string; tools: readonly string[] }>;
  }
) {
  const groups = { ...GROUPS, ...input.additionalGroups };
  const requested = new Set<Group>();
  const optional = new Set<string>(Object.values(groups).flatMap((group) => [...group.tools]));
  const statePath = join(
    input.workspaceRoot,
    input.taskId,
    "runs",
    input.mainRunId,
    "tool-capabilities.json"
  );
  let loaded = false;
  let available: Record<string, { enabled: boolean; tools: string[]; reason?: string }> = {};
  // Pi action methods are available only after session_start, never during extension loading.
  async function refresh() {
    if (!loaded) {
      try {
        const state = JSON.parse(await readFile(statePath, "utf8"));
        if (Array.isArray(state.groups))
          for (const name of state.groups)
            if (typeof name === "string" && Object.hasOwn(groups, name)) requested.add(name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError))
          throw error;
      }
      loaded = true;
    }
    const task = await new LocalWorkspaceStore(input.workspaceRoot)
      .readTask(input.taskId)
      // eslint-disable-next-line no-restricted-syntax -- 任务记录缺失时按没有 capabilities 的默认配置启用工具
      .catch(() => undefined);
    const capabilities = resolveCapabilities(task?.capabilities);
    const uploads = await readdir(join(input.workspaceRoot, input.taskId, "inputs"), {
      withFileTypes: true
      // eslint-disable-next-line no-restricted-syntax -- 任务首次运行还没有 inputs 目录，读目录失败等价于没有上传
    }).catch(() => []);
    let desktop: DesktopSession | null = null;
    let policy: { enabled?: boolean; mode?: string } | undefined;
    let policyPaused = false;
    const base = process.env.COWORK_DASHBOARD_URL;
    if (base) {
      try {
        const response = await fetch(`${base}/api/tasks/${encodeURIComponent(input.taskId)}/computer`, {
          signal: AbortSignal.timeout(2000),
          headers: process.env.COWORK_API_TOKEN ? { "x-atria-token": process.env.COWORK_API_TOKEN } : {}
        });
        if (response.ok) {
          const result = (await response.json()) as {
            session?: DesktopSession | null;
            access?: { policy?: typeof policy; paused?: boolean; taskBlocked?: boolean };
          };
          desktop = result.session ?? null;
          policy = result.access?.policy;
          policyPaused = Boolean(result.access?.paused || result.access?.taskBlocked);
        }
        // eslint-disable-next-line no-restricted-syntax -- Dashboard 不可达时视为没有授予桌面访问，工具发现继续
      } catch {
        /* No desktop access is granted by an unreachable host. */
      }
    }
    const activeDesktop =
      desktop?.state === "active" && (!desktop.expiresAt || desktop.expiresAt > Date.now());
    const globalDesktop = Boolean(policy?.enabled && !policyPaused);
    const desired: string[] = [];
    available = {};
    for (const [name, group] of Object.entries(groups)) {
      const imageOnly = name === "computer" || name === "browser" || name === "cua";
      const wanted =
        requested.has(name) ||
        (name === "attachments" &&
          uploads.some((entry) => entry.isDirectory() && entry.name.startsWith("upload-"))) ||
        (name === "jobs" && capabilities.longRunning) ||
        (name === "computer" && (activeDesktop || globalDesktop));
      const permitted = (name !== "jobs" || capabilities.longRunning) && (!imageOnly || input.supportsImages);
      const hosted = name !== "computer" || Boolean(base);
      const names =
        name === "computer"
          ? [
              "computer_status",
              ...(globalDesktop ? ["computer_discover", "computer_select", "computer_release"] : []),
              ...(activeDesktop || globalDesktop ? ["computer_observe", "computer_wait"] : []),
              ...((activeDesktop && desktop?.mode === "control") ||
              (globalDesktop && policy?.mode === "control")
                ? ["computer_act"]
                : [])
            ]
          : [...group.tools];
      const enabled = wanted && permitted && hosted;
      if (enabled) desired.push(...names);
      available[name] = {
        enabled,
        tools: names,
        ...(!permitted
          ? {
              reason:
                name === "jobs"
                  ? "Requires a recorded longRunning grant"
                  : "Requires a model connection that accepts image input"
            }
          : !hosted
            ? { reason: "No desktop host is available" }
            : {})
      };
    }
    pi.setActiveTools([
      ...new Set([...pi.getActiveTools().filter((name) => !optional.has(name)), ...CORE_TOOLS, ...desired])
    ]);
    return available;
  }
  pi.registerTool({
    name: "enable_tools",
    label: "Load Task Tools",
    description:
      "Discover and enable optional tool groups for the current task. Omit groups to list availability. Attachments, delivery, jobs, computer, browser and cua are loaded only when needed; desktop, browser and CUA tools require a model connection that accepts image input. Enabling is not authorization: job grants and desktop grants remain enforced. Scripts need their underlying browser/computer tools enabled. CLI and App share all non-host-specific groups.",
    parameters: Type.Object({
      groups: Type.Optional(
        Type.Array(Type.Union(Object.keys(groups).map((name) => Type.Literal(name))), { uniqueItems: true })
      )
    }),
    async execute(_id, params) {
      for (const name of params.groups ?? []) {
        if (!Object.hasOwn(groups, name)) throw new Error(`Unknown capability group: ${name}`);
        requested.add(name);
      }
      if (params.groups?.length)
        await atomicWrite(statePath, JSON.stringify({ version: 1, groups: [...requested] }));
      const payload = {
        groups: await refresh(),
        descriptions: Object.fromEntries(
          Object.entries(groups).map(([name, group]) => [name, group.description])
        )
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(payload) }], details: payload };
    }
  });
  return {
    refresh,
    async restoreSelection(names: string[]) {
      for (const [name, group] of Object.entries(groups))
        if (group.tools.some((tool) => names.includes(tool))) requested.add(name);
      await atomicWrite(statePath, JSON.stringify({ version: 1, groups: [...requested] }));
      await refresh();
      const active = new Set(pi.getActiveTools());
      const missing = names.filter((name) => !active.has(name));
      if (missing.length)
        throw new Error(`原请求的工具暂不可用：${missing.join(", ")}。已有内容仍保留，请恢复原能力后重试。`);
    }
  };
}
