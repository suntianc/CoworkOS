# Python 与格式检查日志摘录

来源：归档 `coworkos-p1-docs/os-core-pruning`，日期 2026-11-07。摘录仅保留错误与计数；fixture 路径和文档生成内容省略。完整失败和成功日志继续保存于档案。

## Python 失败及恢复

`evidence/01-a2/ac6-committed.log`，失败用例为 `test/input-files.test.js` 的 PDF/DOCX/PPTX/XLSX 读取：

```text
Command failed: python3 -c import fitz, os
ModuleNotFoundError: No module named 'fitz'
# tests 14
# pass 13
# fail 1
# skipped 0
```

`evidence/01-a2/ac6-committed-condapy.log`，使用已准备的 Python 3.13.11 后：

```text
# tests 14
# pass 14
# fail 0
# skipped 0
```

解释器版本及替换原因来自 `messages/01-rereview-readme.md`。源码差异仅为 README 的一行文字，原始检查各自的候选身份保留在报告中。

## 格式检查选择

`evidence/01-a2/format-check.log` 在提交前完成格式检查；同一内容提交后的 `evidence/01-a2/format-check-committed.log` 输出：

```text
> coworkos@0.1.3 format:check
> node scripts/format.mjs

No changed files to format
```

当前选择行为由 [格式脚本](../../../../scripts/format.mjs) 的默认 Git 工作树差异与 `FORMAT_BASE` 分支决定。
