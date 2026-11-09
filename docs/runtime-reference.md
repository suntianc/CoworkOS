# 运行时参考

简体中文 | [English](en/runtime-reference.md)

本页维护工具、委派、恢复与监控的运行契约。模型和预算见[配置参考](configuration-reference.md)，持久文件见[数据布局](task-workspace-layout.md)，HTTP 字段见 [Product API](product-api.md)。

## 会话与消息

项目文件夹用于文件和命令操作，会话历史和恢复数据另存于用户数据目录。项目目录变更不搬移历史或外部文件，原有绝对路径和文档绑定仍指向原位置。路径与归属见[数据布局](task-workspace-layout.md#项目与会话归属)。

App/Web 的文字、附件和编辑草稿按项目或会话分别持久保存。运行中提交的普通消息排队；补充指令在下一次模型调用时投递，当前调用或工具先执行完。停止取消未完成的执行，保留草稿及已经产生的文件修改。

编辑最近一条消息会使用原会话前缀和新输入重新执行；此前文件修改和外部操作不会撤回。失败请求的精确重放见[请求重试与上下文恢复](#请求重试与上下文恢复)。

## 输入格式

### 数学公式

Web/App 支持行内 `\(...\)`、`$...$` 与独立公式 `\[...\]`、`$$...$$`。代码和无法排版的公式保留源码；终端不提供公式排版。

## 通用能力与按需工具

终端和 App 的 Main 共用 Cowork 扩展与能力规则。低层 `single` 使用显式单智能体工具工厂，不自动获得 Main 的委派或应用工具。Coordinator 可接收外部 `capabilityProvider`。

`enable_tools({})` 查询可用工具组，`enable_tools({groups:["applications"]})` 加载应用工具。显式加载随 Main Run 恢复；附件、引用资源和已授权任务也可按上下文启用工具。加载不代表授权，jobs 仍需 `longRunning`，电脑操作仍逐次核对有效授权。

Browser/CUA 对象属于当前 Pi 会话，退出或切换时清理。恢复工具组不会恢复浏览器页面或脚本对象，普通子智能体也不自动继承它们。操作与权限见 [Browser Use](browser-use.md)、[Computer Use](computer-use.md) 和 [CUA 脚本](cua-scripting.md)。

前台命令的取消、超时或输出超限会结束受管进程组；命令结束时也会清理未登记的残余进程。自行创建新会话或进程组的后代不在此范围，Windows 只管理直接命令进程。跨工具调用继续运行的命令使用 `start_job`，通过 `check_job` 查看。停止 Main 当前轮次不会自动取消已委派子智能体，需显式 `cancel_subagent`。

`run_command` / `run_tests` 的非零退出、启动失败和超时返回工具错误。`cwd` 使用相对目录，默认按当前智能体的工作目录解析；启用项目写入时才以项目目录为默认。Main 和子智能体的私有工作目录可能不同。

这两个工具没有交互式输入：实际命令的 stdin 为空设备，读取到 EOF 即自行结束，不需要取消；显式 shell 重定向和管道仍使用命令自身提供的数据。宿主进程之间的 stdin 只作生命周期信号，不传给实际命令。

内置 `run_command` / `run_tests` 分别把 stdout、stderr 的原始字节写入当前智能体的 `logs/commands/<id>/`，每条流默认最多 64 MiB；超过硬上限会停止命令并返回错误。返回的 `stdout` / `stderr` 默认各保留最多 8,000 字节的头尾预览，省略提示计入预算；预览截断本身不会中止命令。取消、超时和写盘错误仍保留已有输出及可用日志；日志写盘失败返回工具错误，同时保留已观察到的真实命令退出码，包括 `0`。

命令结果保留退出状态、`stdoutBytes` / `stderrBytes`（管道已观察字节）、`stdoutLogBytes` / `stderrLogBytes`（实际写入日志字节）、预览截断标志和日志引用。`stdoutPath` / `stderrPath` 通常相对 Task，使用 `browse_workspace({mode:"read",path,offset})` 按字节偏移分页；Task 与智能体目录不同时另有 `stdoutReadPath` / `stderrReadPath` 供 `read_file` 使用。独立程序化根使用 `logPathBase:"agent"` 明确路径相对智能体。日志超限或写盘失败时，已落盘日志可能不完整。

`createBuiltinTools` 的 `commandMaxLogBytes`、`commandPreviewBytes` 可分别调整每流硬上限和预览字节预算。未指定 `commandMaxLogBytes` 时，显式 `maxOutputBytes` 仍覆盖原有命令硬上限；文件读取默认 128,000 字节的行为不随命令默认值改变。这套预览和日志机制不改变 Main 原生 `bash` 的 SDK 行为。

## 显式委派资源与候选验收

普通 `call_subagent({task,mode})` 保持有效。应用绑定、附件和桌面权限不会全部自动继承，需要显式共享范围：

```javascript
call_subagent({
  task: "核验此装配的部件与运动参数，返回证据",
  mode: "async",
  resources: [{ resourceId: "已引用的资源ID", access: "read" }],
  attachments: ["明确共享的upload ID"]
});
```

`read` 提供适配器声明的只读工具；`candidate` 允许编辑私有副本。内置适配器提供这些能力，第三方窗口 MCP 工具不自动委派。附件读取只接受已共享的 ID。只有一个资源支持工具时可省略资源 ID，多资源同名工具须明确指定。

候选编辑返回 `saved:false` 和 `candidatePath`，连续操作在同一副本累计。Main 检查候选与证据后调用 `accept_resource_candidate({candidatePath})`。验收核对持久授权和基准版本，以一次原子修订提交完整操作序列。冲突返回 `revision_conflict` 并保留双方内容；重新读取和委派，不能修改基准版本强制覆盖。

队列恢复沿用原授权，不依赖 Main 当前绑定。资源授权不扩大 Task 文件或命令权限；缺少能力提供器时明确失败。子智能体运行成功或总结不能替代候选验收。

### 执行角色、工作项依赖与需求现场

委派默认以 `executor` 角色运行，审查使用 `role: "reviewer"`。两个角色在前置工作结束、即将创建会话时读取执行主机的角色配置：显式传入的 `profileId`/`model` 优先，其次是该项目的覆盖，再是主机默认；都没有时沿用 Main 本次 Run 的连接，普通 `call_subagent({task,mode})` 行为不变。选择以非敏感快照写入 `call.model_selected`，只在真正启动时记录；排队期间修改绑定会作用于该工作项本次启动，删除引用则让它以包含角色、范围和连接 ID 的错误结束，不会改投其他账号。启动后的请求保持原连接，后续配置变更只影响之后启动的工作项。密钥留在执行主机，不进入工作项记录、回调或界面响应。

`dependsOn: ["<callId>", …]` 声明前置工作项。前置未全部结束前，工作项保持排队（界面显示等待前置），不发模型请求、不建检查点；前置完成后继续执行，前置失败或取消则本项不执行并以原因结束。取消某个工作项只结束它自己（包括仍在等待前置的工作项，状态立即显示已取消而不是排队），其他工作项、Main 和回调不受影响；重启后从持久队列恢复依赖与角色请求，无法重新进入的工作项以失败结束并保留原因，不会反复重试或被静默丢弃。

传入 `developmentId` 时，工作项在需求现场的独立执行现场运行：从本后端 `project_development` 记录中的 ready 需求现场按当前提交分出该工作项自己的 `git worktree` 与分支（`<需求现场同级的 work-items>/<callId>`），作为该 Subagent 的项目目录。并行工作项互不覆盖，也不会写入需求集成现场或用户原工作树；现场未 ready 时拒绝委派，提示先执行 `ensure_workspace`。Main 用现有文件/Git 工具明确收取结果到集成现场；需要审查汇总结果时，在汇总后委派 Reviewer，它从汇总现场的新提交分出自己的现场。重试、重启恢复和返修沿用同一目录与分支，保留已有提交和文件，不重建或 reset。`get_subagent_status`、Task 详情给出每个工作项的 callId、名称、角色、模型、实际工作目录、依赖、阻塞状态和失败原因；界面在这些字段上显示角色、模型与独立现场。

`continueCallId`（可配 `reviewId`）是原上下文返修契约：它必须指向本 Run 中已结束的 Executor 工作项，复用该工作项的 agent 身份、检查点历史与现场，把返修任务作为同一会话的下一轮追加，而不是新建 Agent 或重复执行已终态工作。运行中的工作项、Reviewer、已有续接在运行或现场不可续接的调用会被拒绝；重启恢复沿用同一续接记录。`project_development` 的审查动作把候选提交、候选树、Reviewer 身份和现场、发现、裁定和返修关联写为共享记录；候选提交或受审内容变化后，旧结论不会被当作当前候选的有效审查。失败或漂移的审查仍可对其发现作裁定或记录返修，复审沿明确的 previousReview 链结算已验证的修复，链外发现不受影响；self 通道的自检绑定记录时的提交/树，现场前移后需在当版本重新验证。完整接口见 [Product API](product-api.md#fixed-candidate-reviews)。`request_merge` 把已满足交付资格的需求候选提交到项目共同入口，`application` 由配置的执行后端串行更新目标分支；等待期间目标前移时会在最新目标与候选的组合版本上重新运行检查。`apply_merge` 由该执行后端核对中断操作并继续队列，`merge_status` 读取操作、实际合入 SHA 与可幂等对账的回执；失败只处理操作自有现场，保留用户脏文件、先前合入和未合入分支。真实合入后程序自动写台账/看板交付：外部需求转待发布并保留归属人与实际合入 commit，内部需求只写台账。`delivery_status` 读取阶段、协作者进度、固定到交付版本的改动、检查与同步回执；共享服务暂不可达时执行主机保留本机待同步事实，恢复后按有界重试自动补齐，不要求重新开发或合入。

### 子智能体之间的单向消息

运行中的 Subagent 可以调用 `send_peer_message({targetCallId, message, priority?})`，向同一 Task/Run 中的另一个 Subagent 发送一条非阻塞消息。`targetCallId` 必须由 Main 在委派任务或后续指导中提供；消息最多 8,000 个字符，适合传递短问题、修正意见、结论或文件/产物路径。

消息先持久化到目标 Subagent 的 Inbox，再在其下一次安全模型轮次注入。工具只返回排队结果，不等待回答；目标可以自行发送另一条消息。已结束或不存在的调用会被拒绝，peer message 不建立嵌套委派或同步依赖，Main 仍负责最终验收和 Task 完成判断。

### 查询任务与委派状态

`get_task_status()` 默认只返回委派的标识、状态、回调状态和诊断路径，不重复附带子任务简报、结果正文、错误正文或产物清单。`resultAvailable` 表示已有持久回调或诊断文件，重试期间也可能指向上一轮尝试，不代表本次任务已完成或验证通过。只有回调已持久确认消费时，`resultDelivered` 才为 `true`；无回调（例如同步委派）时省略该字段，`callbackState` 为 `none`。

需要找回某次异步结果时，用 `get_task_status({resultCallIds:["<callId>"]})` 显式重读指定回调保存的正文、错误和产物路径；其余委派仍返回简要状态。查询不认领或消费 Inbox 消息，待交付结果通过原有回调或 `wait_for_subagents` 接收。同步委派没有回调正文可重读，诊断路径指向完整运行记录，应按需定向查看。

### 子智能体中断后的部分进展

子智能体失败、超时或取消时，返回结果会附带最多 6,000 字符的部分进展，包含：

- 最近两条可见说明；
- 最近六个有工具回执的文件改动；
- 最近四个已返回的工具记录；
- 最多两个结果未知的操作。

命令记录保留退出码和输出首尾，文件正文、补丁内容和思考记录不回灌，也不额外请求模型生成总结。摘录可能省略更早的工作，不能证明任务或测试已经完成；结果未知的操作须先检查实际影响再决定是否重做。

同步委派直接返回该结果，异步委派通过现有 Inbox 交付。必要时可按诊断路径定向查看完整记录。

## 请求重试与上下文恢复

Main 与子智能体默认最多自动重试 5 次，不含首次请求。Main 通常按 2、4、8、16、32 秒退避，已有 Pi 显式设置保留；子智能体可用 `maxErrorRetries` 覆盖。明确的模型不存在、认证、权限和额度耗尽不自动重试，连接测试只请求一次。`COWORK_MAX_ATTEMPTS` 是另一层委派预算。

App/Web 的“重试”重发失败请求保存的序列化正文，包括系统消息、模型、工具定义、附件和生成参数，不追加“继续”指令。成功的工具结果沿用。重放期间的新回调先排队，成功后再处理；未进入原正文的输入和文档变更不会被视为已经读取。

私有快照在请求发送前保存，校验 Task 存储根、工作目录、应用资源来源及工具归属。设置或来源变化、快照损坏、旧快照缺少归属时，拒绝精确重放并保留记录。没有快照的旧会话只能按已存上下文继续。取消优先于恢复，旧重试操作不能复活已取消运行。格式与备份边界见[数据布局](task-workspace-layout.md)。

Headless Run 恢复 checkpoint 时，若最后已是完整结束文本且没有未完成工具调用，只完成落盘，不重新请求模型。已成功的 Run ID 不能复用；新增工作使用新 Run。生命周期命令本身不等于启动模型执行。

CLI 显式 `COWORK_TASK_ID` 优先于自动关联。Task 与会话属于不同项目时拒绝恢复。未记录关联的旧会话可使用 `COWORK_TASK_ID=my-task coworkos --session <session-id-or-path>`，此后按关联继续。

### 摘要输入与输出

上下文压缩保留完整会话历史，只改变后续模型上下文。Main 与子智能体都保留历史摘要和近期原文。Main 自动压缩与 `clear_context` 沿用 Pi 的原生切点和近期历史保留；子智能体压缩沿用自己的持久摘要游标。总结器接收真正的旧摘要和本次被移除的有序历史。Main 的普通历史与 split-turn 前缀、子智能体的待总结前缀，都对工具结果使用最多 2,000 字符的摘要副本：保留调用归属、已知错误或退出状态及输出头尾，省略中间。该预算包含标签和省略提示，不改变原始工具记录或命令执行上限。摘要范围内未见匹配结果的调用另保留有界身份信息；这仅表示该范围内未见回执，后续保留消息和当前状态可以更新其完成情况。

子智能体默认以约 20,000 token 的近期原文为软目标，可在活跃长轮内部选择安全切点，不必等待新的用户消息。切点不拆分单条消息，并保留工具调用与结果配对；因此单条消息或工具配对可能使近期原文超过该目标，单条最新超大用户消息仍原样保留。

Main 当前运行阶段、待处理委派和辅助目标通过每次请求刷新的动态上下文提供，整体最多 12,000 字符；目标已出现在可见用户消息中时不重复。首次成功压缩后再加入有界辅助记忆和实验记录，不再作为旧摘要反复累计。辅助记录标明可能陈旧或不完整；运行时目标记录不等于完整用户需求副本。摘要仅概括它覆盖的历史，后续保留消息和更新后的运行状态可以改变该历史状态。

摘要继续使用原生 Markdown 栏目，合并仍有效的目标、约束、净变更、未完成事项、必要决定、验证证据和具体下一步。计划、尝试、已确认变更和已验证结果分开；未返回的工具调用记录为完成未知。验证保留命令、明确结果及已知范围，旧测试通过不能证明后续修改通过。普通摘要约 1.5–3k token、前缀摘要更短是软目标，不通过截断生成结果强制满足，也不增加模型语义审核请求。

空摘要、仅 thinking、未完整生成、失败、取消或包含工具调用的摘要不推进压缩游标；Main 原生校验与子智能体提交保护分别拒绝摘要中的工具调用。子智能体在失败或冷却时继续使用上次成功的摘要与尚未摘要的原文；没有成功摘要时保留原历史。摘要无法保证事实完整，必要时按证据引用定向核对原文件和历史；压缩前已经遗漏的内容不能自动重建。分支摘要和无法识别的请求保留原生行为。

自动压缩对同一摘要输入失败后依次冷却 5、15、30 秒，之后的失败最多冷却 30 秒；到期后只在下一次正常触发时再尝试，不启动后台重试。同一输入按模型、旧摘要/游标和待移除前缀识别，仅追加保留尾部不会绕过冷却。Main 仅对阈值触发使用冷却，手动压缩、`clear_context` 和上下文溢出恢复仍可立即尝试；原生请求重试不变。取消不计失败，成功提交清除对应冷却。冷却最多记录 32 个输入，仅存于会话内存，不进入 checkpoint，重启后可以重试。

## CLI 导出与反馈

以下导出不需要模型连接：

```sh
coworkos session export <session-id-or-path> --format json --output audit.json
coworkos session export <session-id-or-path> --format html --output conversation.html
# 兼容旧的离线 HTML 导出入口。
coworkos --export /path/to/session.jsonl conversation.html
```

会话参数可为完整 ID、唯一前缀或路径。默认不覆盖已有文件；`--force` 也不能覆盖源会话或其链接。导出校验分支引用，失败时保留源文件和已有导出。JSON 包含所有分支，HTML 可独立打开且不含脚本或外部资源。格式见[会话导出](task-workspace-layout.md#coworkos-会话导出格式)。

交互终端支持 `/export [json|html] [文件路径]`、`/share [文件路径]` 和 `/bug [描述]`。分享副本和反馈报告只存本机，不自动上传；`/help` 查看命令，`/changelog` 查看更新记录。诊断可用 `/coworkos-debug`、`ATRIA_DEBUG=1 coworkos` 和 `Ctrl+O`。

模型请求归档与私有重试快照分别保存。归档包含用户内容、工具结果和模型响应，虽不写认证 headers，仍应按私有数据保护。用量只代表服务实际报告的字段，缺失值不能当作零或据此证明上游缓存状态。路径、格式与保留范围统一见[数据布局](task-workspace-layout.md)。

## Task、Worker 与人工问题

安装包可将 `npm run cli --` 换成 `coworkos`。以下示例使用独立开发工作区：

```sh
npm run cli -- single "读取项目并总结当前实现" --workspace /tmp/atria-dev
npm run cli -- task cancel <task-id> --workspace /tmp/atria-dev
npm run cli -- task resume <task-id> --workspace /tmp/atria-dev
# single 的 checkpoint 恢复须使用同一 Task/Run。
npm run cli -- single "继续当前任务" --workspace /tmp/atria-dev --task <task-id> --run <run-id> --resume
```

Main 等待人工回答时，可离线列出并回答持久问题：

```sh
npm run cli -- human list --workspace /tmp/atria-dev --task <task-id> --status pending
npm run cli -- human reply --workspace /tmp/atria-dev --task <task-id> --request <request-id> --answer "确认后的答案"
```

已接受的回答只消费一次。人工回复草稿按任务和问题保存，提交失败或切换会话时保留。等待结束与后台回调共用持久投递机制；只读状态查询不消费回调结果。

独立恢复入口需要正确的 Task、Run、模型连接与预算：

```sh
# 恢复子智能体队列，检查一次。
npm run cli -- worker --workspace /tmp/atria-dev --task <task-id> --run <run-id> --once
# 恢复 Main Inbox 或中断 checkpoint。
npm run main-worker -- --workspace /tmp/atria-dev --task <task-id> --once true
# 默认只报告；--spawn true 才启动模型进程。
npm run cli -- main-supervisor --workspace /tmp/atria-dev
npm run cli -- main-supervisor --workspace /tmp/atria-dev --spawn true
npm run cli -- watch-supervisor --workspace /tmp/atria-dev --task <task-id> --program <program-id>
```

Task/Watch/Worker 命令在执行前验证选项。以 `-` 开头的任务或回答文本放在 `--` 后。帮助和版本查询不启动后台进程。

## 程序化运行

`PiSession` / `RunService.runPi` 支持以下显式选项：

| 选项                              | 契约                                                                                                                                      |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `maxTurns`                        | `0` 关闭本地轮数上限                                                                                                                      |
| `maxLengthContinuations`          | 0 至 100，默认 0；输出截断后允许额外续接，耗尽后仍可能未完成                                                                              |
| `contextWindow`、`compaction`     | 提供已知上下文容量和本地压缩设置                                                                                                          |
| `sampling: { temperature, topP }` | 通过 SDK 发送，省略时保留服务默认值                                                                                                       |
| `maxToolResponseChars`            | 64 至 16000000，默认 16000；按 UTF-16 字符计数，保留文本头尾、图片、错误标志及完整 `details`；默认完整加载 `load_skill`，显式预算仍限制它 |
| `signal`                          | `runPi` 将宿主取消传递到模型和工具，保留可恢复 checkpoint                                                                                 |

`lastStopReason` 和 `continuations.providerErrors/outputLimits` 记录最终停止原因与包装层额外恢复次数，不含正常工具循环轮次。取消或超时阻止后续恢复。Coordinator 持久化排队时的选项；恢复时仅对旧队列缺项使用调用方默认。

工具文本预算覆盖普通运行时工具与额外 `AgentTools` 的返回内容，不重写已恢复的历史。命令回执先保留退出与中断状态、日志引用和字节信息，再为 stdout/stderr 分配头尾预览；实际写入少于已观察字节时标明日志不完整。较小显式预算优先保留退出与中断状态，可能省略其他元数据，完整结构仍保存在 `details`。`load_skill` 默认保留完整指令，避免丢掉中间的必需规则；宿主仍可显式选择更大或更小的文本预算。

程序化 `createWebTools` / builtin `web` 保留原合同。未指定 `provider: "exa"` 时，`visit` 直接读取源文本；可选 Jina Reader 和提取回调仍受总超时与取消限制。产品 Main 的搜索配置见[联网搜索](configuration.md#联网搜索)。模型 smoke 与评测入口见[本地测试](testing-local-run.md)。

## 长期目标接口与调度

`manage_goal` 登记目标，默认 `scope=background` 使用独立 Task/Main，`scope=session` 依附当前会话。修改或交接前读取当前版本；`action=steer` 持久排队要求，不表示已完成、不修改简报，也不恢复暂停目标。`record_goal_progress` 保存计划、事实与等待条件，`publish_goal_update` 按主题汇报；版本冲突时重新读取。

目标复盘使用 `record_goal_progress(nextReviewAt)`，会话目标休眠使用 `sleep_until(programId=...)`。持续等待需要活动来源或明确复盘时间。普通回复不会结束持续目标；原请求完成交接后，后续模型轮次和自动重试不能另建替代采集器。

`create_watcher(programId=...)` 关联来源。自定义包须按[作者技能](../.pi/skills/virtual-agent-authoring/SKILL.md)准备并通过 `activate_virtual_agent` 探针；只有 `activated=true` 且具有 `monitorId` 才会轮询，失败保留 draft。版本化 handler 加载、原子升级和回滚尚未实现。

`npm start` 默认扫描整个工作区，Task 锁避免重复调度。`COWORK_DISABLE_WATCH_SUPERVISOR=1` 禁用调度；`COWORK_SUPERVISOR_INTERVAL_MS` 默认为 60000。采样不直接周期调用模型，无变化不分析。分析与 Main 唤醒额度分别计算，耗尽保留证据；模型预算沿用正常 Main 配置。

成功分析先持久保存，再投递 Inbox；重启或投递失败只补投已有结果。失败、超时和取消保留源事件供重试。Watch 分析使用独立 Run，不替换 Task 的活动 Main Run。字段与状态见 [Product API](product-api.md#persistent-monitors)，暂停见[暂停契约](monitoring-pause-contract.md)。

### macOS 源码监控服务

构建源码后，可以显式安装用户级 launchd 服务；普通启动不会安装：

```sh
npm run monitor-service -- install --workspace /absolute/path/to/workspace --config /absolute/path/to/config.json --port 3884
npm run monitor-service -- status --workspace /absolute/path/to/workspace --config /absolute/path/to/config.json
npm run monitor-service -- stop --workspace /absolute/path/to/workspace --config /absolute/path/to/config.json
npm run monitor-service -- uninstall --workspace /absolute/path/to/workspace --config /absolute/path/to/config.json
```

安装只保存配置路径，不复制模型密钥。服务监听 `127.0.0.1`，日志在工作区 `.service/`，登录后加载。`stop` 停止本次加载，`uninstall` 同时移除登录启动配置。`--global-index`、`--tabs-index` 可指定已有索引。关机或休眠期间不检查，来源保留窗口可能限制停机后的补齐。
