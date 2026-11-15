# 测试与审查环境

## 真实模型验收前产品连接未配置

- **Trigger：** 外部执行 CLI 已可用，准备从 OS UI 开始真实 Main/Executor/Reviewer 验收。
- **What happens：** OS 自身连接仍未配置，真实模型流程无法开始；需要在验收实例中配置产品模型。
- **Confirm：** 只读核对该实例 `/api/model-settings` 的 `configured`、`credentialUnavailable`，以及已有 Task/Run 是否活跃。P4 配置前 `configured=false`，配置完成后为 true。
- **Avoid：** 提前核对正确实例的模型设置入口，凭据保留在产品配置；就绪后续接已有任务，避免重复创建 Run。其余不依赖真实模型的检查可继续。
- **Sources：** 2026-11-09 [P4 产品配置摘录](evidence/os-p4-native-development/checks.md#产品配置前置)、[整轮复盘](../p4-retrospective.md#5-产品模型配置是独立的验收前置)。自动就绪门禁尚未新增。

## 归档目录内仍有用户配置的实例

- **Trigger：** Workloop archive 前，验收服务源码或用户数据仍位于 run scratch/执行工作树。
- **What happens：** 归档清理可能同时移除仍需使用的配置、样例和服务代码；运行数据与可再生夹具需要分别处理。
- **Confirm：** 核对实例 PID/cwd/listener、Task/Run 活跃状态、数据根与归档删除集合；确认实际保留目录已在删除集合外，兼容链接仍指向有效数据。
- **Avoid：** 带用户配置的实例优先使用私有持久目录。已有实例需先确认归属和空闲状态，再保全源码、配置、权限及访问入口并验证恢复；活跃用户工作保持原状，凭据不放进 evidence。清理兼容链接前核对消费者和所有权。
- **Sources：** 2026-11-09 [P4 保全摘录](evidence/os-p4-native-development/checks.md#保全与审计)、[整轮复盘](../p4-retrospective.md#8-归档前保全带用户配置的验收实例)。Workloop 自动占用预检尚未实施。

## 依赖软链接触发候选漂移

- **Trigger：** 新工作树复用依赖，将顶层 `node_modules` 设为软链接。
- **What happens：** `.gitignore` 的 `node_modules/` 匹配目录；软链接可能显示为 `?? node_modules`，固定候选检查因此拒绝继续。
- **Confirm：** 在该工作树执行 `test -L node_modules` 和 `git status --short --untracked-files=all -- node_modules`；改为正常安装的普通目录后，前者非零且后者无输出。对软链接追加 `/` 运行 `git check-ignore` 还可能报路径越过软链接。
- **Avoid：** 按 [验证准备](../development-handoffs.md#验证前准备) 在本工作树 `npm ci`；复用时核对锁文件并使用普通目录，完成后再固定源码状态。
- **Sources：** 2026-11-07 [P2 复盘摘录](evidence/os-p2-electron/retro.md)、[候选漂移与恢复回执摘录](evidence/os-p2-electron/dependency-receipt.md)。

## 切换执行 CLI 后文档夹具缺库

- **Trigger：** 新验证工作树或更换执行 CLI 后运行 `test/input-files.test.js`，未显式选择已准备的 Python 环境。
- **What happens：** 新进程的 `python3` 解析到另一安装，生成 PDF/Office fixture 时出现 `ModuleNotFoundError: No module named 'fitz'`；此前执行者的通过结果和依赖并未迁移到这个解释器。
- **Confirm：** 在检查所用进程环境执行 `"${COWORK_PYTHON:-python3}" -c 'import sys; print(sys.executable, sys.version); import fitz, docx, pptx, openpyxl'`。缺库时非零退出；选择已准备依赖的解释器后导入成功。
- **Avoid：** 按 [Python 环境](../development.md#准备环境) 设置检查子进程的 `COWORK_PYTHON`，记录路径、版本和依赖预检结果，再运行原受影响命令。
- **Sources：** 2026-11-07 [科学剪枝复盘摘录](evidence/os-core-pruning/retro.md)、[失败与恢复日志摘录](evidence/os-core-pruning/checks.md)；2026-11-08 [P3 前置失败摘录](evidence/os-p3-project-foundation/checks.md#依赖与解释器前置)。P3 中测试隔离 hook 清除显式覆盖变量的问题已修复；新环境仍需准备对应解释器的依赖。

## 合入依赖后仍使用旧安装

- **Trigger：** 合入含 package/lockfile 变化的候选，在已有工作树直接构建。
- **What happens：** 新代码使用的库尚未安装；P3 首次集成报 `TS2307: Cannot find module 'pg'`。
- **Confirm：** 对照合入前后的 package/lockfile 差异及失败模块；按锁文件完成 `npm ci` 后，在同一源码候选重跑原失败检查，分别保留退出记录。
- **Avoid：** 沿 [验证准备](../development-handoffs.md#验证前准备) 同步依赖，再固定候选环境；依赖安装失败按具体错误处理。
- **Sources：** 2026-11-08 [P3 前置失败摘录](evidence/os-p3-project-foundation/checks.md#依赖与解释器前置)，同一 e3d2e499 候选补齐依赖后集成通过。

## Electron 运行时尚未准备

- **Trigger：** 新环境执行读取 Electron.app 内容的检查，尚未下载 Electron 二进制。
- **What happens：** npm 包已存在，测试读取 `Electron.app/Contents/Info.plist` 时出现 ENOENT。
- **Confirm：** 核对原始错误指向运行时文件；执行现有 `node scripts/ensure-electron.mjs` 后检查该文件并继续原命令，保存准备与检查结果。
- **Avoid：** 所选检查需要 Electron 运行时时先使用已有准备入口；完整桌面构建按 [开发指南](../development.md) 执行。
- **Sources：** 2026-11-08 [P3 F3 记录](evidence/os-p3-project-foundation/checks.md#依赖与解释器前置)；补齐前置后 desktop-dev 3/3 通过。

## 提交后格式检查没有选中文件

- **Trigger：** 在 clean 工作树提交修改后直接运行 `npm run format:check`。
- **What happens：** 默认选择当前未提交差异，输出 `No changed files to format`；已提交文件没有进入本次格式检查。
- **Confirm：** 比较默认输出与有效基线下的 `FORMAT_BASE=<变更前提交> npm run format:check`；后者应打印已提交差异的格式检查结果。先用 `git diff --name-only <变更前提交>...HEAD` 核对选择。
- **Avoid：** 独立审查已提交候选时记录并验证基线：`git rev-parse --verify '<变更前提交>^{commit}'`；按 [格式检查说明](../testing-local-run.md#日常开发验证) 使用 `FORMAT_BASE`。未提交修改仍用默认命令。
- **Sources：** 2026-11-07 [科学剪枝复盘摘录](evidence/os-core-pruning/retro.md)、[提交前后日志摘录](evidence/os-core-pruning/checks.md)。

## Docker 守护进程停止后 PostgreSQL 契约成批失败

- **Trigger：** 运行 `npm run verify:full`、`node scripts/test.mjs` 或集成门禁时，Docker Desktop 没有运行或在中途停止。
- **What happens：** PostgreSQL fixture 起不来，用例报 `PostgreSQL fixture 已退出：没有输出`。停止发生在检查中途时，Node 套件只剩 1 项失败；开跑前就已停止时，失败多达 48 项。集成门禁只打印尾部汇总，看不到失败的用例名，容易误判为偶发。
- **Confirm：** 运行 `docker info --format '{{.ServerVersion}}'`，连接失败即为此原因。在同一候选上启动 Docker 后，单独重跑 Node 套件，结果应为 0 失败。
- **Avoid：** 长时间检查开跑前确认 `docker info` 成功。失败时先查看完整日志里的失败用例名，`PostgreSQL fixture` 类错误直接核对 Docker 状态，不要重复跑整轮门禁。
- **Sources：** 2026-11-11 [P4.5 复盘](../p4.5-retrospective.md#4-长时间检查前先预检环境)。#14 集成连续两轮各失败 1 项，手动复现时失败 48 项，启动 Docker 后为 0 失败。

## 锁屏或本机系统权限改变界面检查结果

- **Trigger：** 运行涉及电脑操控设置或原生窗口的检查（如 `e2e/computer-use.spec.js`、`e2e/p45-english-catalogue.spec.js` 的设置页用例），同时屏幕锁定，或本机已授予屏幕录制、辅助功能权限。
- **What happens：** 后端返回的是本机真实状态：锁屏时提示「桌面已锁定或没有可操作的前台应用」，已授权时显示「执行主机窗口访问已关闭」，与测试预期的「不可用」不一致。改动前的基线上同样失败，容易被误认为是候选的回归。
- **Confirm：** 在同一台机器上，对基线提交运行同一用例，结果相同即为环境原因。锁屏状态可用 `ioreg -n Root -d1 -a | grep CGSSessionScreenIsLocked` 查看，有输出即为锁屏。
- **Avoid：** 原生和桌面检查在解锁的桌面上运行。新写的测试不要读取主机真实的权限或桌面状态，用 `page.route` 固定 `/api/computer/status` 等接口。`computer-use.spec.js` 已按此修复。
- **Sources：** 2026-11-11 [P4.5 复盘](../p4.5-retrospective.md#2-偶发失败多数是测试自身的问题)。#14 集成中该用例在基线 `addfeed2` 上同样失败。

## 测试假服务器在块边界切断多字节字符

- **Trigger：** 测试里用 `for await (const chunk of request) raw += chunk` 读取 HTTP 请求体，请求中含中文等多字节字符。
- **What happens：** 每个 Buffer 块被单独转成字符串，一个字符的字节如果落在两块之间就变成 `�`（如「谱系」读成「谱���」）。请求被切成几块取决于负载，所以只在全量或高负载时偶发失败，比如 `request-recovery` 要求逐字节一致的重试检查。
- **Confirm：** 读取失败现场的差异，出现 `�` 即为此原因。单独重复运行通常全部通过。
- **Avoid：** 读取请求体使用 `request.setEncoding("utf8")`，或先用 `Buffer.concat` 拼接字节、最后统一解码。e2e/ 与 test/ 中已有的 38 处已改为前者。
- **Sources：** 2026-11-11 [P4.5 复盘](../p4.5-retrospective.md#2-偶发失败多数是测试自身的问题)，修复提交 `724dcff`。

## 应用就绪前输入的草稿被恢复覆盖

- **状态：** 已修复（#22），回归覆盖 `e2e/markdown-links.spec.js` 的「a draft typed while the first catalog loads stays in the composer」「an upload in flight when the first catalog loads keeps its attachment」「a conversation link keeps typing that lands before the catalog」「a stale conversation link keeps early typing in the composer」。本条目已移出坑点索引，历史保留在 [P4.5 打磨清单](../p4.5-polish-backlog.md) 第 19 条。
- **Trigger：** 页面打开后立即向 `#composer-input` 填入文字、选择附件（上传还没结束也算），或带 `?task=` 链接打开（`e2e/markdown-links.spec.js` 原首个用例、`e2e/recovery-review.spec.js` 同类断言）。全量运行时偶发失败，读到的输入框值为空或会话已切换。
- **What happens：** 修复前的说法是草稿恢复在 `await composerSession.ready` 之后执行、覆盖了就绪前的输入；实测根因在更后面。草稿租约落定前输入框只读（`aria-busy`），输不进字；租约一落定，输入可编辑与全部输入/附件监听在同一段同步代码里生效。丢字发生在之后：首份目录（`/api/events/snapshot` 或 `/api/tasks`）到达时页面自动恢复默认会话、或用默认会话替换已消失的会话，把这段窗口里键入的文字、已选附件和还在上传的附件换成那份空草稿；链接会话在后端绑定后会短暂失去草稿，绑定到目录之间键入的内容也会落到别的会话草稿里。
- **Confirm：** 用 `page.route` 扣住首份目录（必要时连 `/api/session`、`/api/uploads` 一起扣）直到输入或上传完成，再放行；修复前读到的输入框为空、附件条为空或活动会话被换掉，修复后保留。单独重复运行通常全部通过，所以偶发失败要按这些方式构造确定性复现。
- **Avoid：** 首份目录不再覆盖用户输入，测试可以直接在页面打开后输入；需要读取会话内容的断言仍先等目标会话成为活动会话（`e2e/markdown-links.spec.js:6`、`e2e/recovery-review.spec.js` 已如此）。上传附件时重复选择文件直到附件条出现（见 `e2e/model-profile-images.spec.js` 的 `attachImage`）与本次修复无关，仍然适用。
- **Sources：** 2026-11-11 P4.5 finish 失败记录；#16 中的同类附件竞态；#22 根因与修复（含审查 P1/P2/P3）。

## 遗留的无头测试浏览器推高负载

- **Trigger：** 测试中断、超时或被 kill 后，Playwright 启动的 Chrome for Testing 失去父进程继续运行，多轮之后积累下来。
- **What happens：** 机器负载长期偏高，依赖时序的用例更容易超时，表现为偶发失败。P4.5 期间积累了 58 个此类进程，最早的已运行 4 天以上，负载长期在 7–8。
- **Confirm：** `ps -Ao pid,ppid,etime,command | grep 'Chrome for Testing.app/Contents/MacOS/' | awk '$2==1'`，有输出即为遗留进程（父进程为 1）。
- **Avoid：** 没有 Playwright 在运行时，结束父进程为 1 的 Chrome for Testing 进程，再开始长时间检查。中断测试后顺手检查一次。
- **Sources：** 2026-11-11 P4.5 归档后的清理，负载降到 5–6。

## 合入失败后整轮重跑全量

- **Trigger：** 集成门禁或收尾检查中有个别用例失败，修复后重新运行整个门禁。
- **What happens：** 门禁每次都运行公共检查加全部回归命令，回归里的全量又包含各个单项，一轮约 20–30 分钟。P4.5 #14 因此跑了 6 轮，其中 3 轮失败是环境原因。
- **Confirm：** 对比失败用例与本次改动的关系，单独重复运行失败项，确认是回归、测试缺陷还是环境问题。
- **Avoid：** 失败后只单独重跑失败项，确认原因并修好后再整体合入。只改动部分模块时只跑相关测试；全量（`npm run verify:full` 加 `npx playwright test --workers=1`）只在合入 main 前或终审时跑一次，收尾复用同一提交上的全量结果。
- **Sources：** 2026-11-11 [P4.5 复盘](../p4.5-retrospective.md#3-测试重复导致合入很慢)、[WL-11](../workloop-followups.md#wl-11-合入与收尾的重复检查)。

## 替换环境开关后旧用法残留

- **Trigger：** 一张票新增环境开关或接口，另一张票删除旧的那个，例如测试中关闭 Main 守护的开关从 `COWORK_DISABLE_WATCH_SUPERVISOR` 换成 `COWORK_DISABLE_MAIN_GUARDIAN`。
- **What happens：** 旧名被删、新名没有补上的地方静默失效。P4.6 第一轮约 80 处测试启动的后端因此运行了守护，时序用例偶发失败，起初被当成负载问题。
- **Confirm：** `rg -n "<旧名>" src test e2e scripts desktop .pi` 应无结果，`rg -n "<新名>"` 覆盖原来每一处调用方；守护开关由 `test/p46-guardian-off-in-tests.test.js` 扫描。
- **Avoid：** 工单写明「每个旧用法都要有新用法」，用 rg 全量查 `test/`、`e2e/`；改名跨票时由后一张票负责替换，并用扫描测试守住。
- **Sources：** 2026-11-13 [P4.6 摘录](evidence/os-p46/retro.md#开关替换后旧用法残留第一轮)。

## 偶发失败未对照基线就下结论

- **Trigger：** 门禁或终审中时序类用例偶发失败，准备判定为负载、环境或既有问题。
- **What happens：** 回归也会表现为偶发。P4.6 第一轮把开关替换导致的回归误判为负载偶发；反过来，第二轮 `e2e/file-upload.spec.js:97` 若不对照，会被误当成本轮回归。
- **Confirm：** 在基线提交（`git archive <base>` 到 scratch，`npm ci` 后构建）和候选上各连跑同一用例多次（建议 ≥10 次），比较失败率与失败签名。第二轮实测 tip 约 23%、基线约 39%，签名相同。
- **Avoid：** 结论写明两边的次数、失败率和签名；基线同样失败才归为既有问题，并单独开票。只在候选上失败时按回归处理。
- **Sources：** 2026-11-13 [P4.6 摘录](evidence/os-p46/retro.md#偶发失败的基线对照第二轮)、[第一轮复盘教训](evidence/os-p46/retro.md#开关替换后旧用法残留第一轮)。

## 高负载下动画帧与上传竞态用例偶发

- **Trigger：** load average 持续在 8 以上（系统进程或其他应用占用，不只是遗留测试浏览器）时运行 Playwright 全量。
- **What happens：** 依赖逐帧采样或启动时序的用例更容易失败：`e2e/p45-motion.spec.js:44` 抓不到动画中间帧，`e2e/file-upload.spec.js:97` 的上传重试按钮超时。P4.6 第二轮 finish 在负载约 10 时出现前者。
- **Confirm：** 失败时记录 `uptime`；同一提交上单独重跑失败用例，通过且本次改动不涉及对应界面，即可归为负载。仍需参考上一条对照基线。
- **Avoid：** 开跑前 `uptime` 与 `ps -Ao pcpu,pid,command -r | head` 核对负载来源，偏高时先等或关闭占用；先排除 [遗留测试浏览器](#遗留的无头测试浏览器推高负载)。失败后只重跑该用例。
- **Sources：** 2026-11-13 [P4.6 摘录](evidence/os-p46/retro.md#高负载下的动画帧用例第二轮)。

## 改变进程生命周期的票只跑本票回归

- **Trigger：** 一张票改变进程或运行的生命周期语义，例如让 Main 回合结束不退出、后端停止后保留代理进程待接管、把终态事件从进程退出挪到回合边界。
- **What happens：** 本票回归集全绿，依赖旧语义的测试、夹具和界面断言在别处静默失效，到终审全量才暴露。P4.6 第三轮 #04 改成常驻 Main 后，终审连开三轮修复：停止与中断的旧断言、终态事件只在进程退出时写（重试成功后不显示最终回答）、每回合重读模型配置时丢失端点上限、测试只停后端留下常驻 Main。
- **Confirm：** 用 rg 查依赖旧语义的调用方，例如 `stopBackend`、`run_completed`、`mainRunning`、进程 `exit` 监听，逐个判断它在新语义下是否仍成立。
- **Avoid：** 派单时列出这些调用方并写进回归集；或该票集成后先跑一次全量，再派依赖它的票。
- **Sources：** 2026-11-16 [P4.6 摘录](evidence/os-p46/retro.md#常驻-main-的波及面第三轮)。

## 常驻 Main 让只停后端的测试留下进程

- **Trigger：** 测试发起真实回合（Main 真的跑过一轮），收尾只调用 `stopBackend` / `dashboard.stop()` 而不先关闭会话。
- **What happens：** 后端停止按设计保留代理进程以便重启后接管，常驻 Main（`start-pi.mjs --mode rpc`，`COWORK_MAIN_RESIDENT=1`）继续存活。`scripts/test.mjs` 的泄漏门因此判失败，即使 TAP 全部通过；常驻进程还可能通过 stdio 拖住测试进程直到空闲超时（约 30 分钟）。
- **Confirm：** 输出中出现顶层 `Leaked backend <pid> (ATRIA_HOME=…)`；`ps axeww | grep COWORK_MAIN_RESIDENT=1` 可看到残留进程及其 `ATRIA_HOME`。`leaked-backends.test.js` 自身沙箱里带 `#` 前缀的泄漏行是预期输出，不算。
- **Avoid：** 收尾先经产品取消路径关会话（`POST /api/tasks/<taskId>/action {action:"cancel"}`），再停后端，最后 `endAgentProcesses`；参考 `test/electron-connect.test.js`、`test/cua-script-pi.test.js`。不要放宽泄漏门。`scripts/desktop-smoke.mjs` 仍是同样形状，不在泄漏门内。
- **Sources：** 2026-11-16 [P4.6 摘录](evidence/os-p46/retro.md#常驻-main-的波及面第三轮)。

## 既有偶发反复卡住收尾门

- **Trigger：** 对照基线后确认某个偶发失败是既有问题，但它在全量门（finish、终审）里经常出现。
- **What happens：** finish 不能豁免失败的检查，只能重跑；高负载下既有偶发的失败率远高于单独运行时的基线（`markdown-links:6` 基线约 1/10，P4.6 第三轮 finish 三次全量中三次失败），每次重跑约 20 分钟。
- **Confirm：** 连续两次全量门都被同一个既有偶发卡住。
- **Avoid：** 不再寄望重跑，尽早开票修掉；修之前先写一个确定性复现（例如 `page.route` 扣住首份响应），修复前失败、修复后通过。#22 的实测根因与票面猜测不同，以复现为准。
- **Sources：** 2026-11-16 [P4.6 摘录](evidence/os-p46/retro.md#finish-被既有偶发卡住第三轮)。
