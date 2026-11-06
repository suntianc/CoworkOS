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

## SciAgentGYM scientific tools

科学计算函数改编自 [CMarsRover/SciAgentGYM e9dbbea4369d67694e38bf8be67bedbcaf9e9300](https://github.com/CMarsRover/SciAgentGYM/tree/e9dbbea4369d67694e38bf8be67bedbcaf9e9300)，适用 Apache-2.0。CLI/App 保留上游完整 [LICENSE](vendor/sciagentgym/LICENSE) 和 CoworkOS 的来源与修改 [NOTICE](vendor/sciagentgym/NOTICE)。v1 保留原 12 个离线函数，v2 加入 6 个实验数据分析、衍射与电化学函数，v3 再加入 8 个离线天文函数，共 26 个；旧目录保持各自范围。改编移除了绘图、文件副作用和全量依赖导入，并新增参数验证、稳定数值计算和 JSON 输出。天文函数仅用标准库；数组分析使用用户单独配置的可选 NumPy/SciPy 环境。范围见 [科学工具](docs/scientific-tools.md)。

The scientific tools adapt offline functions from the pinned SciAgentGYM commit under Apache-2.0. CLI/App retain the complete upstream license and the linked provenance/modification notice. The v1 catalog retains its original 12 functions; v2 adds six experimental-data, diffraction and electrochemistry functions, and v3 adds eight offline astronomy functions for a total of 26. Older catalogs retain their own scope. Adaptations remove plotting, file side effects and eager full dependencies and add validation, stable arithmetic and JSON output. Astronomy uses only the standard library; array analysis uses a separately configured optional NumPy/SciPy environment. See the [guide](docs/en/scientific-tools.md).

v4 另加 3 个 CoworkOS 原生 RDKit 包装函数，总计 29 个，来源类型为 `atria-native`；它们未复制 SciAgentGYM 或 RDKit 源码。原生包装使用仓库 MIT 许可，用户手动配置的外部 RDKit `2026.9.1` 依赖适用其 [BSD-3-Clause 许可证](https://github.com/rdkit/rdkit/blob/Release_2026_09_1/license.txt)。CLI/App 不随包分发 RDKit 二进制或该独立 Python 环境；NumPy、Pillow 等外部环境依赖保留各自许可。

The v4 catalog adds three CoworkOS-native RDKit wrappers for 29 functions in total, with `atria-native` provenance and no copied SciAgentGYM or RDKit source. Native wrappers use the repository's MIT license; the manually configured external RDKit `2026.9.1` dependency retains its linked BSD-3-Clause license. CLI/App do not bundle RDKit binaries or this separate Python environment. External NumPy, Pillow and other environment dependencies retain their own licenses.

v5 在上述范围上加入 4 个 SciAgentGYM 材料函数改编，共 33 个工具，其中 30 个为 Apache-2.0 上游改编、3 个为 CoworkOS 原生 RDKit 包装。材料函数只用标准库；来源、文件哈希及 Gaussian 仪器展宽修正见同一 [NOTICE](vendor/sciagentgym/NOTICE)。v1–v4 保留各自目录与实现。

The v5 catalog adds four SciAgentGYM materials adaptations, for 33 tools: 30 Apache-2.0 upstream adaptations and three CoworkOS-native RDKit wrappers. Materials require only the standard library. The same notice records source hashes and the explicit Gaussian instrumental-broadening correction. The v1–v4 catalogs and implementations are preserved.

v6 增加 3 个 SciAgentGYM 质谱工具改编和 1 个 CoworkOS 原生精确质量/分子式包装，总计 37 个（33 个上游改编、4 个原生包装）。前者仅用标准库；后者复用用户选择的既有 RDKit 环境，代码为 MIT、来源为 `atria-native`，不计入上游改编。两个上游文件的固定哈希与归一化、Cl/C 卷积及候选峰匹配改动见 [NOTICE](vendor/sciagentgym/NOTICE)。旧 v1–v5 保持原范围；无新增库或 RDKit 二进制随包分发。

The v6 catalog adds three SciAgentGYM mass-spectrum adaptations and one CoworkOS-native exact-mass/formula wrapper, for 37 tools: 33 upstream adaptations and four native wrappers. The former use only the standard library; the latter reuses the selected external RDKit environment under its existing license. Native code is MIT with `atria-native` provenance, separate from the upstream adaptations. The notice records both source hashes and normalization, Cl/C convolution and candidate-matching changes. The v1–v5 catalogs retain their scope; no additional library or RDKit binary is bundled.

v7 增加 3 个 CoworkOS 原生统计函数，总计 40 个（33 个上游改编、7 个原生实现）。统计代码使用仓库 MIT 许可，通过公开 NumPy/SciPy API 计算，未复制这些库或 SciAgentGYM 源码；来源为 `atria-native`。复用外部 NumPy 2.2.6 / SciPy 1.15.3 环境，依赖仍保留各自许可。显式安装器从 PyPI 安装固定 wheel 及其许可文件到独立用户环境；CLI/App 不随包分发科学 Python 或这些库的二进制，旧 v1–v6 保留原实现。

The v7 catalog adds three MIT-licensed CoworkOS-native statistics functions, for 40 tools: 33 upstream adaptations and seven native implementations. They call public NumPy/SciPy APIs without copying those libraries or SciAgentGYM source, with `atria-native` provenance. They reuse external NumPy 2.2.6 / SciPy 1.15.3 under their own licenses. The explicit installer obtains fixed wheels and their license files from PyPI into a separate user environment; CLI/App do not bundle scientific Python or those library binaries. Existing v1–v6 implementations are preserved.

## React Bits README hero / README 动画头图

当前头图的 TechText 是独立实现的 React/SVG 场景，不导入下述旧版 ElectricLogo；旧源码与许可继续保留。The current TechText hero is an independent React/SVG implementation and does not import the legacy ElectricLogo below; its sources and licenses remain preserved.

旧版 README 头图场景使用 [React Bits](https://github.com/DavidHDev/react-bits) 的 ElectricLogo，固定于 `e12c22192ac7b4b452c5e2feb9b586d74765d696`。原始源码、文件来源与 Git blob SHA 见 [SOURCES.md](docs/hero/react-bits/SOURCES.md)，完整 **MIT + Commons Clause License Condition v1.0** 及 copyright (c) 2026 David Haz 版权声明保留在 [LICENSE.md](docs/hero/react-bits/LICENSE.md)。此组件属于 CoworkOS MIT 授权的第三方例外，仅用于[独立文档动画场景](docs/hero/README.md)及其导出头图，不接入产品运行时，也不增加产品运行时依赖。

The previous README hero scene used ElectricLogo from [React Bits](https://github.com/DavidHDev/react-bits), pinned to `e12c22192ac7b4b452c5e2feb9b586d74765d696`. Original sources, origins and Git blob SHAs are recorded in [SOURCES.md](docs/hero/react-bits/SOURCES.md). The complete **MIT + Commons Clause License Condition v1.0** and copyright (c) 2026 David Haz notice are retained in [LICENSE.md](docs/hero/react-bits/LICENSE.md). This component is a third-party exception to CoworkOS's MIT grant. It is used only by the [standalone documentation scene](docs/hero/README.md) and its exported hero, and adds no product runtime integration or dependencies.

此独立场景的 WebGL 依赖为 [OGL 1.0.11](https://www.npmjs.com/package/ogl/v/1.0.11)，由 [docs/hero/package-lock.json](docs/hero/package-lock.json) 锁定，适用 **Unlicense**。完整条款从该 npm 发行的 README 原样保留为 [OGL-UNLICENSE.txt](docs/hero/react-bits/OGL-UNLICENSE.txt)；上游源码及许可见 [OGL b9e653cc](https://github.com/oframe/ogl/tree/b9e653ccac8e08211ce0678695d0a01f722e1fc2) 与其 [README 许可章节](https://github.com/oframe/ogl/blob/b9e653ccac8e08211ce0678695d0a01f722e1fc2/README.md#unlicense)。

The standalone scene's WebGL dependency is [OGL 1.0.11](https://www.npmjs.com/package/ogl/v/1.0.11), pinned by [docs/hero/package-lock.json](docs/hero/package-lock.json), under the **Unlicense**. Its full terms are copied verbatim from that npm release's README to [OGL-UNLICENSE.txt](docs/hero/react-bits/OGL-UNLICENSE.txt). Source and license: [OGL b9e653cc](https://github.com/oframe/ogl/tree/b9e653ccac8e08211ce0678695d0a01f722e1fc2) and its [README license section](https://github.com/oframe/ogl/blob/b9e653ccac8e08211ce0678695d0a01f722e1fc2/README.md#unlicense).

## Markdown document preview

Web/App 文档预览使用 Marked 18.1.1（MIT）和 DOMPurify 3.4.17（Apache-2.0 OR MPL-2.0）。构建将浏览器依赖打包到本地静态资源，并复制上游许可证；不依赖 CDN。完整许可见 [Marked](https://registry.npmjs.org/marked/-/marked-18.1.1.tgz) 与 [DOMPurify](https://registry.npmjs.org/dompurify/-/dompurify-3.4.17.tgz)。

Web/App document previews bundle Marked 18.1.1 (MIT) and DOMPurify 3.4.17 (Apache-2.0 OR MPL-2.0) as local browser assets, with their upstream licenses and no CDN dependency.
