/** Only a valid trailing upload manifest is interpreted as attachment metadata. */
export function splitUploadedFiles(source) {
  const text = String(source || "");
  const marker = "\n\n<atria_uploaded_files>\n";
  const boundary = text.lastIndexOf(marker);
  if (boundary < 0 || !text.endsWith("\n</atria_uploaded_files>")) return { text, files: [] };
  try {
    const manifest = JSON.parse(text.slice(boundary + marker.length, -"\n</atria_uploaded_files>".length));
    if (
      manifest.version !== 1 ||
      !Array.isArray(manifest.files) ||
      manifest.files.length > 10 ||
      manifest.files.some(
        (file) => !/^upload-[a-f0-9-]{36}$/.test(file?.uploadId) || typeof file.name !== "string"
      )
    )
      return { text, files: [] };
    return { text: text.slice(0, boundary), files: manifest.files };
    // eslint-disable-next-line no-restricted-syntax -- 尾部清单不保证是合法 JSON，解析失败时整段按正文处理
  } catch {
    return { text, files: [] };
  }
}
