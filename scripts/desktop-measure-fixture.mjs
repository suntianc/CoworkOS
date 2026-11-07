import { createHash } from "node:crypto";
import { cp, lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

async function files(root, dir = root) {
  const found = [];
  for (const name of (await readdir(dir)).sort()) {
    const path = join(dir, name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`fixture symlink is not allowed: ${path}`);
    if (info.isDirectory()) found.push(...(await files(root, path)));
    else if (info.isFile()) found.push(path);
    else throw new Error(`fixture contains unsupported file: ${path}`);
  }
  return found;
}

export async function hashFixture(root) {
  const base = resolve(root);
  const hash = createHash("sha256");
  for (const path of await files(base)) {
    const bytes = await readFile(path);
    hash.update(`${relative(base, path)}\0${bytes.length}\0`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

const PATH_FIELDS = new Set(["projectDirectory", "workspaceRoot", "projectCatalogPath"]);
const inside = (base, target) => target === base || target.startsWith(`${base}${sep}`);

function relocate(value, source, destination, field) {
  if (Array.isArray(value)) return value.map((entry) => relocate(entry, source, destination));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, relocate(item, source, destination, key)])
    );
  if (typeof value !== "string") return value;
  if (PATH_FIELDS.has(field) && value) {
    if (!isAbsolute(value) || !inside(source, resolve(value)))
      throw new Error(`${field} is outside fixture: ${value}`);
  }
  if (value === source || value.startsWith(`${source}${sep}`)) {
    const resolved = resolve(value);
    if (!inside(source, resolved)) throw new Error(`path is outside fixture: ${value}`);
    return resolve(destination, relative(source, resolved));
  }
  return value;
}

export async function prepareMeasuredFixture(template, dataRoot) {
  const source = resolve(template);
  const destination = resolve(dataRoot);
  if (inside(source, destination) || inside(destination, source)) throw new Error("fixture roots overlap");
  const templateHash = await hashFixture(source);
  try {
    await lstat(destination);
    throw new Error(`fixture destination already exists: ${destination}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await cp(source, destination, { recursive: true, errorOnExist: true, force: false });
  for (const path of await files(destination)) {
    if (!path.endsWith(".json") && !path.endsWith(".jsonl")) continue;
    const original = await readFile(path, "utf8");
    if (path.endsWith(".jsonl")) {
      const lines = original.split("\n");
      const updated = lines
        .map((line) => (line.trim() ? JSON.stringify(relocate(JSON.parse(line), source, destination)) : line))
        .join("\n");
      if (updated !== original) await writeFile(path, updated);
    } else {
      const value = JSON.parse(original);
      const updated = relocate(value, source, destination);
      if (JSON.stringify(value) !== JSON.stringify(updated))
        await writeFile(path, `${JSON.stringify(updated, null, 2)}\n`);
    }
  }
  if ((await hashFixture(source)) !== templateHash) throw new Error("fixture template changed during copy");
  return { templateHash, preparedHash: await hashFixture(destination) };
}
