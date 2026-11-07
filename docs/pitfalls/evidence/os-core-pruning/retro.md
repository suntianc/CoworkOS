# 科学剪枝原复盘相关摘录

来源：归档 `coworkos-p1-docs/os-core-pruning/retro.md` 第 3、4 项，2026-11-07。与 [仓库复盘](../../../core-pruning-retrospective.md) 对应；省略机器绝对路径。

Terra 所用 Python 为 3.13.11；DSH a2 首次 AC6 选择了 Homebrew Python 3.15.0，fixture 的 `fitz` 导入失败。使用已有、含所需库的 3.13.11 后 14/14 通过，源码仅一行 README 差异。失败日志与恢复日志均保留；Main 在复审交接明确解释器，后续审查、集成和 finish 沿用。

提交后默认 `format:check` 输出 `No changed files to format`；本轮提交前同一内容的格式检查已通过。后续若需要独立检查已提交差异，应使用已有 `FORMAT_BASE` 参数选定比较点。

[日志摘录](checks.md) 保留原始错误与检查结果。原复盘提案将 Python 触发位置笼统写为 `science-removal.test.js`；原日志中的实际失败发生在同组命令的 `input-files.test.js`，本次坑点按原日志校正。
