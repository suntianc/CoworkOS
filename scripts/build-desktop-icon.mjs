import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, access, copyFile } from "node:fs/promises";
import { resolve, join } from "node:path";

// Native rendering keeps the original mark inside a rounded tile with an alpha margin.
// macOS does not mask custom app icons, so an opaque padded PNG would appear square.
if (process.platform === "darwin") {
  const source = resolve("web/assets/atria-symbol.png");
  const renderer = resolve("scripts/render-desktop-icon.swift");
  const build = resolve("build");
  const master = join(build, "atria-icon.png");
  const runtime = resolve("dist/src/desktop/atria-icon.png");
  const icns = join(build, "atria.icns");
  const marker = join(build, "atria-icon-source.sha256");
  const hash = createHash("sha256")
    .update("atria-icon-v2")
    .update(await readFile(source))
    .update(await readFile(renderer))
    .update(await readFile(new URL(import.meta.url)))
    .digest("hex");
  // eslint-disable-next-line no-restricted-syntax -- 首次构建还没有 marker 文件，读不到时用空哈希强制重新渲染图标
  const previous = await readFile(marker, "utf8").catch(() => "");
  const outputsExist = await Promise.all([access(master), access(runtime), access(icns)]).then(
    () => true,
    () => false
  );
  if (previous !== hash || !outputsExist) {
    const iconset = join(build, "atria.iconset");
    await mkdir(iconset, { recursive: true });
    await mkdir(resolve("dist/src/desktop"), { recursive: true });
    execFileSync(
      "/usr/bin/xcrun",
      ["swift", "-module-cache-path", join(build, "swift-module-cache"), renderer, source, master],
      { stdio: "inherit" }
    );
    for (const size of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        execFileSync(
          "/usr/bin/sips",
          [
            "--resampleHeightWidth",
            String(size * scale),
            String(size * scale),
            master,
            "--out",
            join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`)
          ],
          { stdio: "ignore" }
        );
      }
    }
    execFileSync("/usr/bin/iconutil", ["--convert", "icns", "--output", icns, iconset], { stdio: "ignore" });
    await copyFile(master, runtime);
    await writeFile(marker, hash);
  }
}
