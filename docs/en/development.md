# Development guide

English | [中文](../development.md)

Start with [AGENTS](../../AGENTS.en.md), [architecture](architecture.md) and the [code map](code-map.md). Follow [CONTRIBUTING](../../CONTRIBUTING.en.md).

## Environment

Use Node.js >=22.19.0, npm and Git. Install locked dependencies with `npm ci`. Initial dependency/Chromium downloads require network access. Ordinary tests use temporary workspaces and local model protocol fixtures; real credentials are needed only for actual model requests.

| Target       | Preparation                                                                      | Launch                                                    |
| ------------ | -------------------------------------------------------------------------------- | --------------------------------------------------------- |
| CLI/harness  | `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci`, `npm run build:cli`                    | `npm run init`, `npm start`                               |
| Web          | `npm ci`, `npm run build`; Mac builds need Xcode Command Line Tools              | `npm run ui`, default `http://127.0.0.1:3880`             |
| Electron App | `npm ci`; run `npm rebuild electron` if download was previously skipped          | `npm run desktop`                                         |
| Computer Use | Mac, Xcode Command Line Tools; screenshots need macOS 14+ and system permissions | Built by `npm run build`; input needs an unlocked desktop |
| Mac package  | Apple Silicon Mac; offline full archives also need uv                            | `npm run desktop:pack` / `npm run desktop:dist`           |

`build:cli` compiles the shared runtime and prepares CLI assets. `build`, `build:base` and `build:full` prepare the text workbench, math rendering and desktop host assets. Non-Mac builds skip native helpers and icons.

Document attachment tests need Python 3.11 and PDF/Office parsing dependencies. Missing libraries must be fixed, not counted as passing skips. Fixtures/readers share `COWORK_PYTHON`:

```sh
python3.11 -m venv .tmp/document-python
.tmp/document-python/bin/python -m pip install -r scripts/document-requirements.txt
.tmp/document-python/bin/python -c 'import sys; print(sys.executable, sys.version); import fitz, docx, pptx, openpyxl'
COWORK_PYTHON="$PWD/.tmp/document-python/bin/python" npm run verify:full
```

## Isolated development data

Do not use real user tasks, model settings or documents for tests. Web can use explicit directories:

```sh
COWORK_WORKSPACE=/tmp/atria-dev \
COWORK_GLOBAL_INDEX=/tmp/atria-dev-index/workspaces.json \
COWORK_TABS_INDEX=/tmp/atria-dev-index/workbench-tabs.json \
COWORK_UI_PORT=3881 npm run ui
```

First verify TXT creation/save/reopen/binding without a model; then configure a connection using the [model configuration](configuration.md). Investigate recovery using the [workspace reference](../task-workspace-layout.md) (Chinese); do not delete data to diagnose it.

Mac development displays CoworkOS Dev (short suffix), identifier `org.atria.cowork.dev.runtime.<runtime hash>`. Each immutable ad-hoc runtime has its own permission identity so different worktrees or runtimes do not share a system permission record with incompatible signatures. Reopening the same runtime reuses its identity.

It shares `~/.atria/` with the release App, CLI and Web; both default desktop entrypoints use the same instance lock. Tests may set `COWORK_DESKTOP_DATA`, or `ATRIA_HOME` for full isolation. Legacy data retention and imports are documented in [workspace persistence](../task-workspace-layout.md) (Chinese).

```sh
npm run desktop:install-dev # installs fixed ~/Applications/CoworkOS Dev.app
npm run desktop             # builds current source and starts the same entry
```

The fixed entry reads the current checkout's `desktop/`, `dist/` and `web/`; Finder/Dock launch uses the last build. Reinstall the entry after moving the repository. Runtime cache: `.tmp/desktop-runtime/`; packed App: `.tmp/release/mac-arm64/`; DMG: `release/`. CLI candidates may use `ATRIA_PACKAGE_DIR=.tmp/cli-candidate npm run cli:pack` to inspect packages separately from the default `release/` directory.

Mac development startup and restart after updates open the exact App bundle through LaunchServices. The command returns after requesting launch; quit through the App menu. Environment variables such as the test data directory reach that instance.

Do not directly execute the binary in `Contents/MacOS/` for system permission acceptance: direct execution, including detached execution, can attribute the App and native helper to Terminal/IDE. Revoking CoworkOS's permissions may then leave access working or fail to show CoworkOS's permission prompt. Check the CoworkOS Dev entry with the current short suffix in System Settings. Revocation may not reproduce a first-install prompt; when macOS declines to prompt again, confirm access in System Settings.

The Finder entry copies the signed cached bundle without changing or re-signing it, preserving its permission identity. Changes to the icon, Electron, toolchain or package metadata create a new development runtime that needs a new grant; old grants are not migrated automatically. An old CoworkOS Dev entry without a suffix does not grant access to the new test bundle. Other Apps and system permissions do not need to be removed or reset.

Frontend uses native ES modules without Vite/HMR. Refresh after JS/CSS changes. Rebuild/restart for TypeScript, generated browser assets or Swift changes. Icon/Electron/package-version changes also require rebuilding the development runtime. Edit source, not generated artifacts. Full/CLI builds remove orphaned compiled files for moved/deleted sources while preserving native helpers and Python runners.

For interface iteration, complete `npm run build` once, then start with `node dist/src/cli/dashboard.js` to avoid the rebuild performed by every `npm run ui` launch. Keep the required isolation environment variables. The server reads HTML, CSS and JS directly from `web/`; refresh the browser after editing them. Backend changes still require stopping the server, rebuilding and restarting.

### Standalone backend

The standalone backend runs independently of the client that started it. The development package supports macOS 14+ on Apple Silicon; the App starts or reuses the backend for its data root and quitting the desktop leaves it running. The standalone CLI requires Node.js ≥22.19.0 and should match the App candidate version. After `npm run build:cli`, `node dist/src/cli/backend.js start` (or `coworkos backend start`) starts a detached process for one data root; `status` reports the instance and `stop` finishes managed work before exiting. The port, session token and instance identity live in `ATRIA_HOME/runtime/backend-instance.json` (mode 0600), while the backend identity in `backend-identity.json` survives restarts. A direct `serve` follows the same ownership rule: with a verifiable live instance it only prints that identity and exits, and it refuses clearly while another backend is starting or its identity cannot be confirmed instead of overwriting the record. `stop` returns `stopped` only after the backend finished teardown and removed its instance record; a forced or incomplete teardown returns `incomplete` with a non-zero exit and keeps the record so the next `start` reclaims the same backend identity. These commands never install a launchd/systemd service; only the [monitoring service](../../scripts/monitor-service.mjs) can be installed explicitly.

The Web entry listens only on the local machine by default. Model requests, task execution and file operations still use the local backend; static frontend hosting alone cannot run the full workbench. Deploying the backend to a remote server also moves command execution and file operations to that server.

## Updating a source checkout

Run the update commands in the CoworkOS source checkout:

```sh
npm run cli -- update --check
npm run cli -- update
```

The target is CoworkOS's real Git checkout, even when `coworkos` is invoked from another project. The current branch must have an upstream; checks fetch that upstream and compare commits, so a newer commit can be available with the same package version. Detached HEAD, merge/rebase in progress, tracked changes, nonignored untracked files, local-only commits and divergence block updates. Source installations follow their upstream branch; `--channel` applies only to installed release packages.

The CLI prepares `build:cli`; the development App prepares full `build` through Settings → Updates. If the CLI has synchronized the latest commit but the App build is still pending, the App can offer and prepare a full rebuild at that same commit. A Web host should be stopped, updated, then restarted with `npm run ui` to prepare its full browser build.

Candidate dependencies and builds run in an isolated temporary source directory. Preparation failures preserve live source, dependencies and builds.

Publication failures attempt rollback; concurrent edits or rollback failures retain recovery copies and report manual recovery. Ignored user settings/tasks are neither copied into the candidate nor cleaned. The updater does not reset, stash or clean your checkout.

The App checks for an update once after startup and applies only on request. Application flush, running-task checks and backend shutdown belong to the desktop host. Rebuild/relaunch applies the prepared code; an interrupted/failed update must not be reported as installed. Update tests use local Git remotes or fake release responses, with no real repository mutation or release publication.

The development App uses a separate [restart helper](../../scripts/restart-development.mjs) to wait for the old process to exit, refresh the development entry and start the new build. If an older development launcher lacks toolchain metadata, quit the App and refresh it with `npm run desktop` or `npm run desktop:install-dev` before using in-app updates. The host reports this prerequisite before changing source files.

The update implementations are [source transaction](../../scripts/update-source.mjs), [CLI dispatcher](../../scripts/update.mjs), [npm desktop package transport](../../scripts/update-npm-desktop.mjs), [legacy Release download/install](../../scripts/update-release.mjs), [desktop lifecycle](../../desktop/updates.cjs) and [UI](../../web/assets/controllers/desktop-updates.js). Start with `test/source-update.test.js`, `test/development-restart.test.js`, `test/update-npm-desktop.test.js`, `test/package-desktop-npm.test.js`, `test/update-release.test.js`, `test/desktop-updates.test.js` and `e2e/desktop-updates.spec.js`, then run relevant verification. Release feed generation and signing guards are covered by `scripts/update-feed.mjs` and `test/update-feed.test.js`. CLI packages must ship their imported update scripts; desktop-only dependencies do not belong in the CLI bundle.

## Daily change workflow

For delegation, rework, independent review and archival, use the [handoff and evidence guide (Chinese)](../development-handoffs.md). Consult matching [environment pitfalls (Chinese)](../pitfalls/README.md); the [retrospective index (Chinese)](../retrospectives.md) maps earlier findings to current guidance and fixes.

1. Find the behavior owner, consumers and tests in the code map; read target-directory `AGENTS.md`.
2. Reproduce in a temporary workspace and run relevant tests. Fix the owning service/adapter/controller; entrypoints compose dependencies.
3. Add behavior coverage for the failure/new user flow. Async changes cover identity, cancellation, late responses, conflicts and exit/recovery; protocol changes cover both ends.
4. Run focused tests and lightweight `npm run verify`; documentation-only edits need link/format checks. Use `npm run verify:full` for releases or broad changes, plus relevant browser/native/package acceptance.
5. Update the code map, current documentation and roadmap status. Report actual commands, results, skips and remaining limits.

```sh
npm run test:unit -- --list
npm run test:unit -- --file test/application-resource-store.test.js
npm run test:unit -- --match application
npm run verify
```

`test:unit` builds by default. Use `--skip-build` only when an existing complete build matches current source. Repeat `--file` to select several tests; see [local testing](testing-local-run.md) for filter semantics. Passing stale `dist/` does not validate changed source.

## Validation layers

| Command                                                   | Scope                                                                                                                        | When                                                                                       |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `npm run test:unit -- --file test/name.test.js`           | Focused Node behavior/protocol/lifecycle tests; builds by default                                                            | Fast feedback during a change                                                              |
| `npm run verify`                                          | CLI and web asset builds, source hygiene, lint, workbench/Pi types, incremental format and docs links; no behavioral tests   | Default completed-change gate                                                              |
| `npm run verify:full`                                     | One complete build, static checks, release-runner self-tests and the full Node suite                                         | Release acceptance or changes with broad impact                                            |
| `npm test` / `npm run check`                              | Existing Node regression / build and static checks                                                                           | Existing local scripts; no need to repeat after equivalent verify:full on unchanged source |
| `npm run check:ci`                                        | CLI build, source hygiene, lint, workbench/Pi types, incremental format and docs links                                       | Manual GitHub checks; local verify/relevant tests remain the completion gate               |
| `npm run check:source`                                    | Current tracked and nonignored source files; private settings, credentials, personal paths and unwanted outputs/retired docs | Before committing or distributing; Git history is outside its scope                        |
| `npm run check:docs`                                      | Maintained local Markdown file links/heading anchors; no external requests                                                   | Documentation/path edits; `-- --list` prints scope                                         |
| `npx playwright install chromium`                         | Chromium preparation                                                                                                         | First browser run                                                                          |
| `npm run test:browser`                                    | Chromium/Electron user flows; native branches have prerequisites                                                             | UI, HTTP/UI integration, drafts, navigation, collaboration                                 |
| `npm run desktop:pack` then `npm run test:desktop`        | Relocated packaged App, settings, real Pi/local model, exit/restart/simulated upgrade                                        | Desktop host/lifetime/package changes                                                      |
| `npm run test:release -- --list` / `npm run test:release` | Five release sections with version/logs/skips/manual items                                                                   | Release candidate; explicitly enable native/package stages                                 |
| `npm run smoke:coding` / `npm run smoke:multi-subagent`   | Actual endpoint and delegation; consumes model quota                                                                         | Real service/capability acceptance after configuring a connection                          |

Ordinary Node regression defers explicit native desktop/CUA entrypoints and prints reasons. Optional engines may still produce TAP skips. See [local testing](testing-local-run.md) for prerequisites/reports/native commands. Local fixtures validate Pi protocol/lifecycle, not real model capability. Browser passing does not establish clean-machine installation. [package.json](../../package.json) and runners own exact scope.

For a focused browser run, build first, then `npx playwright test e2e/automation-workspace.spec.js --output=.tmp/playwright-workbench`. Concurrent Playwright processes need distinct `--output` directories. Keyless tests must not read personal connections.

## UI conventions

Use layout to distinguish hierarchy, and remove secondary labels or descriptions that repeat it.

Organize interfaces by task stage and action frequency before styling them. Empty or generating states do not expose every unavailable feature; object actions appear with a selection, and tool results appear when that tool is active. Prioritize content in the workspace, allow secondary panels to close, and adapt them to their container width without leaving empty columns or squeezing text into one-character lines. Group actions meaningfully rather than placing every export format, diagnostic and common action at the same level. Screenshot review checks useful content and task paths as well as control bounds and theme colors.

Page and TXT applications share [ui.css](../../web/assets/ui.css) tokens/buttons/status/menu styles; domain CSS uses its own classes. A locally bundled Inter variable font works offline, with PingFang SC, Microsoft YaHei and system fallbacks for Chinese; see the [third-party notice](../../THIRD_PARTY_NOTICES.md#inter-界面字体--interface-typeface) for provenance and licensing. Body text uses 15px, controls 14px, captions 12px, section headings 16px, task-panel and settings dialog titles 18px, and welcome headings 22 to 26px. Weights are 400 for regular text, 500 for headings, and 600 for emphasis, with normal letter spacing and a body line height of 1.8. Dark mode uses a near-black canvas, subtle dividers and solid input surfaces. The desktop sidebar defaults to 232px, and the transcript and composer align to the same reading column.

`ui.css` assembles shared components, then [system-theme.css](../../web/assets/system-theme.css) applies neutral light/dark surfaces and text colors. [settings.css](../../web/assets/settings.css) follows it to unify the overview, model and web search dialogs with shared surfaces, form controls and fixed action bars, always using opaque surfaces. Icons use [icons.js](../../web/assets/ui/icons.js)/the SVG sprite; icon-only controls need `aria-label`, with a preferred 32px hit area.

Without an active conversation, the task panel shows brief getting-started guidance. Runtime usage precedes the team galaxy. Independent editors show the document name in the top bar; narrow editors put document identity and save controls on separate rows.

- Use [menu.js](../../web/assets/ui/menu.js) for arrows/Home/End/Escape/outside close/focus restoration. Use [modal.js](../../web/assets/ui/modal.js) for focus containment and restoration.
- Short forms such as rename, project editing and save-copy use `.app-dialog`, fields, descriptions, errors and actions from [dialogs.css](../../web/assets/dialogs.css). Give inputs explicit labels, distinguish primary and secondary actions, and cover busy, failure, disabled and keyboard focus states without relying on browser-default control styling. Workbench extensions belong to [workbench/dialogs.css](../../web/assets/workbench/dialogs.css), and attachment previews to [attachment-preview.css](../../web/assets/styles/attachment-preview.css). Settings, goals and monitors retain their specialized layouts while sharing theme tokens.
- Keep the conversation title and project context in the top bar. The top bar and sidebar share the [conversation menu](../../web/assets/controllers/conversation-menu.js), grouped into organization, copy/export/open, and archive actions; running or waiting conversations also show Stop task. The copy submenu offers the title, ID, local link, and conversation text. Markdown export retains user/assistant text and omits thinking and raw tool logs. Unread marks remain in local browser storage until the conversation is explicitly opened; `?task=<id>` links select the original conversation. Submenus support left/right arrows and Escape one level at a time, retain their target and focus through refreshes, and use an inline layout on narrow screens. Show disabled actions for unsaved new tasks and hide the menu for independent editors. Start the right task panel collapsed on page load or reload, with a far-right toggle that hides or restores the current conversation’s editor when a workspace exists and otherwise controls the task panel, and global settings in the lower-left sidebar, without a second conversation header.
- Application naming uses [document-name-dialog.js](../../web/assets/workbench/adapters/document-name-dialog.js); preserve input/errors during submission. Save failures/conflicts retain drafts and provide text explanations.
- Keep the composer in normal layout flow, using rounded corners, a distinct surface and a soft shadow to form a floating card. Preserve its shadow during focus and match the surrounding space to the canvas. Messages use remaining height and attachments scroll independently. Streaming preserves DOM identity, focus and reading position. Async actions capture original Task/navigation identity.
- Display actual capabilities/progress/status, without placeholder identities. Web does not simulate Mac window buttons. Use existing primary/danger states.
- Use spacing and neutral surfaces to distinguish containers. Keep one subtle line between each sidebar and the main surface; resize handles strengthen that line on hover, during dragging or on keyboard focus without shrinking their hit area. Put workspace files and view controls in one row, using rounded capsules for the current file and necessary actions. Provide project context and run status through tooltips and accessible status text. Short forms use softly filled inputs and borderless secondary actions while retaining clear focus and error indicators. Reserve thin lines for necessary content boundaries and avoid stacked borders and shadows. Show success with subdued icons and text while preserving the distinctions between completion, stopping and failure. Errors show a concise reason and available recovery actions first; technical details and long logs start collapsed. Preserve expansion, keyboard focus and log reading positions through refreshes.
- Active conversations show a continuous activity indicator and current phase while waiting for the first response, thinking, running tools, or automatically retrying. Completion and stopping end the animation. Tool titles use readable names; unknown tools still display their names.
- Check rendered text contrast in both themes, plus 1440/1280 and 474/320 widths, menus, truncation, keyboard focus, reachable controls and overflow with real browser coverage. Review screenshots for surface hierarchy and status emphasis.

TXT state and DOM are separate; its document session owns save and collaboration. Use domain owners from the code map rather than adding application state machines to `web/app.js`.

## Troubleshooting

| Symptom                                        | First inspect                                                                 |
| ---------------------------------------------- | ----------------------------------------------------------------------------- |
| Save failure/409                               | Revision, external/shared writes; preserve draft before rereading             |
| Agent lacks document/tools                     | Resource binding, MCP, first `before_agent_start` and later `context`         |
| Waiting/stop/recovery errors                   | Task/Run events, inbox, questions/workers/jobs, process exit, checkpoints     |
| Draft/resource missing after restart           | Workspace/catalog/tab paths, desktop data and draft mirror                    |
| Model launch failure                           | Endpoint/protocol/model/parameters/env and redacted errors; never full config |
| Late UI response replaces another conversation | Captured Task/draft identity, navigation token and serialization              |

Reports include version/commit, OS, entrypoint, reproduction, redacted logs and test paths. Trace paths are in the workspace reference.

## GitHub Actions

Keep one long-lived main branch; temporary feature/fix branches merge through PRs and are deleted afterwards. Main is reviewed integration code, while fixed tags/Releases identify distributions. See [version management](../beta-release-process.md) (Chinese).

[Default workflow](../../.github/workflows/test.yml) is manual-only, using one Ubuntu + Node 24 job. Pushes and PRs do not automatically run static checks. Dependency installation skips the Electron binary, then runs `npm run check:ci`: `build:cli`, source hygiene, lint, workbench/Pi types, incremental formatting and maintained documentation links.

Complete Node regression, browser, native engines, actual models and package experience are validated locally. Use lightweight `npm run verify` and focused tests for daily changes, and `npm run verify:full` for releases or broad changes; add relevant acceptance layers and include evidence in the PR. Manual routine GitHub checks provide build/static feedback.

[Internal Mac package](../../.github/workflows/internal-mac.yml) is manual and only builds/uploads an arm64 internal DMG/checksum. [Release Mac DMG](../../.github/workflows/release-mac.yml) builds DMG/CLI candidates and checksums on a version-tag push and uploads a GitHub Release draft for maintainer review and Publish. A ZIP, checksum and Mac update feed are generated only with explicitly configured and verified Developer ID signing. Neither workflow runs full regression, browser or desktop smoke; the default configuration remains an unsigned arm64 candidate. Install and validate candidates locally using the [Mac release guide](../mac-release.md). Release candidates require installation and actual-task acceptance; branch protection requires separate configuration.

## Mac Release drafts from version tags

Release tags must equal `v<package version>`, with matching package/lock versions. The workflow builds the tagged commit and uploads DMG/CLI candidates and checksums to a draft Release for review; signed builds add the ZIP and update feed. Maintainers validate the candidate and choose its release classification before publishing. The default package configuration is unsigned and does not notarize builds; the signed ZIP updater requires signing and separate installation acceptance.

Manual retry accepts an existing version tag and replaces assets only while the Release remains a draft. Published versions require a new version/tag. Version commands, draft review and retry steps are in the [Mac release guide](../mac-release.md#版本-tag-与-release-草稿).

`desktop:pack` / `desktop:dist` package the text workbench and complete orchestration runtime. CAD, Blender and PPT components are excluded. See [capabilities](builtin-capabilities.md).
