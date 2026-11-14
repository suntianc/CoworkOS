# CoworkOS terminal UI adapter

[中文](../cli-ui-adapter.md) | English

CoworkOS uses the original `@earendil-works/pi-coding-agent@1.5.2`, retaining licenses and recovery formats. Product roles do not assert model training provenance. Raw requests, JSONL, native SDK RPC and user prompts preserve their actual contents; product exports project only known defaults in copies.

Public root/start/npm version queries return the CoworkOS version without configuration, SDK, compiled runtime or writable profiles. Root version accepts no extra arguments; start help takes priority over version, while other execution arguments combined with a version query are rejected. Option values and text after `--` remain ordinary inputs. Extension execution flags still use SDK validation.

Immutable overlays include policy/content hashes and reject corrupt resources without overwriting active caches. Startup does not replay the upstream changelog; `/changelog` and `coworkos update --check` remain product update entry points. Original engine documentation and changelogs remain intact.

## Reviewed SDK differences

There is no public UI hook for all these fixed messages. The adapter retains the bundled entry and transforms only one reviewed chunk in the interactive subprocess:

| Method                            | Difference                                                                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| renderProjectTrustWarningIfNeeded | Restart atria; preserve trust decisions and .pi resources.                                                                 |
| checkTmuxKeyboardSetup            | CoworkOS wording; preserve query, timeout and keyboard advice.                                                             |
| suggestBugReport                  | Recommend `/coworkos-bug` for local feedback only when CoworkOS commands are enabled, with review and manual submission.   |
| crashReportInstructions           | Correct CoworkOS start/resume instructions and condition local feedback on CoworkOS commands being enabled.                |
| run / takeUnnotifiedCrash         | Preserve timestamp, error and notification consumption without automatic attachment promises.                              |
| setupEditorSubmitHandler          | Replace only the exact hidden promotion command call with a local unsupported message; preserve input clearing and return. |

[Policy](../../scripts/cli-ui-policy.json) pins the version and hashes of three entry-graph files. [Build validation](../../scripts/build-cli-ui.mjs) requires one class, one method/AST match for every difference and nonoverlapping UTF-16 spans, generating `dist/cli-ui-manifest.json`. An independently reviewed digest binds the complete spans, including original text, positions and replacements; both build and runtime verify it, and build parses the complete transformed JavaScript. SHA-256 covers original UTF-8 bytes. TypeScript is build-only.

[Parent preflight](../../scripts/cli-ui-compatibility.mjs) runs read-only before profile/session/Task/project-lease/supervisor preparation. [Boot](../../scripts/cli-ui-boot.mjs) revalidates before import and checks the loaded source. Rejection reports an CoworkOS error and preserves existing sessions. A new interactive supervisor starts only after the child acknowledges UI validation over IPC. The [CLI process host](../../scripts/cli-runtime-host.mjs) validates a single-use launch token; the launcher waits for child closure before releasing its project lease. Boot removes the token from the environment before SDK import so tools do not inherit it.

Non-target modules delegate unchanged. No stdout filter, prototype mutation or upstream file edit is used. Hooks are not propagated through NODE_OPTIONS/preload flags to workers, tools or user programs. Node >=22.19.0 is required; [synchronous hooks](https://nodejs.org/download/release/v22.19.0/docs/api/module.html#moduleregisterhooksoptions) are Active development and need revalidation when Node or SDK changes.

The default CoworkOS command extension maps `/bug` and `/coworkos-bug` to local feedback files for manual submission. Explicit `--extension` options can replace that extension; `/bug` then belongs to the selected extension or SDK. Generic error and crash hints recommend `/coworkos-bug` only when CoworkOS commands are enabled, without promising how another feedback command saves or submits data.

## Shell identity and full output

Interactive, print, JSON and RPC CLI launches use a separate [shell policy](../../scripts/cli-shell-policy.json) with three exact SDK 1.5.2 positions: set `AI_AGENT=coworkos` at startup, and use `atria-bash-*.log` for long output from native model bash and manual `!`/RPC bash. These are actual created filenames; tool text and streaming/final `fullOutputPath` refer to the same readable file. `PI_CODING_AGENT=true` remains a truthful engine compatibility marker. Existing logs, contents and saved paths are not renamed.

[Read-only preflight](../../scripts/cli-shell-compatibility.mjs) pins two original bundle hashes and requires each original text to match exactly once. The parent checks before preparing user state, boot rechecks before SDK import, and load validates actual original source. Interactive boot combines these differences with the six UI spans, sorting against the same original text and rejecting overlaps. Print/JSON/RPC load the original SDK executable through an [ordinary boot entry](../../scripts/cli-shell-boot.mjs), without inheritable preload flags or stdout banners. Explicit `--extension` replacement does not disable these differences. Protocol fields, shell exit codes and cancellation semantics retain their meaning. Build validation parses transformed JavaScript; licenses and dependency files stay intact.

## Upgrade gate

The launcher keeps the pre-upgrade terminal default and capability boundary: the interactive TUI uses regular scrollback (pass `--tui-mode fullscreen` to opt in), and Pi 1.x's built-in MCP client stays off so a user `mcp.json` cannot add `mcp__*` tools to the tool table.

Do not automatically accept a new SDK hash. Review source, the six UI and three shell differences, then validate build uniqueness/rejection, minimum/current Node, regular/fullscreen/custom editor, slow startup/reload, trust/tmux/errors/crash, shell long output/failure/cancellation, stop/resume and actual candidate installation, plus applicable Electron paths. Preserve [licenses](../../THIRD_PARTY_NOTICES.md).

Behavior tests: [version](../../test/cli-information.test.js), [overlay](../../test/cli-branding.test.js), [manifest/rejection](../../test/cli-ui-compatibility.test.js), [real PTY](../../test/cli-ui-pty.test.js), [native shell/RPC output](../../test/cli-shell-identity.test.js), [worker isolation](../../test/cli-runtime-host.test.js), [identity/export](../../test/agent-identity.test.js). Report simulated tmux, injected exceptions and fake models separately from real installations/services; zero occurrences of Pi is not a completion criterion.
