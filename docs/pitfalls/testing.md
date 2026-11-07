# 测试与审查环境

## 依赖软链接触发候选漂移

- **Trigger：** 新工作树复用依赖，将顶层 `node_modules` 设为软链接。
- **What happens：** `.gitignore` 的 `node_modules/` 匹配目录；软链接可能显示为 `?? node_modules`，固定候选检查因此拒绝继续。
- **Confirm：** 在该工作树执行 `test -L node_modules` 和 `git status --short --untracked-files=all -- node_modules`；改为正常安装的普通目录后，前者非零且后者无输出。对软链接追加 `/` 运行 `git check-ignore` 还可能报路径越过软链接。
- **Avoid：** 按 [验证准备](../development-handoffs.md#验证前准备) 在本工作树 `npm ci`；复用时核对锁文件并使用普通目录，完成后再固定源码状态。
- **Sources：** 2026-11-07 [P2 复盘摘录](evidence/os-p2-electron/retro.md)、[候选漂移与恢复回执摘录](evidence/os-p2-electron/dependency-receipt.md)。

## 切换执行 CLI 后文档夹具缺库

- **Trigger：** 更换执行 CLI 后运行 `test/input-files.test.js`，未显式选择已准备的 Python 环境。
- **What happens：** 新进程的 `python3` 解析到另一安装，生成 PDF/Office fixture 时出现 `ModuleNotFoundError: No module named 'fitz'`；此前执行者的通过结果和依赖并未迁移到这个解释器。
- **Confirm：** 在检查所用进程环境执行 `"${COWORK_PYTHON:-python3}" -c 'import sys; print(sys.executable, sys.version); import fitz, docx, pptx, openpyxl'`。缺库时非零退出；选择已准备依赖的解释器后导入成功。
- **Avoid：** 按 [Python 环境](../development.md#准备环境) 设置检查子进程的 `COWORK_PYTHON`，记录路径、版本和依赖预检结果，再运行原受影响命令。
- **Sources：** 2026-11-07 [科学剪枝复盘摘录](evidence/os-core-pruning/retro.md)、[失败与恢复日志摘录](evidence/os-core-pruning/checks.md)。

## 提交后格式检查没有选中文件

- **Trigger：** 在 clean 工作树提交修改后直接运行 `npm run format:check`。
- **What happens：** 默认选择当前未提交差异，输出 `No changed files to format`；已提交文件没有进入本次格式检查。
- **Confirm：** 比较默认输出与有效基线下的 `FORMAT_BASE=<变更前提交> npm run format:check`；后者应打印已提交差异的格式检查结果。先用 `git diff --name-only <变更前提交>...HEAD` 核对选择。
- **Avoid：** 独立审查已提交候选时记录并验证基线：`git rev-parse --verify '<变更前提交>^{commit}'`；按 [格式检查说明](../testing-local-run.md#日常开发验证) 使用 `FORMAT_BASE`。未提交修改仍用默认命令。
- **Sources：** 2026-11-07 [科学剪枝复盘摘录](evidence/os-core-pruning/retro.md)、[提交前后日志摘录](evidence/os-core-pruning/checks.md)。
