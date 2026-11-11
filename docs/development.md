# 开发指南

[English](en/development.md) | 中文

先读 [AGENTS](../AGENTS.md)、[架构](architecture.md) 和 [代码地图](code-map.md)；贡献规则见 [CONTRIBUTING](../CONTRIBUTING.md)。

## 准备环境

使用 Node.js >=22.19.0、npm 和 Git；依赖以锁文件为准，执行 `npm ci`。第一次下载 npm 依赖和 Chromium 需要网络。模型密钥仅用于实际模型请求，普通本地回归使用隔离工作区和本地协议夹具。

| 开发目标      | 环境和准备                                                                 | 启动                                            |
| ------------- | -------------------------------------------------------------------------- | ----------------------------------------------- |
| CLI / harness | `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci`，`npm run build:cli`              | `npm run init`、`npm start`                     |
| Web           | `npm ci`、`npm run build`；Mac 构建需 Xcode Command Line Tools             | `npm run ui`，默认 `http://127.0.0.1:3880`      |
| Electron App  | `npm ci`；打包前由 `node scripts/ensure-electron.mjs` 获取 Electron 运行时 | `npm run desktop`                               |
| Computer Use  | Mac、Xcode Command Line Tools；截图需 macOS 14+、系统权限                  | 编译随 `npm run build`；动作验收需解锁桌面      |
| Mac 安装包    | macOS 14+、Apple Silicon Mac；离线完整包另需 uv                            | `npm run desktop:pack` / `npm run desktop:dist` |

`build:cli` 编译共享运行时并准备 CLI；`build`、`build:base` 和 `build:full` 准备文本工作台、数学排版与桌面宿主资源。非 Mac 环境跳过原生辅助程序和图标构建。

文档附件测试需要 Python 3.11 和 PDF/Office 解析依赖，缺库应修环境，不能把跳过当成通过。使用独立环境，并让夹具和读取器共用 `COWORK_PYTHON`：

```sh
python3.11 -m venv .tmp/document-python
.tmp/document-python/bin/python -m pip install -r scripts/document-requirements.txt
.tmp/document-python/bin/python -c 'import sys; print(sys.executable, sys.version); import fitz, docx, pptx, openpyxl'
COWORK_PYTHON="$PWD/.tmp/document-python/bin/python" npm run verify:full
```

## 使用隔离的开发工作区

开发与测试不要使用真实用户任务、模型设置或应用文档。Web 可以显式指定工作区和全局索引：

```sh
COWORK_WORKSPACE=/tmp/atria-dev \
COWORK_GLOBAL_INDEX=/tmp/atria-dev-index/workspaces.json \
COWORK_TABS_INDEX=/tmp/atria-dev-index/workbench-tabs.json \
COWORK_UI_PORT=3881 npm run ui
```

先完成无需模型的 TXT 新建、保存、重开和绑定，再按 [模型配置](configuration.md) 配置模型验证任务。不要用删除数据来排查恢复问题；路径归属见 [工作区说明](task-workspace-layout.md)。

Mac 开发版显示为 CoworkOS Dev (短后缀)，应用标识为 `org.atria.cowork.dev.runtime.<运行时哈希>`。每份不可变的 ad-hoc 开发运行时独立授权，避免不同 worktree 或运行时的签名共用同一条系统权限记录；同一运行时重复启动复用身份。

数据与正式版、CLI、Web 共用 `~/.atria/`，两个默认桌面入口共享单实例锁。测试可设置 `COWORK_DESKTOP_DATA`，需要整套隔离时设置 `ATRIA_HOME`。旧目录的保留与导入见 [持久化说明](task-workspace-layout.md)。

```sh
npm run desktop:install-dev # 安装固定的 ~/Applications/CoworkOS Dev.app
npm run desktop             # 构建最新源码并启动同一入口
```

固定入口读取当前仓库的 `desktop/`、`dist/`、`web/`，可从 Finder/Dock 启动；直接双击使用上次构建，仓库搬移后要重新安装入口。运行时在 `.tmp/desktop-runtime/`，打包 App 在 `.tmp/release/mac-arm64/`，可分发 DMG 在 `release/`。CLI 候选可用 `ATRIA_PACKAGE_DIR=.tmp/cli-candidate npm run cli:pack` 独立审查，默认输出仍为 `release/`。

Mac 开发启动与更新后重启统一通过 LaunchServices 打开指定的 App 包，命令在发起启动后返回，退出使用 App 菜单。测试数据目录等环境变量传给该实例。

不要直接执行 `Contents/MacOS/` 中的二进制做系统权限验收：直接执行（包括 detached）可能把 App 和原生 helper 的权限归到 Terminal/IDE，导致关闭 CoworkOS 的系统权限后仍可操作，或没有出现 CoworkOS 的授权提示。测试时核对系统设置中带当前短后缀的 CoworkOS Dev 条目；人工撤销不一定重现首次安装弹窗，系统拒绝再次提示时仍需在系统设置确认。

Finder 安装入口复制已签名的缓存包，不改内容或再次签名，保持相同权限身份。图标、Electron、工具链或包元数据变化产生新开发运行时后需要为新条目授权，旧授权不会自动迁移；旧版无后缀的 CoworkOS Dev 条目也不代表新测试包已授权。无需删除其他 App 或重置全部系统权限。

前端使用原生 ES modules，没有 Vite/HMR。JS/CSS 修改后刷新；TypeScript、浏览器生成 bundle 或 Swift 修改后重新构建、退出并重启宿主。图标源、Electron 或包版本变化要重建开发运行时。生成文件不是修改入口。完整/CLI 构建会清理已删除或搬移源码对应的旧编译文件，保留原生 helper 与 Python runner。

只迭代界面时，完成一次 `npm run build` 后可直接运行 `node dist/src/cli/dashboard.js`，省去 `npm run ui` 每次启动时的构建。保留需要的隔离环境变量；服务直接读取 `web/` 中的 HTML、CSS 和 JS，修改后刷新浏览器即可。后端改动仍需停止服务、重新构建并启动。该入口与服务、桌面使用同一实例归属：同一数据根已经后端或桌面连接时复用其地址并退出，不另开写入服务。

### 独立后端

独立后端可以脱离启动它的客户端继续运行。开发包支持 macOS 14+ Apple Silicon；App 首次连接会启动或复用同一数据根的后端，桌面退出不会停止它。独立运行 CLI 需要 Node.js ≥22.19.0，所用 CLI 与 App 应来自同一候选版本。完成 `npm run build:cli` 后，`node dist/src/cli/backend.js start`（或 `coworkos backend start`）在同一数据根启动分离进程，`status` 查看实例，`stop` 让后端完成受管进程收尾后退出；端口、会话 token 与实例身份记录在 `ATRIA_HOME/runtime/backend-instance.json`（权限 0600），后端身份在 `backend-identity.json` 中跨重启保持。直接执行 `serve` 遵守同一实例归属：已有可核验实例时只输出其身份并退出，另有启动中的后端或身份无法确认时明确报错，不覆盖实例记录。`stop` 只在后端完成收尾并删除实例记录后返回 `stopped`；超时被强制结束或收尾未完成时返回 `incomplete` 并以非零状态退出，同时保留实例记录供下次 `start` 沿用同一后端身份恢复。这些命令不安装 launchd/systemd 常驻服务；系统级常驻仍只能由 [持续监控服务](../scripts/monitor-service.mjs) 显式安装。

Web 入口默认只监听本机。模型请求、任务执行和文件操作仍由本地后端负责，单独托管静态前端不能运行完整工作台。若把后端部署到远程服务器，命令和文件操作也会在该服务器执行。

## 更新源码检出

在 CoworkOS 的源码检出中运行：

```sh
npm run cli -- update --check
npm run cli -- update
```

更新目标是 CoworkOS 所在的真实 Git 检出，即使从其他业务项目启动 `coworkos` 也不更新那个项目。当前分支必须有 upstream；检查 fetch 上游并比较提交，同 package version 的新提交也可被识别。detached HEAD、合并/变基中、已跟踪修改、非忽略的新文件、本地独有提交或分叉都会拒绝更新。源码跟随自身上游分支，`--channel` 仅用于已安装的发行包。

CLI 准备 `build:cli`；开发 App 从“设置 → 更新”准备完整 `build`。CLI 已同步到最新提交但 App 构建尚未更新时，App 仍会提示重建并可在同一提交准备完整构建。Web 宿主先停止、更新，再用 `npm run ui` 重启以生成完整浏览器构建。

候选依赖与构建在独立临时源码目录完成；准备失败保留现有源码、依赖与构建。

发布阶段失败尝试回退；发现并发编辑或回退失败时保留恢复副本并报告人工恢复。忽略的用户配置/任务不复制进候选，也不清理。更新器不 reset、stash 或 clean 检出。

App 启动后检查一次，用户主动执行才更新。草稿保存与运行任务检查属于桌面宿主，后端在退出后继续运行；构建完成后重启启用新代码，中断或失败不能显示为已安装。更新回归使用本地 Git 远端与假发行响应，不修改真实仓库或发布 Release。

开发 App 更新后由独立 [重启 helper](../scripts/restart-development.mjs) 等待旧进程退出，再刷新开发入口并启动新构建。旧开发入口若缺少工具链元数据，先退出 App，用 `npm run desktop` 或 `npm run desktop:install-dev` 刷新，再使用应用内更新；宿主会在修改源码前给出该提示。

更新实现分别位于 [源码事务](../scripts/update-source.mjs)、[CLI 调度](../scripts/update.mjs)、[发行下载/安装](../scripts/update-release.mjs)、[桌面生命周期](../desktop/updates.cjs) 和 [UI](../web/assets/controllers/desktop-updates.js)。先跑 `test/source-update.test.js`、`test/development-restart.test.js`、`test/update-release.test.js`、`test/desktop-updates.test.js`、`e2e/desktop-updates.spec.js`，再运行对应验证。发布 feed 生成与签名守卫见 `scripts/update-feed.mjs`、`test/update-feed.test.js`。CLI 包必须携带所 import 的更新脚本，桌面专用依赖不进入 CLI 包。

## 日常修改闭环

委派、返修、独立审查和归档使用 [开发交接与验证记录](development-handoffs.md)，并按 [坑点索引](pitfalls/README.md) 查阅匹配的环境问题。历次建议的落实位置见 [复盘索引](retrospectives.md)。

1. 从 [代码地图](code-map.md) 找到行为负责人、消费者和测试，读取目标目录的 `AGENTS.md`。
2. 在临时工作区复现，先运行已有相关测试；修复所属服务/Adapter/控制器，入口只装配。
3. 增加覆盖原失败或新用户行为的回归。异步行为覆盖归属、取消、晚返回、冲突与退出恢复；协议测试同时验证两端。
4. 按范围运行相关测试和轻量 `npm run verify`；纯文档只做链接/格式检查。发布或广泛影响的修改运行 `npm run verify:full`，界面、原生驱动和发布包另做对应验收。
5. 同步代码地图、现行文档和路线图状态；交付实际命令、结果、跳过项和剩余限制。

```sh
npm run test:unit -- --list
npm run test:unit -- --file test/application-resource-store.test.js
npm run test:unit -- --match application
npm run verify
```

`test:unit` 默认准备构建；已有与当前源码一致的完整构建时可显式加 `--skip-build` 缩短反馈。不能用旧 `dist/` 的通过结果证明新源码正确。重复 `--file` 选择多个用例，`--match` 的筛选语义与完整说明见 [本地测试指南](testing-local-run.md)。

## Lint 存量基线

[ESLint 配置](../eslint.config.mjs) 在现有检查上启用以下规则：TypeScript/Pi 的 `no-unnecessary-condition`、`no-unnecessary-type-assertion` 和 `no-useless-catch`，以及 TypeScript、Pi、Web、Electron 和脚本中的定向 `no-restricted-syntax`。后者检查不绑定错误且未抛出的 catch、空 catch，以及相应的 `.catch()` 回调。绑定错误后仅记录日志或返回默认值等处理语义仍需审查。

单独运行 lint 前先 `npm run build:cli`，使 `.pi` 引用的 `dist` 类型与当前源码一致，再执行 `npm run lint`；`verify` 和 `check:ci` 已按这个顺序运行。日常 GitHub 检查仍为手动触发。

2026-11-09 将旧配置接入已验收的 `583cbb4` 代码时，仅为这次新增规则校准 [文件级基线](../eslint-suppressions.json)，记录 237 个文件、1037 项：多余条件 321、丢弃错误语法 641、多余类型断言 75。随后清理这些存量并清空基线：能证明冗余的条件和断言直接删除；工具参数、持久化读取、闭包写入的标记位等真实边界，以及预期内的 best-effort 清理，改为逐处 `eslint-disable-next-line <规则> -- <运行时依据>`。基线保持空对象，日常改动维持零新增；确有运行时依据的局部例外必须写明依据并接受审查，不以未使用绑定的 catch、等价吞错包装或扩充基线绕过检查。

修改上述规则覆盖的代码后，运行 `npx eslint src web desktop scripts .pi --prune-suppressions` 保持基线为空，再运行常规 lint。基线由 ESLint 维护，Prettier 跳过该文件。

## 验证分层

| 命令                                                      | 验证范围                                                                                | 使用时机                                                    |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `npm run test:unit -- --file test/name.test.js`           | 有针对性的 Node 行为/协议/生命周期测试，默认先构建                                      | 每次相关修改的快速反馈                                      |
| `npm run verify`                                          | CLI 与 Web 资源构建、源码卫生、lint、工作台/Pi 类型、增量格式和文档链接；不运行行为测试 | 完成一项修改后的默认本地门槛                                |
| `npm run verify:full`                                     | 一次完整构建、静态检查、发布执行器自测和全量 Node 回归                                  | 发布验收或影响范围广的修改                                  |
| `npm test` / `npm run check`                              | 保留的 Node 回归 / 构建与静态检查入口                                                   | 兼容现有本地脚本；已执行 verify:full 时无需为同一源码重复跑 |
| `npm run check:ci`                                        | CLI 构建、源码卫生、lint、工作台/Pi 类型、增量格式和文档链接                            | 手动 GitHub 轻量检查；本地 verify 与相关测试仍是完成门槛    |
| `npm run check:source`                                    | 当前受版本管理及非忽略的源码文件；检查私有配置、凭据、个人路径和不应提交的产物/旧文档   | 提交和发行前；不扫描 Git 历史                               |
| `npm run check:docs`                                      | 现行导航的本地 Markdown 文件链接和标题锚点；不请求外部网站                              | 文档和代码路径修改，可 `-- --list` 查看范围                 |
| `npx playwright install chromium`                         | 安装 Chromium                                                                           | 首次浏览器测试准备                                          |
| `npm run test:browser`                                    | Chromium / Electron 用户流程；原生场景有各自环境要求                                    | UI、HTTP/UI 集成、草稿、导航、协作变更                      |
| `npm run desktop:pack` 后 `npm run test:desktop`          | 搬移后的真实打包 App、设置、Pi/本地模型、退出/重启/模拟升级                             | 桌面宿主、运行生命周期、打包变更                            |
| `npm run test:release -- --list` / `npm run test:release` | 五环节发版用例，记录版本、日志、跳过与人工项                                            | 候选发布验收；原生/包阶段显式加入                           |
| `npm run smoke:coding` / `npm run smoke:multi-subagent`   | 实际 endpoint 和多智能体；消耗模型额度                                                  | 模型能力与真实服务验收，先配置连接                          |

普通 Node 回归排除单独的原生桌面/CUA 验收入口，并打印原因；可选引擎仍可能报告 TAP skip。详细前提、报告和显式原生命令见 [本地测试指南](testing-local-run.md)。本地协议夹具验证真实 Pi 的协议/生命周期，不证明实际模型能力；浏览器通过也不证明干净机器安装。检查范围以 [package.json](../package.json) 和执行器为准。

浏览器可先 `npm run build`，再用 `npx playwright test e2e/automation-workspace.spec.js --output=.tmp/playwright-workbench` 运行对应文件。并行的 Playwright 进程须使用不同 `--output`，避免清理对方产物。无需模型的测试不应读取个人连接配置。

## 应用 UI 约定

用布局区分层级，减少重复的次级标签和说明。

先按任务阶段和操作频率组织界面，再调整视觉样式。空白/生成中状态不铺满不可用功能；选择对象后再显示对象操作，启用工具后再显示结果。主工作区优先保留内容，次要面板可关闭并按所在容器宽度适配；文字不能逐字挤压，隐藏面板不能留下空列。功能列表使用有意义的分组，避免把每种导出格式、诊断说明和常用动作平铺为同一级。截图验收同时检查有效内容占比与任务路径，不能只检查控件边界和主题颜色。

页面和 TXT 应用共用 [ui.css](../web/assets/ui.css) 的颜色、字体、按钮、菜单与状态变量；应用样式使用自身类名。字体使用本地 Inter 可变字体，中文回退到苹方、微软雅黑或系统字体，离线可用；来源与许可见[第三方声明](../THIRD_PARTY_NOTICES.md#inter-界面字体--interface-typeface)。正文 15px、控件 14px、辅助文字 12px、栏目标题 16px、任务面板及设置弹窗标题 18px、欢迎标题 22 至 26px；常规 400、标题 500、强调 600，默认正常字间距，正文行高 1.8。深色界面采用近黑底、低对比度分隔线和实色输入表面；桌面侧栏默认 232px，正文与输入框沿同一阅读列对齐。

`ui.css` 装配共享组件后，[system-theme.css](../web/assets/system-theme.css) 加载中性浅深色表面与文字颜色；[settings.css](../web/assets/settings.css) 在其后统一设置总览、模型连接和联网搜索的表面、表单与固定操作栏，始终使用实色表面。图标来自 [icons.js](../web/assets/ui/icons.js) 与 SVG sprite；图标按钮须有 `aria-label`，优先使用 32px 点击区域。

- 菜单使用 [menu.js](../web/assets/ui/menu.js)，支持方向键、Home/End、Esc、外部关闭和焦点归还；弹窗使用 [modal.js](../web/assets/ui/modal.js)，限制 Tab 并恢复发起控件焦点。
- 重命名、项目编辑、另存等短表单统一使用 [dialogs.css](../web/assets/dialogs.css) 的 `.app-dialog`、字段、说明、错误和操作栏；输入框须有明确标签，动作区分主次，覆盖提交中、失败、禁用与键盘焦点状态，不依赖浏览器默认控件外观。工作台扩展样式归 [workbench/dialogs.css](../web/assets/workbench/dialogs.css)，附件预览归 [attachment-preview.css](../web/assets/styles/attachment-preview.css)。设置、目标与监控保留各自布局并共用主题变量。
- 会话标题和项目归属统一放在顶栏。顶栏与侧栏复用 [会话菜单](../web/assets/controllers/conversation-menu.js)，按整理、复制/导出/打开和归档分组；运行或等待中的会话额外显示停止任务。复制子菜单支持标题、ID、本机链接和对话正文，导出保留用户/助手的 Markdown 正文，不包含思考和原始工具日志。未读标记保存在本机浏览器，显式打开会话后清除；链接使用 `?task=<id>` 定位原会话。子菜单支持左右方向键与逐层 Esc，刷新时保留目标与焦点，窄屏切换为内嵌菜单。新任务页显示菜单但禁用会话操作，独立编辑器隐藏该菜单。右侧任务面板在打开或刷新页面时默认收起，右上角开关在有工作区时收起或恢复当前会话的编辑视图，否则展开任务面板，全局设置位于左下角侧栏，不再重复显示会话标题栏。宽度 1280 及以上任务面板是一列，只用这个开关收起，面板内不再放关闭按钮；更窄时面板浮在顶栏之上，保留面板内的收起按钮。
- 应用命名用 [document-name-dialog.js](../web/assets/workbench/adapters/document-name-dialog.js)，提交中保留表单、错误与输入；保存失败/冲突用文字说明并保留草稿。
- 对话输入在正常布局流内，以圆角、独立底色和柔和阴影形成悬浮卡片，聚焦时保留阴影；外侧留白与画布同色。滚动区占剩余高度，附件条独立限高。流式更新保留 DOM 身份、展开、焦点和用户阅读位置；异步交互始终捕获原 Task/导航 token。
- 界面只展示实际能力、进度和状态；侧栏设置不显示占位身份，Web 不模拟 Mac 窗口按钮。主要动作和危险操作使用现有状态类。
- 容器优先以留白和中性表面区分层级；左右侧栏与主体之间保留一条低对比细线，拖拽分隔条在悬浮、拖动或键盘聚焦时加强反馈，命中范围不随线宽缩小。工作区文件和视图操作共用一行，当前文件与必要操作使用圆角胶囊分组；项目归属和运行状态通过悬浮提示及无障碍状态提供。短表单使用柔和填充输入和无框次要动作，保留明确的焦点与错误提示；只有确实需要的内容边界使用细线，避免堆叠边框与阴影。成功状态用低强调的图标和文字表达，保留完成、停止与失败的语义区别。错误先显示简短原因与可用恢复动作，技术细节和长日志默认折叠；展开状态、键盘焦点和日志阅读位置在刷新中保持。
- 没有活动会话时，任务面板提供简短的开始说明；运行用量位于团队星系之前。独立应用在顶栏显示当前文档名称，窄编辑区的身份和保存动作分别占行，避免逐字挤压。
- 活动对话从等待首个响应、思考到工具执行和自动重试均显示持续的运行指示与当前阶段；完成和停止时退出动画。工具标题使用可读的具体工具名，未知工具仍显示名称。
- 动效统一用 [ui.css](../web/assets/ui.css) 的令牌：`--motion-fast`（120ms，悬停/按下/颜色反馈）、`--motion-base`（200ms，弹层、面板、抽屉进入）、`--motion-layout`（240ms，侧栏或面板收起展开）、`--motion-glide`（300ms，选中背景滑动）；缓动 `--ease-standard` 用于进入和移动，`--ease-exit` 用于离开，`--ease-glide` 用于滑动。不写裸时长。分段选项、设置导航、观测筛选、需求阶段和会话行的选中背景由 [motion.js](../web/assets/ui/motion.js) 的 `installSelectionGlide` 在用户点击或按键后滑到新选项，新增同类控件在 `SELECTION_GROUPS` 登记；侧栏和右侧面板的收起展开通过 `animateLayout` 只在切换的那一刻让网格列过渡，拖拽分隔条和窗口缩放仍即时跟随。系统或设置开启「减少动态效果」时，滑动和列过渡都不发生，脚本动画用 `reducedMotion()` 判断，不直接读媒体查询。
- 检查浅深色下实际渲染的文字对比度，以及 1440/1280 和 474/320 宽度、菜单定位、标题截断、控件可达性、键盘焦点和横向溢出；增加对应实际浏览器回归，并复核截图中的表面层级与状态强调。

TXT 状态与 DOM 分开，文档 session 负责保存协作。使用 [代码地图](code-map.md) 中的领域入口和行为测试，不向 `web/app.js` 添加应用专用状态机。

## 定位故障

| 现象                           | 优先核对                                                           |
| ------------------------------ | ------------------------------------------------------------------ |
| 保存失败 / 409                 | revision、外部修改、共享写入；保留草稿后重读，不自动覆盖           |
| Agent 看不到文档或工具         | 实际资源绑定、MCP 状态、首轮 `before_agent_start` 和后续 `context` |
| 任务等待、停止不完整、恢复重复 | Task/Run 事件、Inbox 消费、问答/委派/jobs、进程结束和 checkpoint   |
| 重启后草稿/资源消失            | 工作区、全局/Tab 索引、桌面用户目录与草稿镜像；先记录路径          |
| 模型启动失败                   | endpoint、协议、模型、参数、环境覆盖和脱敏错误；不输出完整配置     |
| UI 异步回包覆盖新会话          | 捕获的 Task/草稿身份、导航 token、迟到请求和同 Task 串行化         |

日志/trace 位置见 [数据布局](task-workspace-layout.md)。报告问题注明版本/commit、系统、入口、复现、脱敏日志和测试目录。

## GitHub Actions

仓库只保留 main 一条长期主分支，功能/修复临时分支经 PR 合入后删除。main 是已评审集成代码；发布版本由固定 tag/Release 标识，完整流程见 [版本管理](beta-release-process.md)。

[常规工作流](../.github/workflows/test.yml) 仅通过 Actions 手动触发，使用单组 Ubuntu + Node 24；push 和 PR 不自动执行静态检查。安装时跳过 Electron 二进制下载，然后执行 `npm run check:ci`：`build:cli`、源码卫生、lint、工作台/Pi 类型、增量格式和现行文档链接检查。

完整 Node 回归、浏览器、原生引擎、实际模型和安装包体验在本地完成；日常使用轻量 `npm run verify` 与相关测试；发布或广泛影响的修改用 `npm run verify:full`，按改动增加对应层的验收。手动 GitHub 常规检查只提供构建与静态反馈，相关行为验证证据随 PR 提交。

[Internal Mac package](../.github/workflows/internal-mac.yml) 仅手动生成并上传 arm64 内测 DMG/校验文件，不承担完整回归、浏览器或桌面 smoke。[Release Mac DMG](../.github/workflows/release-mac.yml) 则在版本 tag 推送后构建 DMG/CLI 与校验文件，并上传 GitHub Release 草稿，由维护者审阅后 Publish；只有显式配置并验证 Developer ID 签名时，另生成 ZIP、校验文件与 Mac 更新 feed。当前未配置签名，默认仍为 arm64 未签名候选。候选包生成后按 [Mac 发布指南](mac-release.md) 本地安装验收。发布前须完成安装与实际任务验收；分支保护需单独配置。

## Mac 版本 tag 与 Release 草稿

版本 tag 必须与根 package/lock 版本一致，工作流从 tag 提交构建；发布提交包含工作流、脚本和完整源码/文档变更。本地验收完成后再创建下一版，例如 `npm version 0.1.2 --no-git-tag-version`，暂存并提交全部预期修改，创建 `v0.1.2`，推送提交和 tag。自动构建不会发布草稿；当前配置仍未签名，签名 ZIP 更新需证书与独立安装验收。

在 Release Mac DMG 等待 DMG/CLI 与校验文件上传，签名构建还需 ZIP/feed，到对应 Release 草稿核对内容和安装验收，再由维护者选择发布分类并点击 Publish。可用手动输入已有 tag 重试/修复草稿；已发布同版本禁止替换，需新版本。完整命令与恢复规则见 [Mac 发布](mac-release.md#版本-tag-与-release-草稿)。

`desktop:pack` / `desktop:dist` 打包文本工作台和完整编排运行时，不安装或分发 CAD、Blender、PPT 组件。见[能力范围](builtin-capabilities.md)。
