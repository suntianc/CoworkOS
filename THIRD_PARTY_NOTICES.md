# 第三方软件 / Third-party software

CoworkOS 自有代码使用 [MIT](LICENSE)。第三方代码、依赖与外部运行时保留其许可证、版权和分发条件；根 MIT 文件不替代这些许可证。

CoworkOS's original code is licensed under [MIT](LICENSE). Third-party sources, dependencies and external runtimes retain their own licenses, copyrights and distribution terms. The root MIT license does not replace them.

本文许可链接指向锁定版本的上游文件或 npm 源包（其中包含 LICENSE、NOTICE 或 README 许可章节），源码仓库不再维护根目录 `licenses/` 副本。发行包中实际保留的许可仍按最终包内容单独校验。

License links below point to versioned upstream files or npm source archives containing the LICENSE, NOTICE or README license section. This checkout no longer maintains root `licenses/` copies. License retention in distributed artifacts is checked against the actual packages separately.

## Inter 界面字体 / Interface typeface

应用随包分发 [Inter Variable](web/assets/fonts/InterVariable.woff2)，来自 [Inter](https://github.com/rsms/inter) 官方字体的 [inter-ui 4.1.1 npm 发行](https://registry.npmjs.org/inter-ui/-/inter-ui-4.1.1.tgz)（`variable/InterVariable.woff2`）。字体未经修改，SHA-256 为 `693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3`，支持 100–900 字重与光学字号。版权所有者为 The Inter Project Authors，适用 **SIL Open Font License 1.1**；完整[许可及版权声明](web/assets/fonts/Inter-LICENSE.txt)与字体一起保留。字体由本地加载，不增加运行时网络请求或 npm 依赖。

The application bundles the unmodified Inter Variable font from the linked `inter-ui 4.1.1` distribution of the official Inter typeface (`variable/InterVariable.woff2`), with the SHA-256 recorded above. It supports weights 100–900 and optical sizing. Copyright belongs to The Inter Project Authors under the **SIL Open Font License 1.1**; the complete license and copyright notice are retained alongside the font. The font loads locally without runtime network requests or additional npm dependencies.

## Documentation site / 文档站

独立 Docs 站点的工具依赖由 [docs/site/package-lock.json](docs/site/package-lock.json) 锁定。Markdown 构建使用 marked 与 sanitize-html，浏览器中的图表使用 Mermaid，资源由 esbuild 打包；这些依赖不加入产品运行时。站点构建按实际浏览器 bundle 的输入保留相应包的完整许可与 NOTICE，生成到 `.tmp/docs-site/_site/licenses/`，并从每页页脚链接许可索引。

The standalone Docs toolchain is pinned by its own lockfile. It uses marked and sanitize-html to build Markdown, Mermaid for browser diagrams, and esbuild for bundling, independently of product runtime dependencies. Builds retain complete license and notice files for packages used by the browser bundle in `.tmp/docs-site/_site/licenses/`, linked from each page footer.

## KaTeX

Web/App 的数学排版使用锁定的 [KaTeX 0.19.0](https://github.com/KaTeX/KaTeX/tree/v0.19.0)，保留其 [MIT 许可证及版权全文](https://registry.npmjs.org/katex/-/katex-0.19.0.tgz)。构建从原始 npm 发行复制浏览器 ESM（仅将 `.mjs` 改名为 `.js`）、CSS、字体和许可证到本地静态资源，不修改上游实现，不依赖外部 CDN。CLI tgz 不包含 Web 排版资源。

Web/App math uses pinned [KaTeX 0.19.0](https://github.com/KaTeX/KaTeX/tree/v0.19.0), retaining its [complete MIT license and copyright notice](https://registry.npmjs.org/katex/-/katex-0.19.0.tgz). Builds copy the original npm distribution's browser ESM (renaming only `.mjs` to `.js`), CSS, fonts and license into local static assets without modifying the implementation or requiring an external CDN. The CLI archive excludes these Web rendering assets.

## Dependencies and external runtimes

视觉观察的 PNG 裁剪与缩放使用纯 JavaScript 的 `pngjs` `7.0.0`，随 CLI/App 生产依赖分发，保留其完整 [MIT 许可证](https://registry.npmjs.org/pngjs/-/pngjs-7.0.0.tgz)。来源为 [pngjs v7.0.0](https://github.com/pngjs/pngjs/tree/v7.0.0)。类型依赖 `@types/pngjs` `6.0.5` 仅用于开发。

PNG cropping and resizing use the pure JavaScript `pngjs` `7.0.0` package, distributed as a CLI/App production dependency with its complete [MIT license](https://registry.npmjs.org/pngjs/-/pngjs-7.0.0.tgz). Source: [pngjs v7.0.0](https://github.com/pngjs/pngjs/tree/v7.0.0). `@types/pngjs` `6.0.5` is a development-only type dependency.

项目数据的 PostgreSQL 适配器使用 `pg`（node-postgres）`8.23.1`，随 CLI/App 生产依赖分发，保留其 [MIT 许可证](https://registry.npmjs.org/pg/-/pg-8.23.1.tgz)。来源为 [node-postgres v8.23.1](https://github.com/brianc/node-postgres/tree/v8.23.1)。数据库连接属于运行配置，源码和发行包不包含真实数据库凭据。

The project data PostgreSQL adapter uses `pg` (node-postgres) `8.23.1`, distributed as a CLI/App production dependency with its [MIT license](https://registry.npmjs.org/pg/-/pg-8.23.1.tgz). Source: [node-postgres v8.23.1](https://github.com/brianc/node-postgres/tree/v8.23.1). Database connections are runtime configuration; the source and released packages carry no real database credential.

Browser Use 使用 `playwright-core` `1.63.0`，保留 [Apache-2.0 许可证](https://registry.npmjs.org/playwright-core/-/playwright-core-1.63.0.tgz)与 [NOTICE](https://registry.npmjs.org/playwright-core/-/playwright-core-1.63.0.tgz)。来源为 [Playwright v1.63.0](https://github.com/microsoft/playwright/tree/v1.63.0)。浏览器二进制单独安装，未加入 CLI/App 安装包；实际浏览器分发许可与安装验收单独核对。

Browser Use uses `playwright-core` `1.63.0` with its [Apache-2.0 license](https://registry.npmjs.org/playwright-core/-/playwright-core-1.63.0.tgz) and [NOTICE](https://registry.npmjs.org/playwright-core/-/playwright-core-1.63.0.tgz), from [Playwright v1.63.0](https://github.com/microsoft/playwright/tree/v1.63.0). Browser binaries are installed separately and are absent from the CLI/App archive; their distribution licenses and installation checks are independent.

Pi 的 `@earendil-works/pi-agent-core`、`pi-ai`、`pi-coding-agent`、`pi-tui`、`pi-telemetry` 与 `chord` 随当前 CLI/App 以 `0.87.1` 分发。两种包均携带[该版本上游完整 MIT 许可证及 Mario Zechner 版权声明](https://github.com/earendil-works/pi/blob/v0.87.1/LICENSE)，来源为 [Pi v0.87.1 的 LICENSE](https://github.com/earendil-works/pi/blob/v0.87.1/LICENSE)。

The CLI/App distributes Pi's `@earendil-works/pi-agent-core`, `pi-ai`, `pi-coding-agent`, `pi-tui`, `pi-telemetry`, and `chord` at `0.87.1`. Both packages carry the [complete upstream MIT license and Mario Zechner copyright notice](https://github.com/earendil-works/pi/blob/v0.87.1/LICENSE), from [Pi v0.87.1's LICENSE](https://github.com/earendil-works/pi/blob/v0.87.1/LICENSE).

CLI 的交互界面通过 Pi 公开的 `PI_PACKAGE_DIR`、`piConfig.name` 与扩展 UI API 显示 CoworkOS 品牌。适配器在 CLI 数据目录生成独立运行时元数据，保留 Pi 原始代码、资源、文档、版权及许可证；不会修改安装依赖。实现见 [CLI 品牌适配器](scripts/cli-branding.mjs)。

The interactive CLI uses Pi's public `PI_PACKAGE_DIR`, `piConfig.name`, and extension UI APIs to display the CoworkOS brand. The adapter creates separate runtime metadata in the CLI data directory and preserves Pi's original code, assets, documentation, copyright and license without modifying installed dependencies. See the [CLI branding adapter](scripts/cli-branding.mjs).

CLI/App 同时保留 `data-uri-to-buffer` `4.0.1` 的 [MIT 许可及 Nathan Rajlich 版权全文](https://registry.npmjs.org/data-uri-to-buffer/-/data-uri-to-buffer-4.0.1.tgz)，以及 `isarray` `1.0.0` 的 [MIT 许可及 Julian Gruber 版权全文](https://registry.npmjs.org/isarray/-/isarray-1.0.0.tgz)。两份原文从锁定 npm 发行的 README 许可章节提取，避免 App 打包排除 README 时丢失许可和版权。

The CLI/App also preserves the complete [MIT license and Nathan Rajlich copyright notice for data-uri-to-buffer 4.0.1](https://registry.npmjs.org/data-uri-to-buffer/-/data-uri-to-buffer-4.0.1.tgz), and the [MIT license and Julian Gruber copyright notice for isarray 1.0.0](https://registry.npmjs.org/isarray/-/isarray-1.0.0.tgz). Both texts are copied verbatim from the locked npm distributions' README license sections so that App packaging retains them when README files are excluded.

Node 依赖版本由根 `package-lock.json` 和 `vendor/pptist/package-lock.json` 锁定。CLI 包保留生产依赖的声明和许可证，并携带可发布的 `npm-shrinkwrap.json`；esbuild 的原生运行组件以测试过的精确版本在安装时获取。当前文档不是完整的传递依赖版权清单。公开发布前，发布负责人须对最终 CLI/App 分发物生成并核对完整第三方清单，保留所需许可证文件。

Node dependencies are pinned by the root and PPTist lockfiles. The CLI bundles production dependency manifests and licenses and carries a publishable `npm-shrinkwrap.json`. The native esbuild runtime is fetched at installation using the exact tested version. This document is not a complete inventory of transitive copyright notices. Before public distribution, the release owner must generate and review notices for the actual CLI/App artifacts and retain required license files.

## CoworkOS terminal UI compatibility adapter

CoworkOS 使用原始 Pi coding agent 0.87.1，在交互子进程加载时应用六处受限 UI 差异；各 CLI 模式另有三处命令身份/输出路径差异，使新命令的 `AI_AGENT=atria`、完整输出文件为 `atria-bash-*.log`。不改写依赖文件、许可、历史内容、恢复格式或 RPC 协议结构；模型/工具记录仍保存实际内容与真实输出路径。具体来源、固定 hash、差异和升级门槛见 [终端适配说明](docs/cli-ui-adapter.md)。

CoworkOS uses the original Pi coding agent 0.87.1 with six bounded UI differences applied at load time in the interactive subprocess and three shell identity/output-path differences across CLI modes. New commands use `AI_AGENT=atria` and `atria-bash-*.log` for full output. Dependency files, licenses, historical content, recovery formats and RPC protocol structure remain intact; model/tool records retain actual content and real output paths. Source, pinned hashes, differences and upgrade gates are documented in the [terminal adapter guide](docs/en/cli-ui-adapter.md).

## React Bits README hero / README 动画头图

当前头图的 TechText 是独立实现的 React/SVG 场景，不导入下述旧版 ElectricLogo；旧源码与许可继续保留。The current TechText hero is an independent React/SVG implementation and does not import the legacy ElectricLogo below; its sources and licenses remain preserved.

旧版 README 头图场景使用 [React Bits](https://github.com/DavidHDev/react-bits) 的 ElectricLogo，固定于 `e12c22192ac7b4b452c5e2feb9b586d74765d696`。原始源码、文件来源与 Git blob SHA 见 [SOURCES.md](docs/hero/react-bits/SOURCES.md)，完整 **MIT + Commons Clause License Condition v1.0** 及 copyright (c) 2026 David Haz 版权声明保留在 [LICENSE.md](docs/hero/react-bits/LICENSE.md)。此组件属于 CoworkOS MIT 授权的第三方例外，仅用于[独立文档动画场景](docs/hero/README.md)及其导出头图，不接入产品运行时，也不增加产品运行时依赖。

The previous README hero scene used ElectricLogo from [React Bits](https://github.com/DavidHDev/react-bits), pinned to `e12c22192ac7b4b452c5e2feb9b586d74765d696`. Original sources, origins and Git blob SHAs are recorded in [SOURCES.md](docs/hero/react-bits/SOURCES.md). The complete **MIT + Commons Clause License Condition v1.0** and copyright (c) 2026 David Haz notice are retained in [LICENSE.md](docs/hero/react-bits/LICENSE.md). This component is a third-party exception to CoworkOS's MIT grant. It is used only by the [standalone documentation scene](docs/hero/README.md) and its exported hero, and adds no product runtime integration or dependencies.

此独立场景的 WebGL 依赖为 [OGL 1.0.11](https://www.npmjs.com/package/ogl/v/1.0.11)，由 [docs/hero/package-lock.json](docs/hero/package-lock.json) 锁定，适用 **Unlicense**。完整条款从该 npm 发行的 README 原样保留为 [OGL-UNLICENSE.txt](docs/hero/react-bits/OGL-UNLICENSE.txt)；上游源码及许可见 [OGL b9e653cc](https://github.com/oframe/ogl/tree/b9e653ccac8e08211ce0678695d0a01f722e1fc2) 与其 [README 许可章节](https://github.com/oframe/ogl/blob/b9e653ccac8e08211ce0678695d0a01f722e1fc2/README.md#unlicense)。

The standalone scene's WebGL dependency is [OGL 1.0.11](https://www.npmjs.com/package/ogl/v/1.0.11), pinned by [docs/hero/package-lock.json](docs/hero/package-lock.json), under the **Unlicense**. Its full terms are copied verbatim from that npm release's README to [OGL-UNLICENSE.txt](docs/hero/react-bits/OGL-UNLICENSE.txt). Source and license: [OGL b9e653cc](https://github.com/oframe/ogl/tree/b9e653ccac8e08211ce0678695d0a01f722e1fc2) and its [README license section](https://github.com/oframe/ogl/blob/b9e653ccac8e08211ce0678695d0a01f722e1fc2/README.md#unlicense).

## Markdown document preview

Web/App 文档预览使用 Marked 18.1.1（MIT）和 DOMPurify 3.4.17（Apache-2.0 OR MPL-2.0）。构建将浏览器依赖打包到本地静态资源，并复制上游许可证；不依赖 CDN。完整许可见 [Marked](https://registry.npmjs.org/marked/-/marked-18.1.1.tgz) 与 [DOMPurify](https://registry.npmjs.org/dompurify/-/dompurify-3.4.17.tgz)。

Web/App document previews bundle Marked 18.1.1 (MIT) and DOMPurify 3.4.17 (Apache-2.0 OR MPL-2.0) as local browser assets, with their upstream licenses and no CDN dependency.
