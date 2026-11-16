# 工作区与持久化

本文说明数据路径、归属、备份和恢复；接口见 [Product API](product-api.md)。

## 项目与任务路径

| 名称                 | 含义                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| 安装/仓库目录        | 程序、内置扩展、提示词和技能；不作为用户工作区                                                          |
| 所选项目目录         | Main 文件/命令工具的 CWD；Dashboard DTO 中也使用 `workspaceRoot` 命名，需要看所属对象                   |
| Harness 工作区根目录 | `COWORK_WORKSPACE` / Runtime 配置 `workspaceRoot`；保存 Task 状态与持久引用，默认 `~/.atria/workspace/` |
| Task workspace       | `<task-storage-root>/<taskId>/`；`browse_workspace` 的根与任务持久状态所在位置                          |

读取 `workspaceRoot` 时，先确认它属于哪一种数据：DTO 中它可能表示所选项目目录，也可能是 Task 存储根。按 Task ID 读取状态或产出物时使用真实 Task 存储，不从项目目录拼出任务目录；HTTP、Run 与 Pi 使用相同归属解析。定位代码时分别核对 [Dashboard 工作区目录](../src/dashboard/workspace-directory.ts)、[Run 服务](../src/dashboard/run-service.ts) 与 [LocalWorkspaceStore](../src/workspace/workspace-store.ts)。

Main 的最近一条模型请求执行快照位于 `<task-storage-root>/<taskId>/sessions/main/request-retry.json`。它在 HTTP 发送前以原子替换写入，文件权限为 600，记录原始序列化正文、模型/上下文、请求 ID、执行环境与校验和；状态区分 pending、failed、completed。重试成功后停止重放，后续请求覆盖该单槽，主动接受新输入会清除旧槽；历史仍在 Pi 会话和请求归档中。摘要/压缩请求不占用该 Main 重试槽。

执行快照保留未脱敏的用户内容，不能用作公开审计或训练导出；HTTP 认证头不保存，重试使用当前有效凭据。它与脱敏的 `*-requests.jsonl` 请求归档分别保存，归档可用 `retryOf` 关联原失败请求。损坏快照拒绝重放并保留原文件；旧会话缺少快照时沿用上下文恢复，不宣称能复原历史请求字节。备份时与 Task 存储一并保护。

## 临时工作区

无项目会话创建 `<dirname(global-index)>/temporary-workspaces/<uuid>/`，通常位于 `~/.atria/runtime/temporary-workspaces/`。这些目录持久保存，不属于 OS 临时目录，也不登记为共享默认 workspace 或普通空项目。每空间有 `.atria-temporary-workspace.json`（版本 1、workspaceId、holdingTaskId、taskStorageRoot、createdAt、retention=`until-explicit-discard`）；目录和记录身份必须匹配，路径 canonical 化且拒绝符号链接。先在隐藏 staging 目录写入并 sync 记录，再提交目录，发现过程不读取未完成空间。

临时会话的 `task.json` 仍在真实 Task 存储根，并带 `temporaryWorkspaceRoot`；`projectDirectory` 表示该空间的有效工具工作目录，`projectId` 不存项目成员身份，HTTP DTO 明确返回 `projectId:null`。全局目录索引把临时会话单独列出，不参与项目推断。临时工作区只用于临时会话；带 `temporaryWorkspaceRoot` 的记录必须同时指定同一 `projectDirectory` 且不带项目归属，否则按损坏记录拒绝。

取消会话和服务退出均不删除暂存空间；本版本无自动清理或临时空间丢弃入口，备份必须包含这些目录和真实 Task 存储。

## Temporary workspaces

Projectless chats allocate separate `<dirname(global-index)>/temporary-workspaces/<uuid>/` directories, normally `~/.atria/runtime/temporary-workspaces/`. These are durable product data, distinct from OS temp storage, shared default roots and projects. Version 1 `.atria-temporary-workspace.json` records identify each root, its original Task storage root and its holding Task with `retention: until-explicit-discard`. Canonical paths, directory/record identities and symlink checks protect restoration; staged records are synced before the root becomes discoverable.

Task history remains in the real Task storage root. `temporaryWorkspaceRoot` marks temporary ownership, `projectDirectory` carries the effective tool CWD, and HTTP returns `projectId:null`. Temporary conversations stay visible independently of projects. Temporary workspaces are only for temporary conversations; a marked record must name the same `projectDirectory` and must not carry a project assignment, otherwise it is refused as damaged. Nothing is migrated, reassigned or deleted.

Cancellation and shutdown retain all managed materials. No automatic cleanup or temporary-workspace discard action is provided; backups include these roots and Task storage.

## 项目与会话归属

App / Web 项目索引保存在全局工作区索引同级的 `projects.json`，默认 `~/.atria/runtime/projects.json`。它保存项目名称、稳定 `projectId`、工作文件夹 `projectDirectory` 和时间；空项目也持久保留。项目 ID 恒为 `project_<uuid>`，目录本身不是身份。会话 `task.json` 记录 `projectId`、`projectCatalogPath` 和目录快照；读取时以所属项目已提交的目录为准，工作文件夹调整不搬移 Task 目录、历史或产物。没有项目归属的会话不进入列表，也不按目录推断项目。

项目目录更新先保存可恢复意图，更新关联会话快照后再提交项目记录；中途退出可在重新打开时完成，损坏记录会拒绝覆盖并保留原文件。Main、交互 CLI、子智能体、待回复、休眠唤醒或命令任务仍在使用项目时，禁止修改工作文件夹。`<task-storage-root>/<taskId>/agents/main/project-execution.json` 是 Main 启动和进程存活的执行租约，覆盖 CLI 两轮输入之间的空档；退出或停止后释放。重命名不改变目录。

后续 Dashboard 和关联 CLI 会话继承项目目录。目录改变后继续原 Pi 历史时，启动器按新 CWD 派生会话并保留源 transcript；旧消息中的绝对路径和外部文档引用保持原值。项目使用流程见 [运行时参考](runtime-reference.md#会话与消息)，接口见 [Product API](product-api.md)。

## 外部 Main 容量

外部 Main 的运行名额与排队是执行主机的本机事实，保存在数据根的 `main-capacity/state.json`（默认 `~/.atria/runtime/main-capacity/state.json`，权限 0600）：本机 external 会话的 Task 索引、正在占用名额的 Run 与进程、以及等待中的需求（含已接受输入、尝试次数、退避时间、最近失败原因与本机进程号）。它不进入共享项目数据，也不在项目数据库备份快照内；进程结束后由程序释放名额并推进队列，重启时只核对本机自有进程。运行记录与 Main 会话归属仍以共享会话和 Task 为准。

## Task 存储与目录

```text
<task-storage-root>/
└── <taskId>/
    ├── task.json / task_events.jsonl   Task 状态和事实
    ├── inputs/<uploadId>/             用户原始附件与校验元数据
    ├── artifacts/                     最终交付文件
    ├── visual/images/                 不可变图片与 v1 元数据，裁剪映射和历史来源
    ├── visual/downloads/              Browser Use 接受的下载文件与返回的 hash 证据
    ├── agents/
    │   ├── main/context/              messages.json、state.json 等运行快照
    │   ├── main/work/                 草稿、脚本、中间材料
    │   ├── main/project-execution.json Main 启动与进程存活租约
    │   ├── coordinator/               调度私有工作目录
    │   └── subagents/<id>/
    │       ├── work/
    │       ├── deliverables/          待 Main 验收的候选文件
    │       └── logs/
    ├── sessions/main/<run>-requests.jsonl 模型请求、prompt、工具定义和响应
    ├── sessions/main/request-retry.json 最新 Main 模型请求的私有重试快照
    ├── sessions/main/pi/              Main 原生 Pi 会话
    ├── sessions/<agentId>/pi/<callId> 委派进程各自的 Pi 会话（与 `sessions/main/pi` 同级）
    ├── runs/<runId>/                  Run 事件、队列、Inbox、结果、main-input.json 与 agents/subagents/<id>/agent-output.log
    ├── experiments/                   运行时实验记录
    └── .runtime/                      Task 锁与产物索引等
```

以上目录按需创建。`artifacts/`、`inputs/`、`visual/`、`runs/` 和 `sessions/` 都属于当前 Task；旧版本遗留的 `applications/` 目录和其他应用文件保留在磁盘，但不再被读取。

Task 首次写入时创建布局与 `agents/main/work/`，在 Main 首次模型请求前即可访问提示中的工作目录。已存在的 Task 不重建或改写它的布局与已保存内容。

`visual/images/` 保存工具读到的图片、原生和浏览器截图，引用只属于当前 Task。版本 1 元数据与像素 hash 校验，完整写入后原子发布；中断残留计入限额，不自动删除旧图。图片可能包含用户内容，随 Task 一起备份保护；恢复历史图片不会恢复窗口授权或动作凭据。限额及接口见 [视觉观察](visual-observation.md)。

`visual/downloads/` 保存 Browser Use 接受的下载，使用随机前缀与清洗后的文件名；工具返回 Task 相对路径、字节数和 SHA-256。浏览器关闭保留已接受文件；取消或失败只删除本次创建的未完成目标。内容属于用户 Task，备份时一起保护，正式交付仍通过产物工具发布。浏览器 cookie/profile、pageId 和脚本 `state` 只在当前运行时存活，重启后不从这些文件恢复。详见 [Browser Use](browser-use.md) 与 [CUA 脚本](cua-scripting.md)。

`runs/<runId>/main-input.json` 以版本 1 保存 Main 启动前接受的完整输入及 `submittedAt`（毫秒时间戳），新记录另保存主动来源 `source`、`messageId`/Task/Run 身份、原始 composer `body` 和附件引用，权限为 600。无新消息的续执行沿用这条记录；启动失败后仅补回 Pi 历史中尚未保存的原始输入。旧 Run 没有这个文件时仍可从已有 Pi 会话恢复。该记录包含原始请求和附件引用/内容，应与会话工作区一起备份。

`sessions/main/user-inputs/<messageId>.json` 另外持久保存主动提交的原始 body、附件与稳定消息身份，避免同一 Run 的后续内部输入覆盖可编辑来源。启动未接受的输入会标记为拒绝，不作为最新可编辑消息。

`sessions/main/versions.json` 使用版本 1 记录 Task、当前会话版本 ID、明确选定的 Pi session 文件、旧 Run 排除集合、此前前缀活动、历史消息/活动快照，以及修改重发的幂等身份。新 Pi 分支只包含被修改输入之前的 entry；旧 session 文件和 Run 记录保留，后续运行不靠最近修改文件猜测当前版本。`request-before-edit-<versionId>.json` 私有副本保留被替换轮次的原模型请求快照，权限为 600，不能作为新编辑输入的活动重试槽。备份应包含版本索引、所有 session 与这些私有恢复副本，不能仅复制当前消息列表。

新版本将历史正文和活动单独写入私有 `sessions/main/message-versions/<versionId>.json`（权限 600）；版本索引只保存历史文件名、当前对应消息、分组、预览和活动数量。缺少独立历史文件的版本索引按损坏记录拒绝并保留原文件；备份应同时包含这些历史文件。项目目录变更会复制当前选定 Pi 分支到新 CWD，再原子更新版本索引中的 session 指针，版本 ID 和旧记录不变。

`sessions/main/request-retry.json` 是唯一主动写入的版本 1 私有恢复槽，保存实际序列化 body、发送 endpoint、原模型/上下文和会话 ID、Task/Run/request 身份、执行环境、写入时的 Pi 版本（`piVersion`）、body SHA-256 与整槽校验和，状态为 pending/failed/completed。它保留原始用户正文、附件像素和成功工具结果，权限为 600；认证 headers 与配置密钥不保存。重放关联使用 `retryOf`，跨进程文件锁保护保存、结算及请求身份比对。版本不一致时不重放；重试写下的新快照用 `replaySkipped` 记录 `pi_version_mismatch` 与旧版本。缺少 `piVersion` 的快照按损坏记录处理。

新输入清除活动槽。

`executionScope` 独立保存 canonical 实际工作目录和 Task 存储根。启动和发送时校验归属，改变归属时拒绝精确重放且不生成替代请求；快照缺少该记录时同样拒绝精确重试，原档案不会被改写。

## 产出物与预览

产出物面板只展示当前 Task `artifacts/` 中的普通文件。API 的 `artifacts` 数组与实际目录一致，不混入其他位置的文件。

只供下载的最终文件写入 `artifacts/`；中间材料放 Agent 私有 `work/`，Subagent 候选输出放 `deliverables/`，由 Main 验收后用 `publish_artifact` 发布到正式交付目录。对话中的绝对文件链接按 Task 的 `storageRoot` 和已登记产出物解析，项目目录不作为产出物根。

文本、Markdown、JSON、图片和 PDF 在预览抽屉中只读展示并提供下载；其他格式直接下载。桌面构建额外提供「用系统默认应用打开」，由 preload 经 `GET /api/tasks/:taskId/artifact-path` 解析已索引文件后调用 Electron `shell.openPath`；Web 构建不显示该入口。产物目录只保留最终字节，编辑与版本历史不属于当前产品范围。

## 全局索引与桌面数据

App、CLI 和源码 Web 默认共用 `~/.atria/`，`ATRIA_HOME` 可整体覆盖。工作区目录索引在 `runtime/workspaces.json`。仅覆盖 `COWORK_WORKSPACE` 不会自动迁移这个全局索引；独立多实例测试需同时使用独立索引：

```sh
COWORK_WORKSPACE=/tmp/atria-dev \
COWORK_GLOBAL_INDEX=/tmp/atria-dev-index/workspaces.json \
COWORK_UI_PORT=3881 npm run ui
```

默认用户目录布局如下；运行 `coworkos data paths` 查看实际路径：

```text
~/.atria/
├── workspace/              默认工作区
├── runtime/
│   ├── workspaces.json     全局工作区索引
│   └── projects.json       项目名称、稳定 ID、工作文件夹及更新恢复意图
├── pi/                     App 与 CLI 的 Pi 可变状态
├── config.json             CLI / Web 模型配置，权限 0600
├── model-config.json       模型配置列表与启用项
├── credentials.json        执行主机的模型与搜索密钥，权限 0600
├── client-sessions.json    桌面客户端按后端加密的会话凭据
├── composer-drafts.json     跨端口恢复的对话草稿/文本附件，仅指定前缀
├── computer-policy.json     桌面全局窗口授权策略；不保存临时会话/截图
├── data-version.json       格式/创建/最近打开版本
└── logs/
```

开发 App 与正式 App 共用这个目录及单实例锁，因此不能同时打开两个默认桌面实例。`COWORK_DESKTOP_DATA` 可用于独立桌面测试目录，`COWORK_WORKSPACE`、`PI_CODING_AGENT_DIR` 和索引覆盖仍优先。

所选项目和外部原文件可能位于用户目录之外；完整备份须同时覆盖真实 Task 存储根和相关项目文件。替换或删除 App 程序不删除该目录；清理工具或手动删除用户数据会影响留存。退出/重启/升级约定见 [Mac 指南](mac-release.md)。

新版开发与正式桌面显示 CoworkOS / CoworkOS Dev；客户端会话使用 `CoworkOS Client` 钥匙串身份，旧模型凭据迁移使用 `Atria`。旧开发版的 macOS 加密密钥可能因原身份不同而无法解密；密文和源目录保留，界面仍可打开并重新输入密钥。真实钥匙串迁移与跨版本签名身份兼容需独立原生验收。

`computer-policy.json` 由可信桌面 IPC 原子写入，权限 600，格式为 `{ "version": 1, "policy": { "enabled": false, "mode": "observe" } }`。设置中的窗口访问按钮始终写入 mode=control；旧版已开启的 control 策略保留，旧版仅观察策略恢复时关闭并提示重新开启，原文件不改写。只有 enabled/mode 跨重启恢复；PID、窗口 ID、sessionId、observationId、截图和临时控制权均不持久化。缺失、损坏或未知版本默认关闭，并保留原文件供恢复；旧五分钟手动会话不迁移为全局授权。详见 [Computer Use](computer-use.md)。

`composer-drafts.json` 是私有本机草稿快照，权限为 600，包含版本、来源 origin 与 `atria.composer.v1:*` 条目；不包含其他 localStorage 或模型凭据。编辑草稿使用版本 4，在同一会话条目中保存编辑目标/幂等身份与原未发送草稿（正文及附件）；较旧宿主拒绝覆盖版本 4。取消或接受重发恢复原草稿，后台返回不更改当前选中的其他会话。

当前预算 16 MiB，写入采用临时文件原子替换，损坏记录保留 `.invalid-*` 副本，未来版本拒绝覆盖。普通 Web 服务仍使用 origin 内的 localStorage，不写该桌面文件。

## CoworkOS 会话导出格式

`coworkos session export`、交互 `/export` 和 RPC `/coworkos-export` 使用同一产品序列化器。JSON 顶层为 `schemaVersion: 1`、`format: "atria.session"`，包含 `producer`（CoworkOS 版本及真实 Pi 依赖版本）、`exportedAt`、`session`（sessionId、项目目录、可核对的 taskId/runId）、`task`、`messages`、`toolCalls`、`events` 和 `artifacts`。

消息保留 messageId、parentEntryId、时间、inCurrentBranch、role、content、instructionSections 和 metadata；metadata 保留工具 details、模型响应 ID、usage、系统工具增删，以及 bash 的 command/output/exitCode 等事实。自定义提示消息也保留类型和 details。工具调用按父节点谱系关联结果，`resultMessageIds` 保留全部有效结果，`resultMessageId` 优先当前分支，未返回的调用标为 unresolved。非消息事件保留事件类型和原数据。旧任务 ID 和会话分支不会因产品品牌更新而改写。

`artifacts` 仅引用现有 `.runtime/artifacts.json` 的注册元数据，不包含文件字节，也不为导出执行扫描或迁移。未能核对会话文件与 workspace 的绑定时，不猜测 Task 关联。凭据字段与所选配置及执行主机凭据存储（`credentials.json`）中的模型和搜索凭据脱敏，包括环境变量覆盖；其他正文和路径仍保留。新建和强制覆盖的导出文件均使用 600 权限，覆盖时先限制权限再写入会话内容。各分支的记录须有唯一 ID、有效父引用，且父引用不能形成循环；异常记录在导出前拒绝，源文件和已有输出保留。HTML 展示当前分支，另附全部分支的审计数据；用户内容始终转义为文本。

该格式用于阅读、分享和审计，不作为 Pi 恢复输入。内部 JSONL 和请求归档保持原格式。导出只接受当前版本的会话文件；更早的会话文件按无效文件头拒绝并保留原文件。导出不能替代完整备份：恢复仍需原生会话、工作区和外部项目文件；旧历史未保存的事实无法补回。原生 RPC `export_html` 仍属于引擎兼容接口，产品导出使用 `/coworkos-export`。

## 用户上传的输入文件

输入框支持选择、拖放图片/PDF/DOCX/PPTX/XLSX/UTF-8 文本，及粘贴截图。单个附件最多 25 MiB，每条消息最多 10 个、合计 100 MiB。原始字节先保存到全局 Task 索引同目录的 `uploads/<uploadId>/`，发送时校验 SHA-256，再复制到该 Task 的 `inputs/<uploadId>/original.<ext>`。输入材料不进入产出物面板。

草稿只保存附件元数据和 uploadId，桌面草稿格式 v3 可跨端口恢复，并兼容旧文本草稿。已完成上传后才允许发送或关闭窗口；切换对话会取消尚未完成的上传。删除附件按钮只解除该草稿的引用，不删除历史消息使用的原文件。当前未实现未引用上传文件的定期清理。

Main 的 `read_attachment` 工具按格式读取，支持文字分页、PDF 页面和图片输入；模型不支持图片输入时返回明确提示。PDF/Office 解析使用本机 Python 3 与 pypdf/PyMuPDF/python-docx/python-pptx/openpyxl；缺失依赖时原文件与下载仍可用，不会将二进制文件误当作文字发送。图片预览无需这些依赖。PDF 页面按需渲染，Office 预览为提取文字，并非完整排版预览。

## 修改重发事务

修改重发使用 `sessions/main/edit-transaction.json` 私有版本 1 journal，在改写版本索引之前保存原 Task、版本索引、Main context 与原 exact-retry 槽。

`prepared` 阶段崩溃后，Dashboard 重新列举或定位 Task 时恢复这些原始字节，拒绝未启动的新输入，保留分支、Run 和失败输入证据。

`launch_ready` 阶段已完整持久化新输入、Task/Run 和新分支；此后 spawn 可能执行过文件或外部动作，恢复会保留已接受的新版本并把孤立的 running Run 置为 waiting，不回滚外部动作。幂等重复请求返回真实 Task 状态，不将 waiting 声称为 running。事务结束后 journal 归档为 `edit-transaction-<runId>.json`，备份须包含这些私有恢复证据。
