# Mac 构建、发布与验收

[English](en/mac-release.md) | 中文

当前 App 目标是 macOS 14+、Apple Silicon（arm64）Mac。Electron 自带运行时，用户无需 Node、npm 或仓库源码。当前未提供 Developer ID 签名、公证或 Intel 构建；更新安装方式取决于包签名与已发布更新源。候选包与 Release 说明必须明确这些限制。用户安装与配置见 [安装指南](getting-started.md) 和 [配置指南](configuration.md)。

## 构建候选包

在支持的 Mac 构建机上准备 Node 和 npm，构建离线完整包时另需 uv。使用根锁文件安装依赖：

```sh
npm ci
npm run verify:full
npx playwright install chromium
npm run test:browser
npm run desktop:pack
npm run test:desktop
npm run desktop:dist
# 如需验收内部基础包，单独制作；不替代默认小包的验收。
npm run test:desktop
```

`desktop:pack` 生成 `.tmp/release/mac-arm64/CoworkOS.app`；`desktop:dist` 使用系统 hdiutil 创建、校验 `release/CoworkOS-<version>-mac-arm64.dmg` 并写入 SHA-256。没有 Developer ID 证书时使用 ad-hoc 签名并严格验证 App，仅生成 DMG；签名条件满足后才生成更新 ZIP/feed。以脚本实际输出为准；本地构建不会上传或发布。构建 App 放在隐藏的 `.tmp` 下，避免成为 Spotlight/Launchpad 中重复的安装项。

`npm run test:desktop` 验证宿主、TXT 新建编辑保存、Pi 与本地模型、草稿、退出/恢复及搬移升级。组件安装与领域编辑器已移除。

Pi 扩展与子进程使用真实文件路径，打包关闭 asar。白名单排除测试、私有配置、工作空间、浏览器产出和开发依赖；发布者仍需审查最终包内容、权限与校验值。不能仅依赖 `.gitignore` 排除密钥。

## 版本 tag 与 Release 草稿

默认流程在本地 Apple Silicon Mac 构建，避免每次版本发布消耗 macOS Actions 分钟。先准备 Node 24、uv、`gh` 登录和依赖，再从干净的版本 tag 检出运行：

```sh
npm ci
npm run release:local -- v0.1.3
```

完整本地回归应在建立 tag 前完成。该命令校验 tag、版本和干净工作区，构建 DMG、CLI 与两个 npm 包，生成发行清单和校验文件，并上传 GitHub Release 草稿及 npm 包候选。它会停在可审查的草稿，不会发布 npm 或公开 Release。检查草稿资产后，在 Actions 手动运行 Publish npm packages 并输入同一 tag；npm Environment 的 Required reviewers 仍会照常生效。npm 验证通过后，再手动发布 GitHub Release。tag 推送本身不会触发云端 Mac 重建。默认测试版使用 ad-hoc 签名、未公证；预发布版本自动标记 Pre-release。

[Release Mac 工作流](../.github/workflows/release-mac.yml)保留为手动云端备用流程。它从选定 tag 在 macOS 15 arm64 上重新构建候选，适合本地构建机不可用时使用；手动运行会消耗 macOS Actions 分钟。

以下以 `0.1.2-beta.7` 为例，维护者先审查并提交全部发布所需源码、文档与验证，再建立 tag：

```sh
npm version 0.1.2-beta.7 --no-git-tag-version
# 同时暂存本次发布需要的其他源码和文档。
git add package.json package-lock.json
git diff --cached --stat
git commit -m "Release 0.1.2-beta.7"
git tag v0.1.2-beta.7
git push origin HEAD
git push origin v0.1.2-beta.7
```

`GITHUB_TOKEN` 由 Actions 提供，工作流需要 `contents: write`，不在仓库存放个人 token。检查 Release Mac DMG 的实际日志，然后在 Releases 核对草稿版本、tag、DMG/CLI、校验文件、说明与安装结果；签名发行另核对 ZIP/feed。

维护者审阅后手动点击 Publish release；ad-hoc 测试包应在说明中标明无 Developer ID/公证的限制，并按发布策略选择 Pre-release。

手动 Run workflow 可输入已有 `vX.Y.Z` tag。已有草稿可补跑并替换附件；已发布同版本的附件不可覆盖，修复需新版本 tag。不要移动 tag 绕过校验。

仅需内部候选时使用 [Internal Mac package](../.github/workflows/internal-mac.yml)，它上传 Actions 产物而不创建 Release。

主分支保存最新通过评审的集成代码，用户版本以 tag/Release 为准；反馈与发行清单命令见 [版本管理](beta-release-process.md)。版本守卫见 [release-metadata](../scripts/release-metadata.mjs)，本地回归为 `test/release-metadata.test.js`。

## 应用内更新与发布产物

“设置 → 更新”供开发 App 和已安装 App 检查与执行更新。启动时只检查一次；下载/应用需要用户主动点击，运行中的任务与未保存草稿先按桌面宿主门槛处理。源码开发 App 跟随 Git upstream，独立准备完整构建并重启；脏检出/分叉会拒绝，详见 [源码更新](development.md#更新源码检出)。

新构建的安装版从 npm registry 查询 `coworkos-desktop-darwin-arm64` 的 `latest` 或 `beta` dist-tag，下载对应 tarball，并依次校验 registry SRI、包内文件清单和 DMG SHA-256。App 版本、平台包版本和 DMG 清单版本必须一致；版本比较禁止降级。CLI 的首次安装命令也读取同一个平台包，因此桌面安装、应用内更新和 CLI 更新都使用 npm registry。

旧 App 的 GitHub 更新地址固化在旧二进制中，发布 npm 包不会改变它。保留旧 GitHub 更新发布流程用于尚能访问该来源的历史 App；无法使用旧来源的用户需按 [安装指南](getting-started.md) 一次性迁移。不要将这次迁移描述为自动升级。

用户点击“下载更新”后仍可编辑；完成后按钮变为“重启并安装”。当前 ad-hoc 包在用户可写安装目录中使用受管替换：校验 DMG/候选 App、同父目录准备候选、保存草稿并等待任务结束、退出后原子替换、保留旧 App 备份并重新启动。失败时保留或恢复旧版；不可写目录提示使用系统安装方式，不自动提权或删除隔离属性。Developer ID 包仍可沿用原生 ZIP 更新，签名与公证验收单独记录。

| 产物                                                     | 用途                                                       |
| -------------------------------------------------------- | ---------------------------------------------------------- |
| `coworkos-cli-<version>.tgz` 与 `.sha256`                | CLI 在原全局 prefix 内准备、校验启动后替换程序包           |
| `CoworkOS-<version>-mac-arm64.dmg` 与 `.sha256`          | App 下载校验、准备同父候选并在退出后安装；也供首次手动安装 |
| `CoworkOS-<version>-mac-arm64.signing.json` 与 `.sha256` | 精确记录候选 App 的签名状态                                |
| `atria-release-<version>.json` 与 `.sha256`              | 原始私有源码仓库/tag/commit 与发行产物来源记录             |

下一版 npm 安装器和 App 更新包由 [Publish npm packages 工作流](../.github/workflows/publish-npm.yml)发布。它在 Ubuntu runner 校验 tag 和草稿，从草稿下载本地构建的两个 npm 包并核对 SHA-256、包名和版本，然后依次发布桌面包与 CLI 包，再用匿名 `npm view` 验证。不会在 Actions 上安装项目依赖或重建 Mac App。平台 tgz 只包含对应 DMG、许可和版本/校验清单；CLI tgz 包含安装器代码。两个包使用 npm 官方 registry，用户仍可直接运行 `npx coworkos-app@latest` 或 `npm install -g coworkos-app`。

首次启用前，在 npm 的两个包设置中分别配置 Trusted Publisher：仓库填写 `RUC-NLPIR/CoworkOS`，工作流填写 `publish-npm.yml`，Environment 填写 `npm-publish`。GitHub Actions 使用 OIDC，不把 npm token 放进仓库。可在 GitHub 的 `npm-publish` Environment 设置 Required reviewers，发布前由维护者批准；npm 版本一旦发布不可覆盖。

发布顺序为：先完成本地回归，再推送与 `package.json` 完全一致的 `vX.Y.Z` tag；在该 tag 的干净检出运行 `npm ci` 和 `npm run release:local -- vX.Y.Z`。审查草稿中的 Mac、CLI 及 npm 候选资产，然后手动运行 Publish npm packages。保留 npm Trusted Publishing Environment 的 Required reviewers；核对 npm 发布成功后，再手动发布 GitHub Release。公开分发 Release 与更新指针若本版本需要，也按下文步骤单独验收和发布。版本一旦发布不可覆盖；下一个公开版本须递增。

npm 接收上传后可能仍需处理，匿名查询会暂时返回 404。发布 workflow 会重试查询并核对两个包的 SHA-512 与候选一致；若处理仍未完成，从 `main` 运行同一 workflow，填相同 tag 并勾选 `verify_only`，只验证已接收的包，不再次发布。`verify_only` 可读取草稿或已公开 Release 的固定附件，继续核对 tag 提交、候选包校验值和 npm SHA-512；普通发布仍要求草稿。历史失败运行的红叉会保留，应查看后续验证运行的结果。

本地也可分别生成 npm 候选包进行验收：

```sh
VERSION=0.1.3
ATRIA_DESKTOP_NPM_PACKAGE_DIR="$PWD/.tmp/npm-release" npm run desktop:npm:pack
ATRIA_PACKAGE_DIR="$PWD/.tmp/npm-release" npm run npm:pack
```

两个包均不可覆盖已发布版本。`latest` / `beta` tag 由包的 `publishConfig` 选择。平台包发布后、CLI 发布前，应先通过真实 npm 下载路径验收 installer 和 App 更新 provider。若当前版本属于旧 GitHub 更新客户端，还需按旧发布流程构建兼容迁移版本；新 npm 发布本身不会改写旧 App 的下载地址。

GitHub DMG/CLI Release 与静态更新指针只保留给旧客户端兼容和明确的手动归档分发。对已审核的干净 tag，仍可执行 `node scripts/release-artifacts.mjs` 生成来源清单，再运行 `npm run release:publish:public`；发布器通过旧内容 SHA 比较更新 `updates/coworkos-latest.json`，不可覆盖已发布附件或回退指针。

已发布附件与 tag 不覆盖；更新指针失败时保留已发布的固定版本，处理并发或网络原因后，以 `npm run release:publish:public -- --resume-pointer` 只核对既有附件并恢复指针更新。

维护者本机使用已有 `gh` 授权；跨仓库 Actions 需单独配置只写分发仓库的发布授权，不能将 token 放进 App。

公开仓库 Git 分支只存下载说明和更新清单；不推送开发检出、用户配置、任务、临时日志或私有测试证据。默认 ad-hoc 发行仅上传上述八个文件。Developer ID ZIP/feed 的跨仓库发布需显式扩展白名单并重新验收，当前公开发布器拒绝不支持的组合，不能丢弃签名产物后冒充完整签名发行。

构建机安装维护者自己的 Developer ID Application 证书后，通过 `CSC_NAME` 显式选择证书名称或团队 ID；名称不含 `Developer ID Application:` 前缀，符合 [electron-builder 签名规则](https://www.electron.build/v26/docs/features/code-signing/code-signing-mac/)。设置后强制签名；签名失败、ad-hoc 或开发证书都不能生成更新 ZIP。未设置时关闭自动寻找签名身份，并移除本次版本残留的 ZIP/feed，保留 DMG 构建。

GitHub 工作流可选读取仓库变量 `CSC_NAME`、仓库 secrets `CSC_LINK` 与 `CSC_KEY_PASSWORD`；未配置时仍为未签名 DMG。证书、私钥与公证凭据不进仓库；当前未完成公证配置与生产安装验收。

签名验证通过后，脚本才对 App 使用 ditto 生成并检查 ZIP，根据实际 ZIP 写入 SHA-256 和 [Squirrel.Mac 静态 JSON feed](https://github.com/Squirrel/Squirrel.Mac#update-file-json-format)。feed 的 URL 使用 `ATRIA_UPDATE_REPOSITORY`、`GITHUB_REPOSITORY` 或包 repository 指定的 GitHub 仓库，并绑定 `v<version>` 资产；版本与 lock/tag 必须一致。

生成签名 ZIP/feed仍需完成公证、Gatekeeper 与真实旧版→新版安装验收；当前默认 ad-hoc 测试包使用经校验的 DMG 受管安装流程。草稿审查后由维护者手动 Publish；更新功能不自动推送 tag 或发布 Release。

CLI/DMG 下载通过发行 helper 验证版本、资产来源、大小及 SHA-256；签名 ZIP 由 Electron 原生更新机制下载并核验签名。失败时报告原因并保留用户数据；不可把下载完成等同于安装完成。Web renderer 只传检查/执行动作，真实路径、URL、命令与保存/退出决策由可信宿主管理。

实现见 [桌面更新](../desktop/updates.cjs)、[npm 桌面包下载](../scripts/update-npm-desktop.mjs)、[旧版发行下载](../scripts/update-release.mjs)、[feed 生成与签名守卫](../scripts/update-feed.mjs)，对应回归见 `test/desktop-updates.test.js`、`test/update-npm-desktop.test.js`、`test/package-desktop-npm.test.js`、`test/update-release.test.js`、`test/update-feed.test.js`、`e2e/desktop-updates.spec.js`；最终签名更新另验。

## 安装、数据与升级

用户从 DMG 拖入 Applications 并启动，按安装指南配置自己的模型连接。模型密钥由 Electron safeStorage 加密保存，renderer 不读回密钥，加密不可用时拒绝保存。未配置模型也可编辑和保存支持的本地文档。

用户数据默认位于与 CLI / Web 共用的 `~/.atria/`，包含工作空间、Pi 状态、连接、加密密钥和日志；`ATRIA_HOME` 整体覆盖，外部项目与显式覆盖目录按实际原文件一起备份。默认布局与旧桌面目录复制/导入见 [持久化说明](task-workspace-layout.md)。

安装目录只放程序，替换 App 不删除用户数据。开发版与正式版默认共享单实例锁。格式不兼容时拒绝打开，迁移需备份与回滚验收。

两个桌面入口显示 CoworkOS / CoworkOS Dev；macOS 钥匙串工作进程继续使用 `Atria` 加密身份以兼容已有凭据。Electron 41 的 macOS 加密服务名由应用名派生（[固定版本实现](https://github.com/electron/electron/blob/v41.10.7/shell/browser/electron_browser_main_parts.cc#L476-L517)）。旧 Atria Dev 密文可能不能被新身份解密，迁移保留密文与源目录、允许重新输入密钥；真实钥匙串、签名变更与旧版本升级仍需原生验收。

Mac 钥匙串重试进程沿用主 Electron 可执行文件，保留完整 Chromium 运行环境与 `Atria` 加密身份。保存密钥时可能短暂出现第二个 Dock 图标，属于当前 beta 的已知限制；打包验收仅豁免通过精确 PID 识别的钥匙串进程，其他后台进程仍不得注册为普通 App。

原生回归检查既有密文互读、同一进程延迟读取和保存后的页面刷新；测试钥匙串结果不替代真实系统授权验收。

应用内或手动升级前备份重要数据；受管 DMG 安装保存后退出并替换 App，不可写目录使用系统安装方式。重启后确认会话、文件、配置及任务恢复。Command-Q 等待保存与进程清理，失败或冲突由用户处理；窗口关闭在 macOS 上不等于退出。中断、未确认提交和完整输入草稿按当前协议恢复，不能以删除数据作为故障处理方式。

无 Developer ID 签名或未公证的包可能被 Gatekeeper 阻止，测试者使用系统提供的打开/批准流程；不提供关闭系统保护的脚本。公开稳定版须完成 Developer ID 签名、公证、staple 与下载隔离属性验收，签名凭据不进仓库。

## 原生资源与权限

App 与开发运行时不包含语音识别 helper、麦克风或语音识别声明和音频输入 entitlement。打包会排除旧构建残留的语音 helper；签名校验检查实际 entitlement 和 Info.plist。Electron 自带的系统音频捕获描述保持原样，屏幕录制和辅助功能由 Computer Use 独立使用。验证最终 App 的资源、签名与运行行为，并绑定 App hash。

## 发布验收

按 [本地测试指南](testing-local-run.md) 保存当前版本的独立结果，并审查 skip 与待人工项：

| 范围       | 必须核对                                                                                           |
| ---------- | -------------------------------------------------------------------------------------------------- |
| 源码与协议 | 构建、静态/类型/格式、文档与源码卫生门槛、Node 回归、浏览器回归                                    |
| 候选 App   | `npm run test:desktop` 按包元数据验证宿主、文档、退出/重启和搬移升级；覆盖文本工作台与保留的运行时 |
| 原生能力   | Computer Use 按系统权限单独验收，分别记录实际运行或 skip                                           |
| 最终 DMG   | 校验 SHA-256，在无开发环境的另一台 Mac 安装；验证首次启动、模型连接、失败恢复、数据备份和升级      |
| 实际模型   | 显式配置自己的 endpoint 与预算，验证请求和代表性任务；本地协议夹具不证明模型质量                   |
| 分发       | 核对版本/tag/产物、公开静态更新源与单一当前版本、支持平台、签名/公证、已知限制及许可证             |

`scripts/desktop-smoke.mjs` 使用临时用户目录和本地模型协议服务，不使用真实凭据。源码或打包测试通过不能替代最终 DMG、干净机器、真实模型与人工体验验收。记录系统、芯片、版本、包校验值和当前结果，不复用历史通过计数。

## 许可证与 CLI 候选

自有代码使用 [MIT](../LICENSE)，第三方保留各自许可证，见 [第三方声明](../THIRD_PARTY_NOTICES.md)。CLI/App 白名单包含这些文件。发布时检查最终包的版权和实际对应源码，MIT 标识不替代第三方义务。

CLI 可使用隔离输出目录：

```sh
ATRIA_PACKAGE_DIR="$PWD/.tmp/cli-candidate" npm run cli:pack
```

默认输出为 `release/`。CLI 包携带锁定的可移植生产依赖、许可证及生产 `npm-shrinkwrap.json`。esbuild 恢复校验过的精确版本原始 JavaScript 安装器，安装时获取适合用户系统的精确版本二进制并验证 SHA-256；不复制构建机的原生二进制。因此安装需要网络和安装脚本，不支持 `--ignore-scripts`。流程修改需运行 `test/cli-packaging.test.js`，再隔离安装真实候选，核对 CLI、Pi 扩展和依赖版本。
