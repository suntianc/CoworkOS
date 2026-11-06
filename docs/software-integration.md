# 软件、GUI 与执行权限接入

TXT 已可用，软件 v2 和 GUI 的交付范围见下文。软件变更的验证要求见 [本地测试](testing-local-run.md)。

## 两代编辑协议

`src/software/contracts.ts` 定义独立 v2：异步 `read/apply/close`，revision 是不透明字符串，可承载 hash 或远程 ETag；资源目标与内容用判别联合表示：

| kind        | 目标                    | 内容                             | 驱动必须负责                            |
| ----------- | ----------------------- | -------------------------------- | --------------------------------------- |
| utf8-file   | path                    | text                             | 编码、写入原子性、版本冲突              |
| binary-file | path + mediaType        | Uint8Array                       | 原始字节、大小限制、专用操作            |
| project     | root + entryPoints      | 相对路径/revision/mediaType 清单 | 文件寻址、事务/部分失败语义、撤销与迁移 |
| remote      | connectionId + objectId | schema + value                   | 连接、重试、认证、ETag、幂等与断线恢复  |

注册表只接受安装时信任的驱动；不支持的资源返回 `unsupported_resource`。`SoftwareService` 在调用驱动前检查 `software.read` 或 `software.edit`，目标标识为 `providerId:kind:identity`；远程认证保留在宿主连接管理，不进入目标或模型参数。

`BinaryFileProvider` 是实际实现的本地二进制参考驱动：授权根目录、真实路径校验、16 MiB 默认上限、原始字节读取、hash CAS、跨 Harness 进程文件锁、同步并原子替换。仅支持已有文件和 `binary.replace`，尚未接入工作台 UI、历史和撤销。

外部软件不遵循 Harness 文件锁时，仍可能在检查与替换间修改文件；需要软件原生事务或更强的文件协调后才能宣称跨软件原子 CAS。

远程类型仍是接入契约，使用测试驱动验证，不包含可用 SaaS 驱动。新增正式驱动必须补齐真实工程/连接回归，不能只声明 resource kind。

## GUI 接口

`GuiProvider` 的 `observe` 返回图像尺寸、时间和可选 accessibility 文本；`act` 只接收 activate/click/type/key 动作。驱动要自行检查目标应用、坐标、输入上限、OS 权限和取消信号。`GuiService` 把同一桌面的动作串行化，在真正执行时重新检查授权，避免队列等待期间授权过期仍执行。

`gui.observe` 与 `gui.control` 分开；读文档不等于能截图，能截图不等于能点击。授权由宿主传入的人类决定、具体 Task/目标/能力与过期时间组成。模型不能用注册工具自造 GUI 授权。审计回调只记录操作类型/结果，不记录键入的正文或密钥。

macOS [Computer Use](computer-use.md) 已装配真实单窗口驱动、桌面系统权限/授权 UI、三个 Agent 工具和 Task 级 HTTP 消费接口。它复用 GuiAction，使用独立 ComputerUse 会话管理器处理单次观察、可信桌面 IPC 和全局接管；GuiService 仍是通用宿主合同，不宣称两条授权路径统一为 OS 沙箱。当前四种动作及解锁桌面验收边界见该接口参考。

## 接入步骤

1. 定义软件对象与操作语义、支持的资源种类、权限范围和失败恢复。
2. 使用 v1 实现可同步序列化为 UTF-8 单文件的应用（文本或结构化参数），或使用 v2 实现异步/二进制/工程/远程驱动；不要改 TXT 的序列化器来承载全部类型。
3. 按需提供专用 Agent 工具/MCP，业务工具返回操作，交给文档协议应用；GUI 动作走独立驱动。
4. 补测试：旧 revision、并发写、取消、超限、退出清理、越权、重启、网络断开；工程必须覆盖部分写入失败。
5. 新增前端 Adapter 与能力发现，再更新架构、接口版本和团队负责人。

## v1 应用开发入口

应用运行时可选 `previewResource({content,options,signal})` 用于计算未保存草稿。通用 HTTP 预览入口先验证对话对资源的引用，再交给 Adapter 校验和计算；不创建新修订。浏览器断开时取消后端任务。

| 步骤                                       | 合同/参考实现                                                                                          | 注册与验证                                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| 实现资源、序列化、操作、逆操作、选区和摘要 | [ApplicationAdapter 类型](../src/applications/types.ts)、[Adapter types](../src/applications/types.ts) | 在 [builtins.ts](../src/applications/builtins.ts) 注册                                                            |
| 实现 UI 挂载、刷新、关闭与草稿恢复         | [Workbench Host](../web/assets/workbench/host.js)、[UI registry](../web/assets/workbench/registry.js)  | 在 [前端 registry](../web/assets/workbench/registry.js) 注册                                                      |
| 提供模型适用的领域工具                     | Adapter 的 agentTools 或 [MCP client](../src/applications/mcp/local-api-client.ts)                     | 工具返回操作，交由服务执行 CAS/历史；绑定后才激活                                                                 |
| 验证平台未写死领域语义                     | [Dummy Adapter](../src/applications/adapters/dummy-counter-adapter.ts)                                 | [注册表合同测试](../test/application-registry.test.js)、[应用工具测试](../test/application-adapter-tools.test.js) |

核心服务、路由、页面装配不添加 appType 分支。保持资源读取与摘要属于应用；平台负责版本信封、引用、绑定和操作记录。修改 TXT 保存行为先在不依赖 DOM 的 [document session](../web/assets/workbench/host.js) 实现和验证。

应用定义可声明 `creationHint`，向尚未打开该软件的 Agent 解释新建格式与默认内容；`entryReadTool` 指定一个接受空参数的读取工具。`create_resource` 支持文本字符串或结构化对象，在返回前绑定并刷新领域工具；返回 `editorOpened`、`bound`、`availableTools` 和可选 `nextAction`。只在读取工具确实启用时提供下一步调用，不把某款软件的格式与建模规则硬编码进通用桥接或全局提示词。

接入测试需覆盖“未打开应用的新对话 → 创建 → 下一次模型请求使用新工具”，不能只验证已绑定窗口。

专用工具的执行约定由 [application-tool-execution.ts](../.pi/runtime/application-tool-execution.ts) 和应用桥接实现：同一会话、同一资源从读取开始串行，跨会话仍走 CAS。基于完整旧对象替换的工具应声明 `requiresFreshRead`，同时声明参数可为空的 `entryReadTool`，桥接只用该读取入口及成功提交更新本会话观察版本；API 查询、派生预览或其他辅助工具不能替代它。桥接自动核对观察版本；内容锚定的工具仍使用各自的语义前置条件。

多个关联修改需要原子性时，由 Adapter 提供一个批量领域操作并验证最终状态；返回多个独立 operations 并不构成跨操作事务。不要让模型猜测调度顺序或手工管理专用工具的版本。

## 对话与应用的并排协作

宽度达到 1100 像素时，当前对话在左侧、打开的应用在右侧，默认对话占 42%，应用占剩余空间。对话导航保留在左侧栏，当前会话的文件在右侧工作区顶部切换和关闭，文件名与放大、更多操作共用一行。可用分隔线拖动或键盘方向键调整比例，全屏编辑、恢复并排与收起不销毁编辑器或草稿。窄窗口使用单页切换，右上角侧栏按钮统一收起或恢复工作区。新对话不继承上一对话的文件，打开其他对话的文件时同步切换所属对话；共享文件优先使用当前引用它的对话。

应用面板只展示已接入且具有编辑器的应用，不显示规划中的入口、实例归属说明或技术格式介绍。创建实例时选择工作区，实例列表可恢复已有窗口，文件在编辑器内新建或打开。工作区更多菜单中的“在对话中使用”回到同工作区的当前对话或新建对话，并加载文件；使用输入区的应用菜单也可加载文件，沿用现有绑定协议为 AI 提供上下文。编辑器不重复提供“与 AI 协作”或“关联到对话”按钮。窄窗口保留文件导航。

独立文件和空应用窗口不选择内部 `workspace` 作为对话。文件关联或切换绑定尚未完成时，发送按钮短暂禁用，Enter 也不会提交，避免模型收到缺少应用工具的请求。

布局逻辑位于 [workspace-layout.js](../web/assets/workbench/workspace-layout.js)，只管理展示与宽度；[Host](../web/assets/workbench/host.js) 管理会话文件导航、关闭、收起恢复、资源 ID、挂载与事件路由，服务端绑定仍是 Agent 接收上下文的依据。显示右侧文件不等于复制资源，也不额外创建标签。

文本应用 在每次操作成功提交后刷新对应编辑器，不必等整个 Run 完成。当前运行对话沿用 SSE 即时通知；[连接控制器](../web/assets/controllers/connection-controller.js) 每 500 毫秒检查打开实例的已提交修订，补齐独立应用、空闲对话、跨对话和 MCP 修改。检查只读元数据，不读取大型文档或重算原生预览；空实例创建首份文档后自动打开。

UI Adapter 的 `handleResourceEvent` 可返回 Promise；读取失败、忙碌或拖动中尚未观察到变更时返回 `false`，宿主会在后续修订检查中重试。成功载入或已向用户展示草稿冲突后返回 `true`；自身已经确认的修订与选区事件不重复读取文档。不能在触发异步读取时就确认通知，以免一次读取失败后长期停留在旧内容。

UI Adapter 的 `mount` 可调用 `onContextChange({ title, selection, dirty })`，提供简短的选区名称和草稿状态；TXT 显示选中字符数。宿主在输入框上方展示当前绑定文件的上下文，点击可重新打开文件；这个回调不保存、不绑定、不发送消息，也不能代替 Adapter 的选区持久化协议。

## v2 / GUI 开发入口

| 边界                                | 代码                                                                 |
| ----------------------------------- | -------------------------------------------------------------------- |
| 异步对象、内容、操作、revision 合同 | [contracts.ts](../src/software/contracts.ts)                         |
| 可信驱动注册与能力发现              | [provider-registry.ts](../src/software/provider-registry.ts)         |
| 软件授权检查与驱动调用              | [software-service.ts](../src/software/software-service.ts)           |
| 本地二进制实现参考                  | [binary-file-provider.ts](../src/software/binary-file-provider.ts)   |
| GUI 观察与有限动作                  | [GUI contracts](../src/gui/contracts.ts)                             |
| 动作串行、执行前授权复查、审计      | [gui-service.ts](../src/gui/gui-service.ts)                          |
| 宿主授予的 Task/目标/能力/有效期    | [execution-permissions.ts](../src/security/execution-permissions.ts) |
| 越权、取消、队列和版本冲突回归      | [software-boundaries.test.js](../test/software-boundaries.test.js)   |

软件 v2 尚未装配为通用 HTTP/Agent 入口；Computer Use 的专门产品入口见 [接口](computer-use.md)。正式接入需显式设计宿主生命周期、权限交互、资源发现、专用工具和 UI；不得把模型输入直接当作人类授权。新增软件先交付一个真实场景闭环，再扩展更多资源种类。

## 按文档启用工具与通用导出

`validateOperation` 可异步检查外部候选，ResourceStore 在锁内、执行 reducer 前调用；耗时建模在锁外完成。最终提交仍检查 baseRevision。

Runtime Adapter 的 agentTools 可接收可选 {content}，返回适用于当前文档的工具子集。context-builder 生成 availableToolNames，ApplicationService 按同一名单装配工具；新软件不必修改 Main 提示词。没有绑定时不注入领域上下文，切换应用时停用旧领域工具。应用绑定只影响与该文档相关的任务。

Pi 的 export_resource 是通用适配器导出入口：检查任务资源引用、使用 adapter.exportResource、通过 Artifact Store 生成真实产出文件。失败不会修改源文档，也不会创建新的应用标签。导出格式、计算与二进制生成属于 adapter，不属于通用桥接。

### 需要浏览器转换的文件

应用可用 `ApplicationDefinition.fileImportFormats` 声明 `{ mimeType, resourceKind }`，并在 UI Adapter 实现 `importFile(file)`，返回 `{ title?, content }`。通用产出物控制器按声明发现能力，读取当前任务的完整产出物，经 UI Adapter 转换后调用既有资源创建接口。Runtime Adapter 继续验证原生内容，ResourceStore 负责持久化与版本；转换失败不创建资源。

声明导入格式不会让二进制格式成为原生资源类型，也不意味着 CLI 支持对应转换。不得在 Host、控制器或路由中添加某一应用的格式判断。

普通文件工具校验符号链接解析后的实际目标及尚未创建文件的父目录；只允许当前私有目录、已授权项目和 Main 产出物目录，别名不能绕过受保护的评分代码、框架状态或安装目录。目录内的合法链接可继续读写，Main 的 `artifacts/` 路径不接受符号链接。写入使用唯一临时文件并在替换前复核目标；这是文件工具保护，不是 OS 沙箱，也不承诺隔离恶意并发进程或 `run_command` 的系统权限。
