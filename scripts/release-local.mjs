import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const execute = (command, args, options = {}) =>
  execFileSync(command, args, { stdio: "inherit", ...options });

export async function runLocalRelease({
  tag = process.env.RELEASE_TAG,
  repository = process.env.GITHUB_REPOSITORY || "RUC-NLPIR/CoworkOS",
  root = process.cwd(),
  platform = process.platform,
  arch = process.arch,
  commandRunner = execute
} = {}) {
  if (platform !== "darwin" || arch !== "arm64")
    throw new Error("Local release packaging requires an Apple Silicon Mac");
  if (typeof tag !== "string" || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag))
    throw new Error("Usage: npm run release:local -- v<version>");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Invalid GitHub repository");
  root = resolve(root);
  const releaseEnv = { ...process.env, RELEASE_TAG: tag, GITHUB_REPOSITORY: repository };
  const run = async (command, args, extra = {}) => {
    const { env = {}, ...options } = extra;
    return commandRunner(command, args, {
      ...options,
      cwd: root,
      env: { ...releaseEnv, ...env }
    });
  };

  await run("node", ["scripts/release-metadata.mjs"]);
  await run("npm", ["run", "desktop:dist"]);
  await run("npm", ["run", "cli:pack"]);
  await run("npm", ["run", "desktop:npm:pack"], {
    env: { ATRIA_DESKTOP_NPM_PACKAGE_DIR: join(root, "release") }
  });
  await run("npm", ["run", "npm:pack"], {
    env: { ATRIA_PACKAGE_DIR: join(root, "release") }
  });

  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const npmArchives = [`coworkos-desktop-darwin-arm64-${pkg.version}.tgz`, `coworkos-app-${pkg.version}.tgz`];
  for (const name of npmArchives) {
    const bytes = await readFile(join(root, "release", name));
    const digest = createHash("sha256").update(bytes).digest("hex");
    await writeFile(join(root, "release", name + ".sha256"), `${digest}  ${name}\n`);
  }

  await run("node", ["scripts/release-artifacts.mjs"]);
  await run("node", ["scripts/release-draft.mjs", "upload"]);
  await run("gh", [
    "release",
    "upload",
    tag,
    ...npmArchives.flatMap((name) => [join(root, "release", name), join(root, "release", name + ".sha256")]),
    "--repo",
    repository,
    "--clobber"
  ]);
  console.log(
    `Draft assets for ${tag} are uploaded. Review the draft files, then run Publish npm packages with tag ${tag} in GitHub Actions. Publish the GitHub Release only after npm verification.`
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await runLocalRelease({ tag: process.argv[2] || process.env.RELEASE_TAG });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
