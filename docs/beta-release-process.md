# CoworkOS 测试版与版本管理

CoworkOS 源码在公开的 [RUC-NLPIR/CoworkOS](https://github.com/RUC-NLPIR/CoworkOS) 仓库维护；版本以固定 tag 和已发布 Release 为准。用户实际安装的版本以已发布包为准，main 上的最新提交不一定已发版。

## 开发与反馈

功能使用 feat/xxx，修复使用 fix/123-xxx；从 main 分出，通过 PR 回 main，合并后删除临时分支。只有需要并行冻结候选时才建立临时 release/版本号，不设置长期 develop 或 pre-alpha。主分支不得强推或删除；每个修复由另一位维护者 review。仓库已启用 PR 合并后自动删除临时分支和不可变 Release。审阅保护与成员权限须按实际仓库设置核对，分支命名本身不提供权限隔离。

每个独立问题对应一个同仓库 issue，填写版本、平台和芯片、安装方式、复现步骤、预期与实际结果、脱敏错误。重复反馈关联原问题；飞书话题关联 issue 并补充讨论。使用 bug、enhancement、needs-triage 分诊，issue 保留负责人、修复 PR 和预计版本。

PR 标题写具体修复，例如 `修复草稿恢复失败（关联反馈 #123）`；正文用 `Refs #123`，记录验证和影响范围。合并只表示源码已修复，暂不使用 Closes/Fixes 自动关闭关键词。状态依次为待确认、修复中、已合并待发版、已发布待验证、验证后关闭；只关闭本版包含且确认解决的反馈。飞书自动分配和通知后续接入，第一阶段由维护者分诊和同步状态。

修复 PR 合入后，给关联 issue 添加 `修复pr已合入` 标签并关联 PR，方便跟踪待发版或验证的问题。发行包验证完成后，再按前述条件关闭反馈。

## 固定版本与来源

每 3 至 5 个工作日发布测试版，启动失败、数据损坏等阻断问题走紧急补丁。测试版使用递增版本，例如 0.1.2-beta.11、0.1.2-beta.12，Release 标记 Pre-release；App 从单一公开清单读取维护者指定的当前版本，不提供通道选择。已安装的 0.1.1 不能通过较低的 0.1.1-beta.1 升级。

发布提交同步 package.json、package-lock.json 及根 lock package 的版本，完成验证并合入 main，再为准确的提交建立匹配的 v<version> tag。从干净 tag 构建；tag、来源 SHA 和产物清单必须一致。发布后不移动 tag 或替换同版附件，修复使用新版本。DMG 不存入 Git 分支。

```sh
npm version 0.1.2-beta.7 --no-git-tag-version
# 审查并提交本版所有源码、文档与版本修改，然后验证该提交。
git tag v0.1.2-beta.7
git push origin main
git push origin v0.1.2-beta.7
```

GitHub 日常静态检查仍只手动触发；为准确的 PR SHA 运行 check:ci，完整回归和安装验收在本地记录。不要设置从未触发的 required checks。公开仓库可使用免费保护分支；私有仓库的可用规则取决于 GitHub 套餐。当前配置与命令见 [开发指南](development.md#github-actions)。

## 构建与草稿

默认发布在 Apple Silicon Mac 本地构建，减少 GitHub Actions 使用量。先完成本地回归，再推送版本 tag；在该 tag 的干净检出运行 `npm ci` 和 `npm run release:local -- v<version>`，生成并上传待审核 Release 草稿及 npm 候选。维护者检查候选后，在 Actions 手动运行 OIDC npm 发布；npm 环境审批、GitHub Release 发布和需要时的公开分发仓库更新仍保留人工步骤。tag 推送不会启动云端 Mac 构建。[Mac 工作流](../.github/workflows/release-mac.yml)仍可手动运行作为云端备用方案，会使用 macOS Actions 分钟。完整构建与安装边界见 [Mac 发布](mac-release.md)。

本地构建包后，生成发行清单与说明：

```sh
RELEASE_TAG=v0.1.2-beta.7 node scripts/release-artifacts.mjs
RELEASE_TAG=v0.1.2-beta.7 GITHUB_REPOSITORY=RUC-NLPIR/CoworkOS node scripts/release-draft.mjs check
RELEASE_TAG=v0.1.2-beta.7 GITHUB_REPOSITORY=RUC-NLPIR/CoworkOS node scripts/release-draft.mjs upload
```

清单为 release/atria-release-<version>.json，记录 schemaVersion、version、prerelease、source.repository/commit/tag、generatedAt、实际 Mac 签名状态及每个产物的 name/size/sha256，附同名校验文件。签名报告 CoworkOS-<version>-mac-arm64.signing.json 及其 SHA-256 一起分发。说明为 release/atria-release-<version>.md，优先采用 docs/releases/<version>.md，再附自动生成的源码与清单链接。

上传前重新核对源码和所有产物；已经发布的版本拒绝覆盖。上传工作流全部结束、核对最终附件与验收结果后再 Publish；服务器端不可变发行设置为已发布 tag 和附件提供保护。

重跑草稿默认保留维护者编辑过的说明，显式 --replace-notes 才替换。

当前提供 macOS 14+ Apple Silicon DMG 和 Node >=22.19.0 的 CLI，另附 SHA-256、发行清单、安装与已知限制。CoworkOS 从 0.1.0 开始使用独立更新源和 npm 包 `coworkos-app`；旧版 Atria 的版本与更新源保持独立，不回退旧指针。用户可运行 `npm install -g coworkos-app`，再用 `coworkos desktop install` 显式安装 Mac App。其他平台验收分别记录，不能由源码可编译推断安装通过。

维护者先构建并验证 Mac DMG，再用 `npm run desktop:npm:pack` 生成 `coworkos-desktop-darwin-arm64-<version>.tgz`，用 `npm run npm:pack` 生成 `coworkos-app-<version>.tgz`。隔离安装并验证两个候选后，先发布平台包，再发布 CLI 包，避免 CLI 提前引用尚未发布的桌面包。新 App 的首次安装与应用内更新都从 npm registry 下载；CLI 本身也从 npm 更新。旧 App 仍使用其内置的 GitHub 更新地址，必须通过受支持的兼容发布或一次性迁移升级。`npm run cli:pack` 仍为旧 Release 更新生成兼容 CLI tgz，不替换 npm 包。

## 无证书测试版与公开入口

没有 Developer ID 证书的 Mac 测试版使用 ad-hoc 签名维护包完整性，仍未经过 Apple 公证，首次启动可能需要“系统设置 → 隐私与安全性 → 仍要打开”。ad-hoc 不表示 Apple 已验证开发者，原生 ZIP 自动更新只对通过 Developer ID 验证的包生成；当前测试版首次通过 DMG 安装，应用内更新可在用户可写目录中校验后受管替换并保留旧版备份。按 [安装指南](getting-started.md)操作，不关闭系统安全保护。

公开 beta 发布前核对源代码和第三方对应源码可访问、许可文件完整、发行包不含用户配置/任务，并记录实际安装与模型任务的验收状态。版本说明分开列出已完成和待人工验收项，声明未经真实模型或干净机器验收的范围；协议夹具不能代替这些结果。正式/稳定版承诺须完成 [P0 门槛](../CONTRIBUTING.md#pr审阅与发布)。

公开源码仓库提供代码与 Release 候选；npm 是当前 CLI 和 Mac App 安装/更新渠道。旧客户端使用的 [Atria-Releases](https://github.com/ignorejjj/Atria-Releases/releases) 保留历史安装包与兼容更新清单。普通用户安装 npm 版本不需要仓库凭据。

发布器验证固定来源 tag 与白名单产物，先核对服务端 digest 再发布，并通过内容 SHA 比较更新当前版本指针；流程见 [Mac 发布](mac-release.md)。公开组件与第三方对应源码材料独立保存在 [Atria-Components](https://github.com/ignorejjj/Atria-Components/releases)。反馈仍由维护者在私有项目管理，公开下载不会自动授予源码访问权。
