export const MAX_ATTACHMENT_BYTES = 128 * 1024;
export const MAX_PROMPT_BYTES = 512 * 1024;
const textExtensions =
  /\.(txt|md|markdown|csv|tsv|json|jsonl|yaml|yml|xml|html|css|js|mjs|cjs|ts|tsx|jsx|py|sh|sql|log|ini|toml|tex|svg)$/i;
/** Accept complete UTF-8 documents only; never silently truncate or stringify binaries. */
export async function readTextAttachments(files) {
  if (files.length > 3) throw new Error("每条消息最多添加 3 个文件，请减少后重试");
  return Promise.all(
    files.map(async (file) => {
      if (!textExtensions.test(file.name))
        throw new Error(`“${file.name}”暂不支持作为对话附件，请添加文本文件`);
      if (file.size > MAX_ATTACHMENT_BYTES)
        throw new Error(`“${file.name}”超过 128 KB，未添加；请拆分文件或在应用中打开`);
      let text;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
      } catch {
        throw new Error(`“${file.name}”不是有效 UTF-8 文本，未添加`);
      }
      if (
        [...text].some((char) => {
          const code = char.charCodeAt(0);
          return code <= 8 || (code >= 14 && code <= 31);
        })
      )
        throw new Error(`“${file.name}”包含二进制字符，未添加`);
      return { name: file.name, text, size: file.size };
    })
  );
}
export function composePrompt(text, attachments) {
  const prompt =
    text +
    (attachments.some((file) => !file.uploadId)
      ? `\n\nAttached files:\n${attachments
          .filter((file) => !file.uploadId)
          .map((file) => `--- ${file.name} ---\n${file.text}`)
          .join("\n\n")}`
      : "");
  if (prompt.includes("\0")) throw new Error("消息包含不支持的二进制字符");
  if (new TextEncoder().encode(prompt).length > MAX_PROMPT_BYTES)
    throw new Error("消息及附件合计不能超过 512 KB，请减少内容后重试");
  return prompt;
}
