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
