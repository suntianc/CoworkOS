import { artifactRequestUrls, artifactVersion } from "../artifacts.js";

/** Convert an indexed artifact through its UI Adapter while preserving its source identity. */
export async function importArtifactFile({ taskId, artifact, catalog, registry, api }) {
  // Resolve persisted source identity before downloading or converting. This
  // also works after reload, when the Task detail has no sourceResourceId.
  try {
    return await api.importArtifact(taskId, artifact.relativePath);
  } catch (error) {
    if (error.code !== "unsupported_resource_kind") throw error;
  }
  const application = catalog.find((entry) =>
    entry.fileImportFormats?.some((format) => format.mimeType === artifact.mimeType)
  );
  if (!application) throw new Error("此文件格式没有可用的应用导入器");
  const format = application.fileImportFormats.find((entry) => entry.mimeType === artifact.mimeType);
  const adapter = registry[application.appType];
  if (!adapter?.importFile) throw new Error("此应用的文件导入器不可用");
  const limit = application.contentBytes ?? 2 * 1024 * 1024;
  if (artifact.size > limit) throw new Error(`文件超过 ${limit / 1024 / 1024} MiB 上限`);
  const { rawUrl } = artifactRequestUrls(taskId, artifact.relativePath, artifactVersion(artifact));
  const readBytes = api.readBytes || (async (url) => ({ blob: await (await fetch(url)).blob() }));
  const { blob: file } = await readBytes(rawUrl);
  if (file.size > limit) throw new Error(`文件超过 ${limit / 1024 / 1024} MiB 上限`);
  const artifactSha256 = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())),
    (byte) => byte.toString(16).padStart(2, "0")
  ).join("");
  const name = artifact.displayName || artifact.relativePath.split("/").at(-1);
  // No resource exists until conversion succeeds. Failed imports leave no empty document.
  const converted = await adapter.importFile(new File([file], name, { type: artifact.mimeType }));
  return api.importArtifact(taskId, artifact.relativePath, {
    artifactSha256,
    appType: application.appType,
    kind: format.resourceKind,
    title: converted.title || name,
    initialContent: converted.content
  });
}
