import { ApplicationService } from "../dist/src/applications/application-service.js";
import { ApplicationRegistry } from "../dist/src/applications/registry.js";

// A structured test document exercises large shared history without a bundled editor.
export const documentAdapter = {
  definition: {
    contentBytes: 32 * 1024 * 1024,
    appType: "history-document",
    displayName: "History document",
    version: "1",
    resourceKinds: ["test/history+json"],
    fileImportFormats: [{ mimeType: "application/octet-stream", resourceKind: "test/history+json" }],
    fileExtensions: { "test/history+json": ".json" },
    capabilities: ["view", "edit", "undo"],
    operationSchemas: { "document.replace": { description: "Replace document", required: ["document"] } },
    exportFormats: ["json", "snapshot", "history-document"]
  },
  createContent: ({ initialContent }) => ({ theme: {}, ...initialContent }),
  serialize: (content) => JSON.stringify(content) + "\n",
  parse: JSON.parse,
  applyOperation: ({ content, payload }) => ({
    content: structuredClone(payload.document),
    summary: "Replace document",
    inverse: { operationType: "document.replace", payload: { document: content } }
  }),
  summarizeSelection: () => "",
  summarizeContext: () => ({ shape: "Structured document" }),
  exportResource: ({ content }) => ({
    fileName: "document.json",
    mimeType: "application/json",
    body: JSON.stringify(content)
  })
};
export function historyService(root) {
  return new ApplicationService(root, new ApplicationRegistry().register(documentAdapter));
}
export class FixtureApplicationService extends ApplicationService {
  constructor(root, _registry, storageRoot, project) {
    super(root, new ApplicationRegistry().register(documentAdapter), storageRoot, project);
  }
}
