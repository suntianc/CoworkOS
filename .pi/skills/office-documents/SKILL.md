---
name: office-documents
description: Create, inspect, edit, render, and validate Word and Excel files (.docx, .xlsx). Use for reports, spreadsheets and conversions.
---

# Office documents

Use this skill for DOCX and XLSX files. The skill supplies workflow and format knowledge; the runtime stays generic.

## Workflow

1. Load this skill with `load_skill` and run `node <absolute-script-path>` using its returned `scripts["check_backend.mjs"]`. When loaded by `read`, resolve `scripts/check_backend.mjs` against the actual parent directory of the SKILL.md you read. Never guess a location under `~/.agents/skills`. Prefer the local `officecli` executable when it is available. If it is absent, use the detected Python format library for structured editing. Do not install packages or upload files without an explicit user request.
2. Work on a copy in the current Agent's workspace. Preserve the user's original. Subagents keep candidate results under their private `deliverables/`; Main keeps scripts and intermediate previews under `work/` and writes or copies accepted final files into the Task's `artifacts/` with ordinary file/command tools. Only Task `artifacts/` files appear as user deliverables.
3. Inspect before editing. Use OfficeCLI `view`/`get`/`query` for structure and text; use `render` for a visual preview. Read the relevant reference in `references/` only when the operation needs format-specific details.
4. Make the smallest reliable change. Group independent OfficeCLI changes in one `batch` when possible, then validate and inspect issues.
5. Render the result again and review the preview. Fix layout, missing content, invalid references, and accidental template changes before delivery.
6. Return a concise conclusion with the output path, preview/validation evidence, and any backend limitation. Do not claim success when only a plan was produced.

## Backend rules

- `@officecli/officecli` from `iOfficeAI/OfficeCLI` is the preferred structured local backend when installed. It supports inspection, JSON-shaped operations, validation, and rendering for common Office formats.
- Python fallbacks are format-specific: `python-docx` handles DOCX structure, and `openpyxl` handles XLSX structure. These libraries do not render Office files, so a visual preview requires LibreOffice/soffice or another renderer.
- LibreOffice/soffice is a useful conversion or rendering fallback, but it is not a substitute for structured editing. If no backend is available, explain the blocker instead of silently producing a fake file.
- Keep Office-specific command knowledge in the references and load it on demand. Do not add a permanent Office tool or put the full workflow into the global Main prompt.

The generic `read_file` tool is restricted to the Agent's own working directory. The `load_skill` result already contains this skill's main instructions; to inspect a referenced file or run a bundled script outside that directory, use `run_command` with the absolute `directory` returned by `load_skill` (for example, `cat <skill-directory>/references/format-checklist.md` or `node <skill-directory>/scripts/check_backend.mjs`).

## Ownership and evidence

Main remains responsible for task decomposition, decisions, and the final judgment. A Subagent may execute a focused Office artifact task, but must report the actual commands, output paths, and validation/render evidence in its final message. Prefer one artifact-focused task per Subagent.

See `references/officecli.md` for command patterns and `references/format-checklist.md` for format-specific acceptance checks.
