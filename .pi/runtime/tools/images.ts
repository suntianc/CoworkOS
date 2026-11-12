import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createImageTools } from "../../../dist/src/tools/read-image.js";
import type { CoworkToolContext } from "../extension.ts";

export function registerImageTools(pi: ExtensionAPI, context: CoworkToolContext) {
  const tools = createImageTools({
    rootDirectory: context.projectDirectory,
    taskDirectory: context.taskWorkspace,
    workScope: "project",
    supportsImages: context.supportsImages
  });
  for (const name of Object.keys(tools) as Array<keyof typeof tools>) {
    const tool = tools[name];
    // Main and delegated Pi sessions expose the same provider-compatible schema.
    const parameters = Type.Unsafe<unknown>(tool.parameters);
    pi.registerTool<typeof parameters, unknown>({
      name,
      label: {
        read_image: "Read Image",
        read_images: "Compare Images",
        crop_image: "Crop Image",
        list_images: "Image History"
      }[name],
      description: tool.description,
      executionMode: name === "read_image" ? "parallel" : "sequential",
      promptSnippet: {
        read_image: "Inspect images with paths:[...] (1–4) or a historical imageRef",
        read_images: "Inspect up to four images together for comparison",
        crop_image: "Crop/zoom an existing PNG screenshot with source pixel mapping",
        list_images: "Find historical Task imageRefs for rereading"
      }[name],
      promptGuidelines: [
        "ImageRefs and archived crops are historical visual evidence, not current desktop observations. Reobserve a live target before acting. Inspect each final image separately for QA; a contact sheet checks consistency. Fix visible defects and recheck changed image hashes; at most one retry per failed check."
      ],
      parameters,
      async execute(_id, params, signal) {
        return tool.execute(params, signal);
      }
    });
  }
}
