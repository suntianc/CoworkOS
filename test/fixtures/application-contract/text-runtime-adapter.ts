// Test-only adapter fixture for resource, recovery and MCP contracts. Not shipped.
import {
  ApplicationError,
  RESOURCE_LIMITS,
  bounded,
  describeValue,
  textHash,
  type ApplicationDefinition,
  type ContextRequest,
  type ContextSummary,
  type ExportResult,
  type OperationResult,
  type WorkbenchRuntimeAdapter,
  type WorkspaceResource
} from "../../../src/applications/types.js";
import { findSection, headingTitles, outline } from "./text-outline.js";

/**
 * The reference Adapter, and the only place text is understood.
 *
 * Positions are UTF-16 code-unit offsets — the same indices `String.prototype`
 * uses — fixed here so the API, the browser editor and the tests cannot drift
 * apart on what "character 12" means. Every mutating operation also carries a
 * hash of the text it expects to find: a correct revision is not by itself proof
 * that the precondition still holds, because two different edits can produce the
 * same revision number after a retry.
 */

interface TextRange {
  from: number;
  to: number;
}

const KINDS = ["text/plain", "text/markdown"];

/**
 * How much of a document one `read_document` call returns.
 *
 * Past this the read is truncated and the headings come back instead, so the
 * model narrows with `heading` rather than paging by offset.
 */
const READ_LIMIT = 64 * 1024;

function asString(content: unknown): string {
  return typeof content === "string" ? content : "";
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ApplicationError("invalid_operation", `${field} 必须是非负整数`, {
      field,
      received: describeValue(value)
    });
  }
  return value;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string")
    throw new ApplicationError("invalid_operation", `${field} 必须是字符串`, { field });
  if (Buffer.byteLength(value, "utf8") > RESOURCE_LIMITS.operationBytes) {
    throw new ApplicationError(
      "resource_too_large",
      `单次操作新增文本超过 ${RESOURCE_LIMITS.operationBytes} 字节`,
      { field, limit: RESOURCE_LIMITS.operationBytes }
    );
  }
  return value;
}

function requireRange(payload: Record<string, unknown>, content: string): TextRange {
  const from = requireNumber(payload.from, "from");
  const to = requireNumber(payload.to, "to");
  if (to < from) throw new ApplicationError("invalid_operation", "to 不能小于 from", { from, to });
  if (to > content.length) {
    throw new ApplicationError("operation_precondition_failed", "操作范围超出当前内容长度", {
      from,
      to,
      length: content.length
    });
  }
  return { from, to };
}

/**
 * Verify the text an operation believed it was replacing.
 *
 * Optional on purpose: a fresh editor that has just loaded the snapshot knows
 * the exact bytes, but an Agent computing a patch from a summary may not. When
 * the hash is supplied it is enforced, so a stale patch is refused rather than
 * silently applied to different text.
 */
function verifyPrecondition(expected: unknown, actual: string, field: string): void {
  if (expected === undefined || expected === null) return;
  if (typeof expected !== "string")
    throw new ApplicationError("invalid_operation", `${field} 必须是字符串`, { field });
  if (expected !== textHash(actual)) {
    throw new ApplicationError(
      "operation_precondition_failed",
      "待修改的内容已经变化，请重新读取资源后再提交",
      { field }
    );
  }
}

function assertSize(content: string): string {
  if (Buffer.byteLength(content, "utf8") > RESOURCE_LIMITS.contentBytes) {
    throw new ApplicationError(
      "resource_too_large",
      `文档超过 ${RESOURCE_LIMITS.contentBytes / (1024 * 1024)} MiB 上限`,
      { limit: RESOURCE_LIMITS.contentBytes }
    );
  }
  return content;
}

/**
 * A short, readable label for a fragment, used in summaries rather than full text.
 *
 * Summaries land in the operation log and in the Agent's prompt, so they stay
 * an excerpt with a length: a person reading history wants to recognise the
 * change, not re-read the paragraph, and a deleted section must never be
 * resurrected in full by the very record of its deletion.
 */
function fragment(value: string, limit = 24): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  return collapsed.length > limit ? `${collapsed.slice(0, limit)}…（共 ${collapsed.length} 字）` : collapsed;
}

/** 1-based line number of an offset, for summaries a person can act on. */
function lineAt(content: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < Math.min(offset, content.length); index += 1) {
    if (content[index] === "\n") line += 1;
  }
  return line;
}

/** How many times `needle` appears, which decides whether a rewrite is unambiguous. */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length))
    count += 1;
  return count;
}

function lineSpan(content: string, from: number, to: number): string {
  const start = lineAt(content, from);
  const end = lineAt(content, to);
  return start === end ? `第 ${start} 行` : `第 ${start}–${end} 行`;
}

const definition: ApplicationDefinition = {
  appType: "text-editor",
  entryReadTool: "read_document",
  displayName: "文本编辑器",
  version: "1",
  resourceKinds: KINDS,
  capabilities: ["view", "edit", "select", "history", "export", "agent-commands"],
  fileExtensions: { "text/plain": ".txt", "text/markdown": ".md" },
  // The one selection shape this editor reads: `{ anchor, head }` as UTF-16
  // offsets. Anything else would be summarized from absent fields.
  selectionSchemas: ["text.range/v1"],
  operationSchemas: {
    // These are the protocol, not the model's interface. They are offset-based
    // because a protocol has to be precise: the editor knows exact positions
    // from the caret, and undo needs an inverse that restores exactly.
    //
    // A model must not be pointed at them. It sees a document as text, and two
    // separate runs proved what offsets cost: one failed six times on
    // "at 必须是非负整数" and wrote nothing, and a later one read "第 3 行 ##
    // 目标用户" from the context summary, passed `from: 4` to text.replace, and
    // silently wrote into line 1 — accepted, because 4 is a valid offset in a
    // 33-character document. The second failure is the worse one: nothing
    // reported it. So the model reaches these only through `agentTools` below,
    // which take content and compute the arithmetic here.
    "text.rewrite": {
      description: "用 content 整体替换文档内容。可传 baseContentHash 确认替换的是你读到的那份。",
      required: ["content"],
      optional: ["baseContentHash"]
    },
    "text.insert": {
      description: "编辑器协议：在 at 位置插入文本，at 是 UTF-16 offset。模型请用 patch_document。",
      required: ["at", "text"],
      optional: ["precedingTextHash"]
    },
    "text.delete": {
      description: "编辑器协议：删除 [from, to) 区间。模型请用 patch_document，传空 newText 表示删除。",
      required: ["from", "to"],
      optional: ["deletedTextHash"]
    },
    "text.replace": {
      description:
        "编辑器协议：用 text 替换 [from, to) 区间，from/to 是 UTF-16 offset。模型请用 patch_document，它按内容定位，不需要算 offset。",
      required: ["from", "to", "text"],
      optional: ["replacedTextHash"]
    }
  },
  exportFormats: ["markdown", "text"],
  // The reference MCP server. Its tools know what a heading is, which is the
  // kind of thing the platform deliberately does not — the same slot a real
  // CAD server would fill with its own domain knowledge.
  mcpServer: {
    command: process.execPath,
    args: ["dist/test/fixtures/application-contract/text-editor-server.js"]
  }
};

export const textRuntimeAdapter: WorkbenchRuntimeAdapter = {
  definition,

  // Text is its own serialization: the file holds exactly the document, so a
  // person editing it in another editor sees no wrapper and no metadata.
  serialize(content) {
    return asString(content);
  },
  parse(raw) {
    return raw;
  },

  createContent(input) {
    if (!KINDS.includes(input.kind)) {
      throw new ApplicationError("unsupported_resource_kind", `文本编辑器不支持 ${input.kind}`, {
        kind: input.kind,
        supported: KINDS
      });
    }
    if (input.initialContent === undefined || input.initialContent === null) return "";
    if (typeof input.initialContent !== "string") {
      throw new ApplicationError("invalid_operation", "文本资源的 initialContent 必须是字符串", {});
    }
    return assertSize(input.initialContent);
  },

  applyOperation({ operationType, payload, content }): OperationResult {
    const current = asString(content);
    const value = (payload ?? {}) as Record<string, unknown>;

    // Content-addressed operations come first, because they are the ones a
    // model can actually use: they take the text rather than an offset it would
    // have to compute. The offset operations below stay for the editor, which
    // knows exact positions from the caret.
    if (operationType === "text.rewrite") {
      const next = assertSize(requireText(value.content, "content"));
      verifyPrecondition(value.baseContentHash, current, "baseContentHash");
      return {
        content: next,
        summary: current
          ? `改写全文（${current.length} → ${next.length} 个字符）`
          : `写入 ${next.length} 个字符`,
        // The whole previous content, so undo restores it exactly.
        inverse: {
          operationType: "text.rewrite",
          payload: { content: current, baseContentHash: textHash(next) }
        }
      };
    }

    if (operationType === "text.insert") {
      const at = requireNumber(value.at, "at");
      if (at > current.length) {
        throw new ApplicationError("operation_precondition_failed", "插入位置超出当前内容长度", {
          at,
          length: current.length
        });
      }
      const text = requireText(value.text, "text");
      verifyPrecondition(value.precedingTextHash, current.slice(0, at), "precedingTextHash");
      const next = assertSize(`${current.slice(0, at)}${text}${current.slice(at)}`);
      return {
        content: next,
        summary: `在${lineSpan(current, at, at)}插入“${fragment(text)}”`,
        inverse: {
          operationType: "text.delete",
          payload: { from: at, to: at + text.length, deletedTextHash: textHash(text) }
        }
      };
    }
    if (operationType === "text.delete") {
      const range = requireRange(value, current);
      const removed = current.slice(range.from, range.to);
      verifyPrecondition(value.deletedTextHash, removed, "deletedTextHash");
      const next = `${current.slice(0, range.from)}${current.slice(range.to)}`;
      return {
        content: next,
        summary: removed
          ? `删除${lineSpan(current, range.from, range.to)}的“${fragment(removed)}”`
          : `删除${lineSpan(current, range.from, range.to)}的空区间`,
        inverse: { operationType: "text.insert", payload: { at: range.from, text: removed } }
      };
    }
    if (operationType === "text.replace") {
      const range = requireRange(value, current);
      const text = requireText(value.text, "text");
      const replaced = current.slice(range.from, range.to);
      verifyPrecondition(value.replacedTextHash, replaced, "replacedTextHash");
      const next = assertSize(`${current.slice(0, range.from)}${text}${current.slice(range.to)}`);
      const where = lineSpan(current, range.from, range.to);
      // A replace with empty text is a deletion, and reads far better as one:
      // the editor sends replace for every debounced edit, including removals.
      const summary =
        !text && replaced
          ? `删除${where}的“${fragment(replaced)}”`
          : replaced
            ? `把${where}的“${fragment(replaced)}”改为“${fragment(text)}”`
            : `在${where}写入“${fragment(text)}”`;
      return {
        content: next,
        summary,
        inverse: {
          operationType: "text.replace",
          payload: {
            from: range.from,
            to: range.from + text.length,
            text: replaced,
            replacedTextHash: textHash(text)
          }
        }
      };
    }
    throw new ApplicationError("invalid_operation", `文本编辑器不支持操作 ${operationType}`, {
      operationType
    });
  },

  summarizeSelection({ selection, content }): string {
    const current = asString(content);
    const data = (selection.data ?? {}) as Record<string, unknown>;
    const anchor = typeof data.anchor === "number" ? data.anchor : 0;
    const head = typeof data.head === "number" ? data.head : anchor;
    const from = Math.max(0, Math.min(anchor, head));
    const to = Math.min(current.length, Math.max(anchor, head));
    if (from === to) return `光标位于${lineSpan(current, from, from)}`;
    const text = current.slice(from, to);
    // The summary travels into prompts and a durable state file, so it is a
    // bounded excerpt rather than a copy of whatever the user happened to select.
    return `${lineSpan(current, from, to)}：“${bounded(text, RESOURCE_LIMITS.selectionSummary - 40)}”`;
  },

  summarizeContext(input: ContextRequest): ContextSummary {
    const current = asString(input.content);
    const titles = headingTitles(current, 8);
    // Titles identify sections without inviting line-number/character-offset
    // confusion. The platform context supplies document size separately.
    const shape = titles.length
      ? `${titles.length} 个标题：${titles.join(" / ")}`
      : current.trim()
        ? `无标题，开头是“${fragment(
            current
              .split("\n")
              .find((line) => line.trim())
              ?.trim() ?? "",
            80
          )}”`
        : "空文档";
    return { shape, selectionSummary: input.selection?.summary };
  },

  exportResource({ resource, content, format }): ExportResult {
    if (!definition.exportFormats.includes(format)) {
      throw new ApplicationError("invalid_operation", `文本编辑器不支持导出格式 ${format}`, {
        format,
        supported: definition.exportFormats
      });
    }
    return {
      fileName: exportFileName(resource, format),
      mimeType: format === "markdown" ? "text/markdown" : "text/plain",
      body: asString(content)
    };
  },

  /**
   * Text-oriented model tools use unambiguous anchors and replacements rather
   * than requiring callers to calculate offsets. Returned operations still
   * pass through revision CAS, the operation log and undo.
   *
   * The adapter owns content reads and pagination. In-process reads remain
   * available when MCP cannot start; text-outline supplies shared section logic.
   */
  agentTools: () => [
    {
      name: "read_document",
      access: "read",
      description: [
        "读取当前文档的正文。修改之前先读一遍：patch_document 需要一段和文档完全一致的原文来定位。",
        "文档很长时传 heading 只读某一节，不要反复读全文。"
      ].join("\n"),
      parameters: {
        type: "object",
        properties: {
          heading: {
            type: "string",
            description: "只读这个标题下的一节，含其下的子标题。不含 # 号。省略则读全文。"
          }
        }
      },
      async execute({ params, content, resource }) {
        const current = asString(content);
        const wanted = typeof params.heading === "string" ? params.heading.trim() : "";
        const sections = outline(current);
        if (wanted) {
          const target = findSection(sections, wanted);
          if (!target) {
            throw new ApplicationError(
              "operation_precondition_failed",
              `找不到标题「${wanted}」。文档现有的标题：${sections.map((section) => section.title).join("、") || "（无）"}`,
              { heading: wanted, known: sections.map((section) => section.title) }
            );
          }
          return {
            result: {
              revision: resource.revision,
              heading: target.title,
              content: current.slice(target.start, target.end)
            }
          };
        }
        // Bounded, and the truncation hands back the headings rather than an
        // offset to resume from: narrowing is something the model can act on,
        // arithmetic is what it gets wrong.
        if (current.length <= READ_LIMIT)
          return { result: { revision: resource.revision, content: current } };
        return {
          result: {
            revision: resource.revision,
            content: current.slice(0, READ_LIMIT),
            truncated: true,
            headings: sections.map((section) => section.title),
            note: "文档过长，只返回了开头。用 heading 参数读需要的那一节。"
          }
        };
      }
    },
    {
      name: "outline_document",
      access: "read",
      description:
        "只看文档的标题结构（层级、标题、每节字数），不返回正文。先看结构再决定读哪里，比读全文省上下文。",
      parameters: { type: "object", properties: {} },
      async execute({ content, resource }) {
        const sections = outline(asString(content));
        return {
          result: {
            revision: resource.revision,
            sections: sections.map((section) => ({
              level: section.level,
              title: section.title,
              length: section.end - section.start
            }))
          }
        };
      }
    },
    {
      name: "patch_document",
      description: [
        "按内容修改文档的一处：把 oldText 换成 newText，不需要计算任何 offset。",
        "oldText 必须在文档中恰好出现一次 —— 这是它能安全定位的唯一保证。",
        "找不到说明你读到的内容已过期，请重新 read_document；出现多次说明要多带几行上下文让它唯一。",
        "删除一段就把 newText 传空字符串。"
      ].join("\n"),
      parameters: {
        type: "object",
        properties: {
          oldText: {
            type: "string",
            description: "要被替换的原文，必须恰好出现一次。带上足够的上下文让它唯一。"
          },
          newText: { type: "string", description: "替换成什么。传空字符串表示删除这一段。" }
        },
        required: ["oldText", "newText"]
      },
      async execute({ params, content }) {
        const current = asString(content);
        const oldText = typeof params.oldText === "string" ? params.oldText : "";
        const newText = typeof params.newText === "string" ? params.newText : "";
        if (!oldText) {
          throw new ApplicationError("invalid_operation", "oldText 不能为空：需要一段原文来定位", {
            field: "oldText"
          });
        }
        // Counted, not replaced blindly. Ambiguity is the failure worth naming:
        // the model can act on "stale read" and on "be more specific", but not
        // on an edit that silently landed in the wrong place.
        const occurrences = countOccurrences(current, oldText);
        if (occurrences !== 1) {
          throw new ApplicationError(
            "operation_precondition_failed",
            occurrences === 0
              ? `文档中找不到这段原文，你读到的内容可能已过期，请重新 read_document：“${fragment(oldText)}”`
              : `这段原文出现了 ${occurrences} 次，无法确定改哪一处。请多带几行上下文让它唯一：“${fragment(oldText)}”`,
            { found: occurrences, expected: 1, oldText: fragment(oldText) }
          );
        }
        const at = current.indexOf(oldText);
        return {
          result: {
            replaced: fragment(oldText),
            at: lineSpan(current, at, at + oldText.length),
            length: current.length - oldText.length + newText.length
          },
          // The precondition hash pins the exact text: a correct revision is not
          // proof the anchor still says what the model read, and this is the one
          // guard that catches an ABA retry.
          operations: [
            {
              operationType: "text.replace",
              payload: {
                from: at,
                to: at + oldText.length,
                text: newText,
                replacedTextHash: textHash(oldText)
              }
            }
          ]
        };
      }
    },
    {
      name: "write_document",
      description: [
        "整体写入文档内容，替换现有全文。改写整篇、或者文档还是空的时候用这个。",
        "只修改其中一处时用 patch_document，避免把别人的改动一起冲掉。"
      ].join("\n"),
      parameters: {
        type: "object",
        properties: { content: { type: "string", description: "文档的完整新内容。" } },
        required: ["content"]
      },
      async execute({ params, content }) {
        const current = asString(content);
        const next = typeof params.content === "string" ? params.content : "";
        return {
          result: { from: current.length, to: next.length },
          operations: [
            { operationType: "text.rewrite", payload: { content: next, baseContentHash: textHash(current) } }
          ]
        };
      }
    }
  ]
};

/**
 * Derive a safe artifact name from a user-chosen title.
 *
 * The Artifact Store applies its own containment checks; this only guarantees a
 * plausible name reaches it, so a title like `../../etc/passwd` never becomes a
 * path in the first place.
 */
function exportFileName(resource: WorkspaceResource, format: string): string {
  const extension = format === "markdown" ? ".md" : ".txt";
  const base = resource.title
    .replace(/[\\/]+/g, "-")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    // Collapse every run of dots so a title like "../../etc/passwd" cannot
    // survive as a traversal fragment once the separators are gone.
    .replace(/\.{2,}/g, ".")
    .replace(/^[.\-\s]+/, "")
    .trim();
  const stem = (base || resource.resourceId)
    .slice(0, 80)
    .replace(/\.(md|markdown|txt)$/i, "")
    .trim();
  return `${stem || resource.resourceId}${extension}`;
}
