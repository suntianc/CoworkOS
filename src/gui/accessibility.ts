/** IDs in public observations are scoped to that observation, never reusable handles. */
export interface ComputerAccessibilityElement {
  elementId: string;
  parentId?: string;
  role: string;
  name: string;
  value?: string;
  enabled: boolean;
  actions: Array<"press" | "set_value">;
}
export interface DriverAccessibilityElement extends ComputerAccessibilityElement {
  path: number[];
  identity: string;
  fingerprint: string;
}
export interface DriverAccessibility {
  elements: DriverAccessibilityElement[];
  truncated: boolean;
  available: boolean;
}
export type ComputerWaitCondition =
  | { type: "accessibility_text"; text: string; state: "present" | "absent" }
  | {
      type: "element";
      role?: string;
      name?: string;
      value?: string;
      state: "present" | "absent" | "enabled";
    };

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length <= maximum && !value.includes("\0");
}

/** Validate the trusted driver boundary too; omit opaque native identity data from public results. */
export function driverAccessibility(value: unknown): DriverAccessibility {
  if (!value || typeof value !== "object") throw new Error("辅助功能树格式无效");
  const tree = value as DriverAccessibility;
  if (
    !Array.isArray(tree.elements) ||
    tree.elements.length > 200 ||
    typeof tree.available !== "boolean" ||
    typeof tree.truncated !== "boolean"
  )
    throw new Error("辅助功能树超限或格式无效");
  const ids = new Set<string>();
  const elements = tree.elements.map((element) => {
    if (
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- elements 来自按 unknown 校验后断言的驱动载荷，数组元素在运行期可能为 null
      !element ||
      !boundedText(element.elementId, 128) ||
      !element.elementId ||
      ids.has(element.elementId) ||
      !boundedText(element.role, 128) ||
      !element.role ||
      !boundedText(element.name, 512) ||
      (element.value !== undefined && !boundedText(element.value, 512)) ||
      (element.parentId !== undefined && !ids.has(element.parentId)) ||
      typeof element.enabled !== "boolean" ||
      !Array.isArray(element.actions) ||
      element.actions.length > 2 ||
      element.actions.some((action) => !["press", "set_value"].includes(action)) ||
      new Set(element.actions).size !== element.actions.length ||
      !Array.isArray(element.path) ||
      element.path.length > 8 ||
      element.path.some((index) => !Number.isSafeInteger(index) || index < 0 || index > 100_000) ||
      !boundedText(element.identity, 128) ||
      !element.identity ||
      !boundedText(element.fingerprint, 128) ||
      !element.fingerprint
    )
      throw new Error("辅助功能控件格式无效");
    ids.add(element.elementId);
    const secure = element.role === "AXSecureTextField";
    return {
      elementId: element.elementId,
      ...(element.parentId ? { parentId: element.parentId } : {}),
      role: element.role,
      name: element.name,
      ...(!secure && element.value !== undefined ? { value: element.value } : {}),
      enabled: element.enabled,
      actions: secure ? [] : [...element.actions],
      path: [...element.path],
      identity: element.identity,
      fingerprint: element.fingerprint
    };
  });
  return { elements, available: tree.available, truncated: tree.truncated };
}

export function accessibilityObservation(tree: DriverAccessibility | undefined, observationId?: string) {
  if (!tree) return undefined;
  const id = (key: string) => (observationId ? `${observationId}:${key}` : key);
  return {
    available: tree.available,
    truncated: tree.truncated,
    elements: tree.elements.map(
      ({ path: _path, identity: _identity, fingerprint: _fingerprint, ...element }) => ({
        ...element,
        elementId: id(element.elementId),
        ...(element.parentId ? { parentId: id(element.parentId) } : {})
      })
    )
  };
}

export function computerWaitCondition(input: unknown): ComputerWaitCondition {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("等待条件必须是对象");
  const condition = input as Record<string, unknown>;
  if (
    condition.type === "accessibility_text" &&
    boundedText(condition.text, 512) &&
    condition.text.trim() &&
    ["present", "absent"].includes(String(condition.state))
  )
    return {
      type: "accessibility_text",
      text: condition.text,
      state: condition.state as "present" | "absent"
    };
  if (condition.type === "element" && ["present", "absent", "enabled"].includes(String(condition.state))) {
    const { role, name, value } = condition;
    if (
      (role !== undefined && (!boundedText(role, 128) || !role.trim())) ||
      (name !== undefined && (!boundedText(name, 512) || !name.trim())) ||
      (value !== undefined && !boundedText(value, 512)) ||
      (!role && !name)
    )
      throw new Error("控件等待条件至少需要非空 role 或 name，字段必须在长度限制内");
    return {
      type: "element",
      state: condition.state as "present" | "absent" | "enabled",
      ...(role !== undefined ? { role } : {}),
      ...(name !== undefined ? { name } : {}),
      ...(value !== undefined ? { value } : {})
    };
  }
  throw new Error("不支持的等待条件；使用 accessibility_text 或 element");
}

export function waitConditionMet(
  frame: { accessibilityText?: string; accessibility?: DriverAccessibility },
  condition: ComputerWaitCondition
) {
  // Absence cannot be established from unavailable or truncated accessibility data.
  if (frame.accessibility?.available === false) return false;
  if (condition.type === "accessibility_text") {
    if (typeof frame.accessibilityText !== "string") return false;
    const present = frame.accessibilityText.includes(condition.text);
    return condition.state === "present" ? present : !present && !frame.accessibility?.truncated;
  }
  if (!frame.accessibility) return false;
  const matching = frame.accessibility.elements.filter(
    (element) =>
      (condition.role === undefined || element.role === condition.role) &&
      (condition.name === undefined || element.name === condition.name) &&
      (condition.value === undefined || element.value === condition.value)
  );
  if (condition.state === "absent") return matching.length === 0 && !frame.accessibility.truncated;
  return condition.state === "enabled" ? matching.some((element) => element.enabled) : matching.length > 0;
}
