# 工作区与持久化

本文说明数据路径、归属、备份和恢复；接口见 [Product API](product-api.md)。

## 项目、应用资源与任务路径

| 名称                 | 含义                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| 安装/仓库目录        | 程序、内置扩展、提示词和技能；不作为用户工作区                                                          |
| 所选项目目录         | Main 文件/命令工具的 CWD；Dashboard DTO 中也使用 `workspaceRoot` 命名，需要看所属对象                   |
| Harness 工作区根目录 | `COWORK_WORKSPACE` / Runtime 配置 `workspaceRoot`；保存 Task 状态与持久引用，默认 `~/.atria/workspace/` |
| 应用资源根目录       | 项目应用服务的资源与事务目录；可在所选项目中，历史资源继续使用原位置                                    |
| Task workspace       | `<task-storage-root>/<taskId>/`；`browse_workspace` 的根与任务持久状态所在位置                          |

读取 `workspaceRoot` 时，先确认它属于哪一种数据。应用资源根与 Task 存储根可相同，也可分别位于项目目录和用户数据目录。按 Task ID 读取状态、引用或实例时使用真实 Task 存储，不从资源根拼出任务目录；HTTP、Run 与 Pi 使用相同归属解析。定位代码时分别核对 [Dashboard 工作区目录](../src/dashboard/workspace-directory.ts)、[Run 服务](../src/dashboard/run-service.ts) 与 [LocalWorkspaceStore](../src/workspace/workspace-store.ts)。

Main 的最近一条模型请求执行快照位于 `<task-storage-root>/<taskId>/sessions/main/request-retry.json`。它在 HTTP 发送前以原子替换写入，文件权限为 600，记录原始序列化正文、模型/上下文、请求 ID、执行环境与校验和；状态区分 pending、failed、completed。重试成功后停止重放，后续请求覆盖该单槽，主动接受新输入会清除旧槽；历史仍在 Pi 会话和请求归档中。摘要/压缩请求不占用该 Main 重试槽。

执行快照保留未脱敏的用户内容，不能用作公开审计或训练导出；HTTP 认证头不保存，重试使用当前有效凭据。它与脱敏的 `*-requests.jsonl` 请求归档分别保存，归档可用 `retryOf` 关联原失败请求。损坏快照拒绝重放并保留原文件；旧会话缺少快照时沿用上下文恢复，不宣称能复原历史请求字节。备份时与 Task 存储一并保护。

## 临时工作区

默认独立应用与无项目会话分别创建 `<dirname(global-index)>/temporary-workspaces/<uuid>/`，通常位于 `~/.atria/runtime/temporary-workspaces/`。这些目录持久保存，不属于 OS 临时目录，也不登记为共享默认 workspace 或普通空项目。每空间有 `.atria-temporary-workspace.json`（版本 1、workspaceId、holdingTaskId、taskStorageRoot、createdAt、retention=`until-explicit-discard`）；目录和记录身份必须匹配，路径 canonical 化且拒绝符号链接。

先在隐藏 staging 目录写入并 sync 记录，再提交目录，发现过程不读取未完成空间。

临时会话/holding Task 的 `task.json` 仍在真实 Task 存储根，并带 `temporaryWorkspaceRoot`；`projectDirectory` 表示该空间的有效工具工作目录，`projectId` 不存项目成员身份，HTTP DTO 明确返回 `projectId:null`。新 holding Task 有独立 `temporary-<uuid>` ID，kind 为 workspace，不显示为会话或登记项目。全局目录索引单独列出临时会话，跳过 legacy 项目推断；重启从用户数据里的空间记录和 Task/manifest/reference 恢复资源原根。

旧无标记 Task、旧 `workspace` holding Task 和既有项目/null-project 资源保持原解释，不自动迁移、改归属或删除。

桌面端通过应用的文件导入入口选择原文件，桌面环境同时传递原文件路径和内容 hash，即使应用位于临时工作区也保留 `sourceFile` 关联。保存语义由 Adapter 决定：显式保存经原文件校验和冲突协议写回原路径，自动保存只更新管理副本中的恢复草稿。资源根仍用于修订和恢复，不因此移动原文件或登记项目。浏览器没有原生路径时保留副本导入；旧的无 `sourceFile` 资源不按同名文件自动补关联。

显式另存通过 ApplicationService 和 Adapter 导出，ResourceStore 在 revision CAS 锁内维护 `savedCopies`（绝对 path、format、内容 hash、revision、可选 project）。首次文件写入先 sync，再 exclusive 原子提交；首次保存拒绝任何已存在目标，即使内容相同；已落盘的 savedCopies 记录才授权更新。

若首次文件提交后、记录落盘前中断，目标文件保留，但重试拒绝接管，需要用户另选位置。已登记副本的后续更新核对内容 hash，外部改动返回冲突。

原管理资源、native 附件、完整修订、所有 Task 引用和会话历史保留；项目保存将结果放到项目目录，并给此前无归属资源添加明确项目归属，而不搬移旧资源。此后新建协作会话按明确的项目 ID 创建，并跨根加载原文档；临时物理根不能登记成项目。

取消、关闭 Tab 和服务退出均不删除暂存空间；本版本无自动清理或临时空间丢弃入口，备份必须包含这些目录、真实 Task 存储与外部导出位置。

## Temporary workspaces

Independent apps and projectless chats allocate separate `<dirname(global-index)>/temporary-workspaces/<uuid>/` directories, normally `~/.atria/runtime/temporary-workspaces/`. These are durable product data, distinct from OS temp storage, shared default roots and projects. Version 1 `.atria-temporary-workspace.json` records identify each root, its original Task storage root and its unique holding Task with `retention: until-explicit-discard`. Canonical paths, directory/record identities and symlink checks protect restoration; staged records are synced before the root becomes discoverable.

Task history and holding Tasks remain in the real Task storage root. `temporaryWorkspaceRoot` marks temporary ownership, `projectDirectory` carries the effective tool CWD, and HTTP returns `projectId:null`. Temporary conversations stay visible independently of projects; holding Tasks stay hidden. Legacy records without the marker retain their existing project adoption and null-project resource semantics. No existing resources or history are moved or deleted.

Desktop file selection through an application's file import passes the original path and content hash when the desktop provides it, preserving a `sourceFile` association even in temporary workspaces. The adapter decides the save behavior: explicit saves write to the original through its validation and conflict protocol, while autosave only updates a managed recovery draft. The managed root retains revisions and recovery data without moving the original or registering a project. Browsers without native paths still import copies; legacy resources without `sourceFile` never acquire an association by matching file names.

Explicit saving exports through the Adapter under revision CAS and records `savedCopies` (path, format, content hash, revision and optional project). Complete first writes commit exclusively and reject every existing destination, including identical bytes. Only a persisted savedCopies receipt authorizes updates, which verify the prior copy's hash.

If a process stops after file commit but before receipt persistence, the file remains intact and retries refuse adoption; choose another destination. Unknown files and external changes are not overwritten.

Adding an unassigned document to a project records its affiliation and writes the export there while retaining its original managed root, revisions, native attachments and session references. New collaboration conversations use that explicit project ID and load the original document across roots; the temporary physical root is never registered as a project.

Cancellation, tab closure and shutdown retain all managed materials. No automatic cleanup or temporary-workspace discard action is provided; backups include these managed roots, Task storage and exported files.

## 项目与会话归属

App / Web 项目索引保存在全局工作区索引同级的 `projects.json`，默认 `~/.atria/runtime/projects.json`。它保存项目名称、稳定 `projectId`、工作文件夹 `projectDirectory` 和时间；空项目也持久保留。新项目 ID 为 `project_<uuid>`，旧目录分组保留原绝对路径 ID。会话 `task.json` 记录 `projectId`、`projectCatalogPath` 和目录快照；读取时以所属项目已提交的目录为准，工作文件夹调整不搬移 Task 目录、历史、记忆、产物或应用资源。

项目目录更新先保存可恢复意图，更新关联会话快照后再提交项目记录；中途退出可在重新打开时完成，损坏记录会拒绝覆盖并保留原文件。Main、交互 CLI、子智能体、待回复、休眠唤醒或命令任务仍在使用项目时，禁止修改工作文件夹。`<task-storage-root>/<taskId>/agents/main/project-execution.json` 是 Main 启动和进程存活的执行租约，覆盖 CLI 两轮输入之间的空档；退出或停止后释放。重命名不改变目录。

后续 Dashboard 和关联 CLI 会话继承项目目录。目录改变后继续原 Pi 历史时，启动器按新 CWD 派生会话并保留源 transcript；旧消息中的绝对路径和外部文档引用保持原值。项目使用流程见 [运行时参考](runtime-reference.md#会话与消息)，接口见 [Product API](product-api.md)。

## 外部 Main 容量

外部 Main 的运行名额与排队是执行主机的本机事实，保存在数据根的 `main-capacity/state.json`（默认 `~/.atria/runtime/main-capacity/state.json`，权限 0600）：本机 external 会话的 Task 索引、正在占用名额的 Run 与进程、以及等待中的需求（含已接受输入、尝试次数、退避时间与最近失败原因）。它不进入共享项目数据，也不在项目数据库备份快照内；进程结束后由程序释放名额并推进队列，重启时只核对本机自有进程。运行记录与 Main 会话归属仍以共享会话和 Task 为准。

## 项目经验数据

独立项目经验位于 `ATRIA_HOME/project-experience/<sha256(catalog-path, projectId)>/`，正式经验不写入项目源码、Task 目录或个人记忆文件；独立 Pi CLI 的当前轮有界证据另存为所属 Task 的 `runs/<runId>/experience-evidence.json`，供后台读取。目录含权威 `experience.json`（经验、候选、版本、来源、引用队列、额度和去重）、轻量 `profile.json`（只含正式经验及技能目录）与重启发现用 `identity.json`。

启用技能单独发布到私有 `skills/<uuid>/SKILL.md`，停用、删除或关闭使用会撤回可加载文件；不覆盖项目手工 `.pi/skills/`。

稳定项目身份在工作目录调整后保留已沉淀知识；catalog 不同的同名 ID 隔离，缺少稳定 ID 时使用目录哈希。临时工作区和内部 holding Task 不参与项目沉淀。存储采用私有权限、短超时可恢复锁、版本检查和原子替换，损坏文件保留并停止加载。备份整个目录，其中包含本地明文来源引用；恢复时与所属项目 catalog 一并保护。具体容量、开关和验证限制见[项目经验与技能](project-experience.md)。

## 应用资源与 Task

```text
<application-resource-root>/
├── applications/
│   ├── instances/index.json           跨 Task 的应用窗口实例索引
│   └── <appType>/
│       ├── files/<path>               内部资源文件
│       └── resources/<resourceId>/
│           ├── metadata.json          revision、contentVersion、路径等
│           ├── operations.jsonl       操作历史
│           └── selection.json         最新选区
├── .runtime/applications/transactions/ 资源事务恢复记录
└── .runtime/applications/renames/      资源重命名恢复意图

<task-storage-root>/
└── <taskId>/
    ├── task.json / task_events.jsonl   Task 状态和事实
    ├── inputs/<uploadId>/             用户原始附件与校验元数据
    ├── artifacts/                     普通最终交付文件
    ├── visual/images/                 不可变图片与 v1 元数据，裁剪映射和历史来源
    ├── visual/downloads/              Browser Use 接受的下载文件与返回的 hash 证据
    ├── applications/
    │   ├── mapping.json               对共享资源的引用
    │   ├── manifest.json              实例与绑定状态
    │   └── instances/                 旧版实例文件，保留兼容读取
    ├── agents/
    │   ├── main/context/              messages.json、memory.md、state.json
    │   ├── main/work/                 草稿、脚本、中间材料
    │   ├── main/project-execution.json Main 启动与进程存活租约
    │   ├── coordinator/               调度私有工作目录
    │   └── subagents/<id>/
    │       ├── work/
    │       ├── deliverables/          待 Main 验收的候选文件
    │       └── logs/
    ├── sessions/<agent>/<run>.jsonl    Trace
    ├── sessions/<agent>/<run>-requests.jsonl 模型请求、prompt、工具定义和响应
    ├── sessions/main/request-retry.json 最新 Main 模型请求的私有重试快照
    ├── sessions/main/pi/              Main 原生 Pi 会话
    ├── runs/<runId>/                  Run 事件、队列、Inbox、checkpoint、结果、main-input.json
    ├── experiments/                   运行时实验记录
    ├── watch/ / virtual-agents/        持久监控控制面
    └── .runtime/                      Task 锁与产物索引等
```

以上是按需创建的目录概览，两个根不要求相同。资源文件、资源元数据与事务记录归应用资源根；窗口实例索引归应用资源根；`task.json`、`mapping.json`、`manifest.json` 与实例加载关系归真实 Task 存储根。资源归应用，不归对话；多个 Task 用 `mapping.json` 引用同一资源，绑定到另一对话不搬移文件，也不删除原对话引用。通过 Task API 读取资源前必须检查引用存在；本机的引用检查不等于远程多用户授权。

Task 初始化会创建 `agents/main/work/`，在 Main 首次模型请求前即可访问提示中的工作目录。恢复旧 Task 时补建缺失目录，已有草稿、记忆和产出物保持原内容。

`visual/images/` 保存工具读到的图片、原生和浏览器截图，引用只属于当前 Task。版本 1 元数据与像素 hash 校验，完整写入后原子发布；中断残留计入限额，不自动删除旧图。图片可能包含用户内容，随 Task 一起备份保护；恢复历史图片不会恢复窗口授权或动作凭据。限额及接口见 [视觉观察](visual-observation.md)。

`visual/downloads/` 保存 Browser Use 接受的下载，使用随机前缀与清洗后的文件名；工具返回 Task 相对路径、字节数和 SHA-256。浏览器关闭保留已接受文件；取消或失败只删除本次创建的未完成目标。内容属于用户 Task，备份时一起保护，正式交付仍通过产物工具发布。浏览器 cookie/profile、pageId 和脚本 `state` 只在当前运行时存活，重启后不从这些文件恢复。详见 [Browser Use](browser-use.md) 与 [CUA 脚本](cua-scripting.md)。

`workspace`（kind 为 workspace）是尚未关联对话的应用窗口容器，不作为用户对话展示。新独立窗口的 holding Task 与目标对话一样保存在 Dashboard 默认的真实 Task 存储中，不在项目资源根新建 Task 或 manifest；旧项目目录中的 holding Task 不搬迁，保留旧引用兼容读取。项目目录中的独立应用关联到用户数据目录中的对话时，可以交接其引用与窗口，无需把 Task 放到项目目录；普通对话间共享仍保留原引用。实例保存窗口状态，全局 Tab 索引保存导航状态，二者不是资源所有权。

`ApplicationService(resourceWorkspaceRoot, registry?, taskStorageRoot=resourceWorkspaceRoot)` 分别指定资源根和 Task 存储根；省略第三参数保持同根调用兼容，Dashboard 新独立窗口显式传入默认 Task 存储根。`InstanceStore` 的窗口索引在资源根，Task manifest 在 Task 存储根，并在活动实例跨根时记录 `workspaceRoot`。`ResourceMappingStore(taskStorageRoot, resourceWorkspaceRoot)` 将 mapping 写入 Task 存储；新跨根引用记录 `workspaceRoot`，旧引用没有此字段时按 Task 存储根解释，不原地改写旧引用。

`taskApplicationWorkspace(taskStorageRoot, taskId)` / `applicationServiceForTask` 从持久绑定恢复活动资源根，不能按最新 `projectDirectory` 把旧绑定迁到新目录。

未加载应用的会话默认在项目 `projectDirectory` 下创建新资源；新文件的默认项目归属来自发起会话，即使该会话同时引用其他根的文档。

资源元数据和实例可保存 `project` 创建快照（`projectId`、`projectName`、`projectDirectory`、可选 `projectCatalogPath`）；`null` 明确表示无项目归属，旧记录缺少字段时保持兼容。归属与实际资源根分别保存，引用、加载和跨会话共享不改属、不搬移文件。工作台 Tab 的 `workspaceRoot` 是实际资源根，`project` 是归属；显示名称读取已提交项目索引以跟随重命名，目录快照和物理文件保持原值。独立窗口从所选项目取得归属，在没有项目记录的目录打开则保持无归属。没有明确归属的历史内部存储目录不能仅凭目录名称冒充项目。

会话另开新空窗口时也采用项目目录默认根，已加载的旧文件保持原根；复用既有空窗口保留该窗口原根。升级前缺少 `project` 的空窗口创建文档时，按窗口实际根的项目记录恢复归属快照；明确的 `null` 保留无归属，操作它的会话不会重定归属。

`project` 是归属判定来源，资源和 Tab 的 `projectId` 是兼容别名。旧记录只有 `projectId` 时按稳定目录册身份读取，目录被另一个项目复用也不会改属；`project: null` 优先于旧 ID 和目录匹配。宿主通过 `ApplicationService` 第四参数传入新建项目默认值；旧直接调用仍尊重显式资源根的文档上下文。读取兼容数据不改写元数据或移动文件。

旧迁移项目仅在仍有会话或有效应用文档证据时出现在项目列表；只有归档会话且没有应用的分组由前端隐藏。合法显式空项目继续显示。holding Task 查询不登记项目；空工作区、旧测试目录和已失去历史/文档的迁移记录不成为空项目。过滤是只读展示，不删除目录、文档、会话或 `projects.json` 中的旧记录。应用根发现同时读取项目目录及已保存的 mapping/manifest 根，目录设置改变后仍可找到原位置的资源，且这些资源根不会自动作为新的 Task 存储根。

应用根发现跳过损坏或不可读的单个 manifest 线索，保留原文件，并继续从目录册、mapping 和其他有效 manifest 发现资源根。全局会话/项目列表与其他有效资源保持可访问；直接使用损坏的绑定仍报告原有诊断，不自动改写用户绑定。

`runs/<runId>/main-input.json` 以版本 1 保存 Main 启动前接受的完整输入及 `submittedAt`（毫秒时间戳），新记录另保存主动来源 `source`、`messageId`/Task/Run 身份、原始 composer `body` 和附件引用，权限为 600。无新消息的续执行沿用这条记录；启动失败后仅补回 Pi 历史中尚未保存的原始输入。旧 Run 没有这个文件时仍可从已有 Pi 会话恢复。该记录包含原始请求和附件引用/内容，应与会话工作区一起备份。

`sessions/main/user-inputs/<messageId>.json` 另外持久保存主动提交的原始 body、附件与稳定消息身份，避免同一 Run 的后续内部输入覆盖可编辑来源。启动未接受的输入会标记为拒绝，不作为最新可编辑消息。

`runs/<runId>/goal-delegation-request.json` 以版本 1 保存已交给模型的当前用户请求身份和旧归属的兼容边界，权限 600。身份取自持久 Pi 用户消息或已交付的用户 Inbox 消息，不使用每次 HTTP 调用都会变化的模型 `requestId`。新的用户消息可以推进边界；模型轮次、压缩、后台事件及无新消息的续执行不能解除原请求的交接限制。

`runs/<runId>/goal-delegations/<programId>.<requestHash>.json` 原子保存交给其他 Main 的目标归属（`taskId`、`programId`、可选用户 `requestId`，权限 600），不同用户请求保留各自收据。同一请求不能省略目标身份另建替代采集器；暂停目标的交接尝试也保留归属。旧 `<programId>.json` 及无用户身份的收据仍读取，并关联升级前请求。它不是 Inbox 接收/工作完成收据，不含提示词、密钥或另一个目标的正文；旧 Run 没有此目录时无需迁移，后续创建/交接会登记。

`sessions/main/versions.json` 使用版本 1 记录 Task、当前会话版本 ID、明确选定的 Pi session 文件、旧 Run 排除集合、此前前缀活动、历史消息/活动快照，以及修改重发的幂等身份。新 Pi 分支只包含被修改输入之前的 entry；旧 session 文件和 Run 记录保留，后续运行不靠最近修改文件猜测当前版本。`request-before-edit-<versionId>.json` 私有副本保留被替换轮次的原模型请求快照，权限为 600，不能作为新编辑输入的活动重试槽。备份应包含版本索引、所有 session 与这些私有恢复副本，不能仅复制当前消息列表。

新版本将历史正文和活动单独写入私有 `sessions/main/message-versions/<versionId>.json`（权限 600）；版本索引只保存历史文件名、当前对应消息、分组、预览和活动数量。旧版内联历史仍可读取，下次编辑时迁移到独立文件；备份应同时包含这些历史文件。项目目录变更会复制当前选定 Pi 分支到新 CWD，再原子更新版本索引中的 session 指针，版本 ID 和旧记录不变。

`sessions/main/request-retry.json` 是唯一主动写入的版本 1 私有恢复槽，保存实际序列化 body、发送 endpoint、原模型/上下文和会话 ID、Task/Run/request 身份、执行环境、body SHA-256 与整槽校验和，状态为 pending/failed/completed。它保留原始用户正文、附件像素和成功工具结果，权限为 600；认证 headers 与配置密钥不保存。重放关联使用 `retryOf`，跨进程文件锁保护保存、结算及请求身份比对。

新输入清除活动槽，并写入 `request-retry.json.cleared` 标记；旧 `retry-request.json` 仅作只读兼容归档，标记防止清除后复活。

两种旧版无执行归属档案都可读取/备份，但不能精确重放；原文件不改写。历史与草稿保留，备份包含这些记录，不放进发布包。

可选 `goalDelegationRequestId` 保存该模型请求所属的用户消息身份，重放时恢复交接限制，不采用较新的会话请求身份。旧快照缺少此字段时按未知归属保守检查当前 Run 的收据，直到确认新的用户请求；读取兼容快照不会改写其历史正文。

新增 `executionScope` 保持版本 1 可读兼容，独立保存 canonical 实际工作目录和 Task 存储根；应用绑定记录 resourceId、appType、appInstanceId、真实资源来源工作区根/文件路径及 Adapter/MCP 工具名。来源根通过持久资源引用解析，与 Task 存储根区分；不从提示词文本猜测。启动和发送时校验归属，重放响应的应用工具再次校验资源来源，改变归属时拒绝执行且不生成替代请求。旧版本 1 档案没有此字段时可读取/备份，但精确重试被拒绝，原档案不会被改写。

## 引用、绑定与关闭

- 引用决定资源是否属于该 Task 的可见资源集合。
- 绑定决定下一次 Main 请求得到哪个应用的上下文与工具；引用不意味着当前一定绑定。
- 文档 Tab 以 resourceId 标识，同一文档不因多个对话引用而重复成多份。
- 关闭文档 Tab 会解除引用它的对话的活动绑定；资源与引用仍在，可再次打开/绑定。
- 解绑不删除资源。对话引用失效也不应触发资源文件删除；资源删除/清理的新功能需单独定义生命周期。

当前索引与绑定行为见 [应用服务](../src/applications/application-service.ts)、[应用路由](../src/dashboard/application-routes.ts) 和 [WorkbenchTabStore](../src/applications/tab-store.ts)。

固定加载改动回退后，已有 v3 实例索引与 v4 会话清单继续按现存身份、资源引用和 `workspaceRoot` 读取，不用旧备份覆盖新版期间保存的文档或会话。加载关系重新允许各会话独立切换和卸载；写入仍使用可切换加载的清单格式。迁移留下的备份保留，验证见 [回退数据兼容回归](../test/application-load-rollback.test.js)。

## 产出物与草稿

产出物面板组装两类对象：可编辑的共享资源，以及当前 Task `artifacts/` 中的普通文件。API 的 `artifacts` 数组只包含普通交付文件；应用资源从 `applications` 索引读取，不混入文件扫描。

用户要参与修改的对象用应用协议创建；只供下载的最终文件写入 `artifacts/`；中间材料放 Agent 私有 `work/`，Subagent 候选输出放 `deliverables/`，由 Main 验收后放入正式交付目录。当前资源保存无需额外发布步骤；下载副本使用 `/resources/:id/download`，已移除旧 `/export` 发布路由。

支持编辑的 `artifacts/` 文件从对话链接或产出物面板点击后直接在应用中打开；其他格式继续提供预览与下载。对话中的绝对文件链接按 Task 的 `storageRoot` 和已登记产出物解析，项目目录不作为产出物根。

普通文件首次导入编辑时创建应用资源副本，元数据 `importedArtifact` 保存来源 Task 存储根、Task ID、相对路径和 SHA-256。相同来源与字节再次打开时先复用这份资源，保留用户修改，无需重新转换；源文件更新后可导入新副本。创建中断后重试会恢复已落盘资源的对话引用。

面板将已导入的当前文件、同一文档的可编辑导出格式和编辑资源显示为一项，提供原文件下载；PDF 等只读预览继续单列。原文件仍保留在 `artifacts/`。旧资源没有来源记录时不按名称合并，也不删除历史副本。

要保留外部原文件位置，使用应用服务的外部文件接入路径；元数据用 `externalPath` 指向原文件，受路径保护检查。

来源根以 `importedArtifact.storageRoot` 的真实路径保存，兼容读取早期 `workspaceRoot` 字段与符号链接别名。并发导入共用 Task 的 `applications/artifact-import.lock`，进程中断后按已确认死亡的锁拥有者恢复。

导入创建期间，资源元数据目录暂存 `creation.json`，记录初始内容和资源身份，内容落盘后移除。宿主若在元数据或内容写入前中断，恢复会补齐同一资源；目标文件若已被独立修改，保留文件并报告 `resource_recovery_required`，不会覆盖它或另建副本。

## 外部修改、并发与恢复

用户和 Agent 的协议写入均带 baseRevision，版本冲突返回 409，重试使用相同 operationId 保持幂等。专用应用工具返回操作，由应用服务统一提交；不要绕过协议用普通 write 覆盖共享文档。

外部软件或普通文件工具仍可能直接改原文件。读取时检测 contentVersion 变化，推进 revision 并记录 `workspace.external_change`；再次编辑前要重读，未提交的草稿保留。协议锁无法约束不遵循该锁的外部进程，不能据此宣称跨软件绝对原子写入。

内容写入中断后，若文件已经匹配待提交内容但元数据尚未提交，恢复会补齐元数据与原操作日志，保留 operationId、撤销信息和重试幂等性。重命名先持久化 `renames/<resourceId>.json`，记录原路径、目标路径、内容版本和原文件身份，再移动文件并提交元数据。恢复核对路径、hash 与文件身份；旧文件名被另一文档复用时，原资源仍指向确认过的新路径。身份或内容无法确认时保留两边文件与恢复意图，返回 `resource_recovery_required`，不猜测归属或覆盖独立修改。

内部路径和外部文件的 IO/校验在 [resource-files.ts](../src/applications/resource-files.ts)，版本/操作/事务恢复在 [resource-store.ts](../src/applications/resource-store.ts)。

资源操作历史由 [operation-history.ts](../src/applications/operation-history.ts) 流式读取。小事件仍内联在 `operations.jsonl`；超过 16 KiB 的新事件使用显式 `atria.operation.v1` 日志头，完整内容保存在资源目录的 `history-blobs/<sha256>.gz`。事件中的大字符串按 JSON 编码内容寻址，重复媒体在正向操作、逆操作和后续保存之间共享。

引用内容先持久化再提交日志，读取校验 SHA-256 与普通文件边界；丢失或损坏时返回带路径的恢复错误。

历史页同时受条数和累计 8 MiB 预算约束；最新单条超过预算时仍完整返回，`hasMore` 表示还有未返回的历史。幂等查找、撤销只加载目标事件，保留全部历史与原有逆操作。旧内联 JSONL 逐行兼容读取，不自动迁移或删除；单条历史记录的安全上限为 128 MiB，pending 事务仍使用原 version 1 格式。备份必须包含 `history-blobs/`；旧版本不支持新外置记录，不能直接降级读取新历史。不同媒体与快照仍会增加磁盘占用。

## 全局索引与桌面数据

App、CLI 和源码 Web 默认共用 `~/.atria/`，`ATRIA_HOME` 可整体覆盖。工作区目录索引在 `runtime/workspaces.json`，Tab 索引放在同级 `workbench-tabs.json`。仅覆盖 `COWORK_WORKSPACE` 不会自动迁移这些全局索引；独立多实例测试需同时使用独立索引：

```sh
COWORK_WORKSPACE=/tmp/atria-dev \
COWORK_GLOBAL_INDEX=/tmp/atria-dev-index/workspaces.json \
COWORK_TABS_INDEX=/tmp/atria-dev-index/workbench-tabs.json \
COWORK_UI_PORT=3881 npm run ui
```

默认用户目录布局如下；运行 `coworkos data paths` 查看实际路径：

```text
~/.atria/
├── workspace/              默认工作区
├── runtime/
│   ├── workspaces.json     全局工作区索引
│   ├── projects.json       项目名称、稳定 ID、工作文件夹及更新恢复意图
│   └── workbench-tabs.json 全局 Tab 索引
├── pi/                     App 与 CLI 的 Pi 可变状态
├── config.json             CLI / Web 模型配置，权限 0600
├── model-config.json       模型配置列表与启用项
├── credentials.json        执行主机的模型与搜索密钥，权限 0600
├── client-sessions.json    桌面客户端按后端加密的会话凭据
├── model-secret.bin        旧单组 macOS 加密密钥，迁移后保留用于恢复
├── composer-drafts.json     跨端口恢复的对话草稿/文本附件，仅指定前缀
├── computer-policy.json     桌面全局窗口授权策略；不保存临时会话/截图
├── data-version.json       格式/创建/最近打开版本
├── logs/
└── imports/<name>/         显式导入的旧版数据，独立工作区
```

开发 App 与正式 App 共用这个目录及单实例锁，因此不能同时打开两个默认桌面实例。`COWORK_DESKTOP_DATA` 可用于独立桌面测试目录，`COWORK_WORKSPACE`、`PI_CODING_AGENT_DIR` 和索引覆盖仍优先。

应用资源根、所选项目和外部资源可能位于用户目录之外；完整备份须同时覆盖真实 Task 存储根、相关应用资源根和外部原文件。分离路径不会自动迁移或删除旧 Task、绑定或资源。替换或删除 App 程序不删除该目录；清理工具或手动删除用户数据会影响留存。退出/重启/升级约定见 [Mac 指南](mac-release.md)。

首次打开使用默认用户目录的新版桌面时，若统一目录尚无 CoworkOS 数据，会从该入口对应的旧 `~/Library/Application Support/Atria/` 或 `Atria Dev/` 暂存复制再提交。显式设置 `ATRIA_HOME` 或 `COWORK_DESKTOP_DATA` 时跳过自动复制，保持独立测试目录；需要的旧数据仍可显式导入。迁移保留旧目录、调整内部工作区索引与控制路径，失败可重试；不会合并或覆盖已有统一数据。另一旧桌面目录和源码 `.tmp/` 可在停止全部相关运行后显式导入：

```sh
coworkos data import --from "$HOME/Library/Application Support/Atria Dev" --kind desktop --name old-dev
coworkos data import --from /path/to/checkout/.tmp --kind workspace --name old-source
```

导入结果位于 `~/.atria/imports/<name>/`，工作区会登记到统一历史索引；重启 App 即可查看。重复名称会拒绝覆盖。用户文档、原始消息和旧绝对路径文本保持原内容；外部项目原文件不会搬移。需要从导入的 CLI 原生会话续聊时，使用返回的 `workspaceRoot` 和 `piAgentDir` 设置 `COWORK_WORKSPACE`、`PI_CODING_AGENT_DIR`，再运行 `coworkos --resume`。未迁移的数据也可用旧目录的这些显式覆盖继续恢复，不必删除或移动原目录。

新版开发与正式桌面显示 CoworkOS / CoworkOS Dev；客户端会话使用 `CoworkOS Client` 钥匙串身份，旧模型凭据迁移使用 `Atria`。旧开发版的 macOS 加密密钥可能因原身份不同而无法解密；密文和源目录保留，界面仍可打开并重新输入密钥。真实钥匙串迁移与跨版本签名身份兼容需独立原生验收。

`computer-policy.json` 由可信桌面 IPC 原子写入，权限 600，格式为 `{ "version": 1, "policy": { "enabled": false, "mode": "observe" } }`。设置中的窗口访问按钮始终写入 mode=control；旧版已开启的 control 策略保留，旧版仅观察策略恢复时关闭并提示重新开启，原文件不改写。只有 enabled/mode 跨重启恢复；PID、窗口 ID、sessionId、observationId、截图和临时控制权均不持久化。缺失、损坏或未知版本默认关闭，并保留原文件供恢复；旧五分钟手动会话不迁移为全局授权。详见 [Computer Use](computer-use.md)。

`composer-drafts.json` 是私有本机草稿快照，权限为 600，包含版本、来源 origin 与 `atria.composer.v1:*` 条目；不包含其他 localStorage 或模型凭据。编辑草稿使用版本 4，在同一会话条目中保存编辑目标/幂等身份与原未发送草稿（正文及附件）；较旧宿主拒绝覆盖版本 4。取消或接受重发恢复原草稿，后台返回不更改当前选中的其他会话。

当前预算 16 MiB，写入采用临时文件原子替换，损坏记录保留 `.invalid-*` 副本，未来版本拒绝覆盖。普通 Web 服务仍使用 origin 内的 localStorage，不写该桌面文件。

## 旧产物目录迁移

停止旧版运行并备份 workspace 后执行：

```sh
npm run build
node scripts/migrate-artifacts.mjs --workspace /path/to/workspace --task <task-id>
```

省略 `--task` 处理全部 Task。脚本依据旧 manifest 识别框架日志和候选文件，移回 Agent 私有目录，并导入旧 Main deliverables；保留旧清单与迁移记录，不覆盖冲突文件。它只处理该产物布局迁移，不是应用资源或桌面全部数据版本的通用升级器。当前普通扫描不会自动把候选文件发布成产物。

## CoworkOS 会话导出格式

`coworkos session export`、交互 `/export` 和 RPC `/coworkos-export` 使用同一产品序列化器。JSON 顶层为 `schemaVersion: 1`、`format: "atria.session"`，包含 `producer`（CoworkOS 版本及真实 Pi 依赖版本）、`exportedAt`、`session`（sessionId、项目目录、可核对的 taskId/runId）、`task`、`messages`、`toolCalls`、`events` 和 `artifacts`。

消息保留 messageId、parentEntryId、时间、inCurrentBranch、role、content、instructionSections 和 metadata；metadata 保留工具 details、模型响应 ID、usage、系统工具增删，以及 bash 的 command/output/exitCode 等事实。自定义提示消息也保留类型和 details。工具调用按父节点谱系关联结果，`resultMessageIds` 保留全部有效结果，`resultMessageId` 优先当前分支，未返回的调用标为 unresolved。非消息事件保留事件类型和原数据。旧任务 ID 和会话分支不会因产品品牌更新而改写。

`artifacts` 仅引用现有 `.runtime/artifacts.json` 的注册元数据，不包含文件字节，也不为导出执行扫描或迁移。未能核对会话文件与 workspace 的绑定时，不猜测 Task 关联。凭据字段与所选配置及执行主机凭据存储（`credentials.json`）中的模型、视觉和搜索凭据脱敏，包括环境变量覆盖；其他正文和路径仍保留。新建和强制覆盖的导出文件均使用 600 权限，覆盖时先限制权限再写入会话内容。各分支的记录须有唯一 ID、有效父引用，且父引用不能形成循环；异常记录在导出前拒绝，源文件和已有输出保留。HTML 展示当前分支，另附全部分支的审计数据；用户内容始终转义为文本。

该格式用于阅读、分享和审计，不作为 Pi 恢复输入。内部 JSONL、checkpoint 和请求归档保持原格式，旧会话迁移只发生在导出临时副本中。导出不能替代完整备份：恢复仍需原生会话、工作区和外部项目文件；旧历史未保存的事实无法补回。原生 RPC `export_html` 仍属于引擎兼容接口，产品导出使用 `/coworkos-export`。

## 用户上传的输入文件

输入框支持选择、拖放图片/PDF/DOCX/PPTX/XLSX/UTF-8 文本，及粘贴截图。单个附件最多 25 MiB，每条消息最多 10 个、合计 100 MiB。原始字节先保存到全局 Task 索引同目录的 `uploads/<uploadId>/`，发送时校验 SHA-256，再复制到该 Task 的 `inputs/<uploadId>/original.<ext>`。输入材料不进入产出物面板。

草稿只保存附件元数据和 uploadId，桌面草稿格式 v3 可跨端口恢复，并兼容旧文本草稿。已完成上传后才允许发送或关闭窗口；切换对话会取消尚未完成的上传。删除附件按钮只解除该草稿的引用，不删除历史消息使用的原文件。当前未实现未引用上传文件的定期清理。

Main 的 `read_attachment` 工具按格式读取，支持文字分页、PDF 页面和图片视觉输入；模型未启用图像时会返回明确提示。PDF/Office 解析使用本机 Python 3 与 pypdf/PyMuPDF/python-docx/python-pptx/openpyxl；缺失依赖时原文件与下载仍可用，不会将二进制文件误当作文字发送。图片预览无需这些依赖。PDF 页面按需渲染，Office 预览为提取文字，并非完整排版预览。

## Watch 分析与通知恢复

Watch 的分析队列在 `payload.activateRun` 保存 `false`，Coordinator 恢复时沿用该值，只创建分析 Run 的目录，不认领 Task 的活动 Run 或改写完成标记。普通委派及没有该字段的旧队列保留原有行为。该约定防止新的监测分析覆盖 Main 归属，不自动修复旧版本已经改写的 Task 元数据。真实 Coordinator/Pi 与本地假模型回归见 [监测 Run 归属](../test/watch-coordinator-routing.test.js)。

Virtual Agent 的 `monitor-state.json` 可包含兼容性可选字段 `pendingWake: { runId, message, controlMessageIds? }`。`lastEventId` 表示分析结果已保存，`lastWakeAt` 表示通知已写入 Main Inbox；两者不可互相替代。投递前先保存完整通知，重启只补投该结果，使用相同 messageId 保留已消费回执；控制消息在通知交付后确认。暂停 Program 保留 outbox，恢复后继续投递。旧记录没有此字段时仍可读取；无法重建旧版本已丢失且未保存的通知。行为回归见 [独立进程恢复](../test/watch-supervisor-recovery.test.js)。

修改重发使用 `sessions/main/edit-transaction.json` 私有版本 1 journal，在改写版本索引之前保存原 Task、版本索引、Main context、原 exact-retry 槽和 cleared 标记。

`prepared` 阶段崩溃后，Dashboard 重新列举或定位 Task 时恢复这些原始字节，拒绝未启动的新输入，保留分支、Run 和失败输入证据。

`launch_ready` 阶段已完整持久化新输入、Task/Run 和新分支；此后 spawn 可能执行过文件或外部动作，恢复会保留已接受的新版本并把孤立的 running Run 置为 waiting，不回滚外部动作。幂等重复请求返回真实 Task 状态，不将 waiting 声称为 running。事务结束后 journal 归档为 `edit-transaction-<runId>.json`，备份须包含这些私有恢复证据。
