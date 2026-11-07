# Local verification and release acceptance

English | [简体中文](../testing-local-run.md)

Match validation to scope: documentation-only edits need `npm run check:docs` and `npm run format:check`; behavior changes need focused tests and lightweight `npm run verify`. Use `npm run verify:full` for release acceptance or changes with broad impact. Browser, native window, real model and final package checks have separate entry points. See the [development guide](development.md) for environment and Python attachment dependencies.

## Daily development

```sh
npm ci
npm run verify

# Releases or broad changes: complete build and full regression
npm run verify:full

# Print the quick/full execution plan without building or testing
npm run verify -- --list
npm run verify:full -- --list
```

`verify` runs `build:cli`, `build:web-assets`, `lint`, `check:workbench`, `check:extensions`, `format:check`, `check:docs` and `check:source`, without behavioral tests. `build:web-assets` prepares KaTeX and Markdown dependencies, but not native desktop resources. `verify:full` (equivalent to `verify -- --full`) uses one `build:full`, then static checks, `test:release:runner` and the complete Node suite. Both modes stop at the first failure and preserve its exit code. Quick checks do not certify related behavior or the full suite.

`format:check` checks changed files; Manual CI uses `FORMAT_BASE=HEAD^` to compare the previous commit; set `FORMAT_BASE` locally for a different baseline.

`check:docs` checks local file links and Markdown heading anchors in maintained Chinese/English documentation and module AGENTS files. It ignores code examples and does not request external URLs. Retired documents are no longer required sources; removing a document also requires updating its consumers, and stale links still fail. Third-party license links use versioned upstream sources; license retention inside release artifacts is checked separately.

`npm run check:source` scans current tracked and nonignored first-party text for private paths, credential-shaped strings, numeric gateways and private/generated directories; it does not scan Git history.

Run `npm run check:docs -- --list` to see the scope. Add new maintained guides to the list in `scripts/check-docs.mjs`; English documents under `docs/en/` and module AGENTS files are discovered automatically.

Focus on relevant files during development:

```sh
# Pure script tests without compiled runtime imports need no product build
node --test test/repository-checks.test.js

# List matching files; an empty selection is a failure
npm run test:unit -- --list --match application-

# Build first, then run exact source test files; --file can be repeated
npm run test:unit -- --file test/application-api.test.js
npm run test:unit -- --file test/p0.test.ts

# Explicitly reuse a complete build matching the current sources
npm run test:unit -- --skip-build --match conversation
npm run test:unit -- --skip-build --file test/application-resource-store.test.js --concurrency 1
```

`--match` is a case-sensitive file-path substring. `--file` is an exact repository-relative source test path. They cannot be combined. Unknown files and empty matches fail before building.

The runner discovers `.test.js`, `.test.mjs` and `.test.ts` files recursively under `test/`. TypeScript tests run their compiled output; p0/p1/p2 retain their script assertions. The release runner under `test/release/` is invoked separately, and its self-tests are included in `verify:full`. New tests should use isolated fixtures, temporary directories and fake model services.

Ordinary Node checks print deferred native work: `computer-native.test.js` and the visible desktop development relaunch variant. The existing release catalog controls these gates. Ordinary runs disable the desktop native variant even when its environment variable is set on the developer machine; use `--native` below for real window operation.

Other Mac-specific tests still run or explicitly skip according to their own prerequisites. Exit code 0 does not validate skipped checks. Record actual counts and skip reasons for the current run.

`npm test` and `npm run check` remain available for existing Node and static checks. Running both rebuilds twice; use `verify:full` when explicitly requesting the complete suite.

Routine GitHub checks are manual-only with no automatic push/PR triggers. Manual runs use lightweight `npm run check:ci` for the CLI build, lint, types, incremental format, documentation links and source hygiene. Full Node, browser, native, actual-model and release acceptance run locally; lightweight CI passing does not certify those behaviors. See [development](development.md#github-actions) for triggers.

For version-tag/Release changes, start with `npm run test:unit -- --file test/release-metadata.test.js`. It uses temporary Git repositories to validate versions, tags, commit identity and Actions outputs without accessing remote Releases. Actual Actions logs establish uploads/draft retries; see [release steps](development.md#mac-release-drafts-from-version-tags).

## Performance regressions

Use isolated data to check read counts, request concurrency and DOM retention before timing requests. This separates frontend costs from model or native computation load. With a current build, run:

```sh
node --test test/workspace-directory-performance.test.js test/application-tab-read-cost.test.js test/resource-mapping-noop.test.js test/event-stream-ledger-performance.test.js test/event-stream-review-regressions.test.js test/visible-poll.test.js test/connection-controller.test.js
npx playwright test e2e/dashboard-polling.spec.js e2e/editor-visibility-polling.spec.js e2e/binding-menu.spec.js --workers=1 --output=.tmp/browser-performance
```

- The directory fixture contains 57 assigned conversations: read each Task once per list and share project catalogs within the batch. The next request must observe renames and new Tasks.
- The application fixture has 40 windows across two roots: discover roots once per revision request; unchanged holding references must not be rewritten. Lists and revision checks have file-read budgets. Verify first-resource creation races, external edits, aliases and transaction recovery separately.
- Idle SSE must not reread ledger bodies, and initial connections read only the historical tail. An appended burst of 600 records must all be delivered, including with an initially empty/missing ledger; file replacement must keep working. A detail tail of 30 ordinary short records needs only one 64 KiB range, including short reads, Chinese, emoji and a missing final newline. Closed connections must stop response writes and further log-body reads.
- Browser cases cover nonoverlapping slow polls, retained drafts and unchanged detail DOM, and repainting a collapsed panel on expansion. Hidden pages/editors stop automatic reads and refresh immediately when visible; SSE, explicit loading, saves and autosaves retain correct behavior.

Timing comparisons require matching data, open windows, cold/warm state and runtime load. Record response status, size and elapsed time without printing user content or configuration. Tests use their own temporary workspaces and local services; measure native startup and actual model latency separately.

## Browser, native and real usage checks

```sh
npx playwright install chromium
npm run test:browser

# Select a browser file after a current build
npx playwright test e2e/automation-workspace.spec.js --output .tmp/browser-workbench

# Mac native windows/input require existing permissions and an unlocked desktop
npm run test:release -- --native --stage app,applications
```

Browser checks build and run Playwright; native variants follow the tests and release catalog prerequisites. Use independent `--output` directories for parallel local browser processes. Real model smoke checks consume model service resources; configure them explicitly using the [model configuration](configuration.md). Final installation, upgrades, signing/notarization and manual experience require separate records using the [Mac release guide](../mac-release.md).

`npm run test:desktop` verifies TXT, Pi/local-model tasks, save/recovery, quit/restart and relocated upgrades. With a current candidate, run `ATRIA_DESKTOP_APP=.tmp/release/mac-arm64/CoworkOS.app node scripts/desktop-smoke.mjs` to avoid rebuilding.

For the settings stage on an existing candidate package, run `ATRIA_DESKTOP_APP=.tmp/release/mac-arm64/CoworkOS.app node scripts/desktop-smoke.mjs --settings-only`. It checks the first save, redacted read and rejection of model/search changes during a run; the other desktop smoke stages are skipped.

The development-entry relaunch, composer and model-connection native tests use a temporary App, isolated data and Chromium's test keychain to verify encrypted client credentials, ciphertext compatibility, drafts and native process lifecycle without prompting for real keychain access under temporary signatures. This isolation applies only to tests. The product uses the system keychain; actual permission prompts, signed packages and upgrades between versions need separate acceptance.

## Five-stage release acceptance

The release runner groups existing deterministic tests into basic, CLI, App, applications and user cases, saving logs and reports. It does not call paid models or request additional system permissions. Detailed planned scenarios remain in the [case catalog](../testing-case-catalog.md) and [application acceptance manual](../testing-application-release.md); these detailed reference documents are currently in Chinese.

```sh
npm ci
npx playwright install chromium
npm run test:release -- --list
npm run test:release

# Select stages; a shared build remains the default
npm run test:release -- --stage cli
npm run test:release -- --stage app,applications

# Include isolated native Electron/window tests on Mac
npm run test:release -- --native

# Also build CLI tgz and Mac DMG candidates, then manually install them
npm run test:release -- --native --packages

# Debug an existing complete build; the report records build omission
npm run test:release -- --stage cli --skip-build

# Runner regression only; verify:full includes it, ordinary npm test/CI does not
npm run test:release:runner
```

`--list` does not build, run tests or write a report. A normal run builds once, then groups tests by stage. Node tests share recursive discovery with the daily runner, including `.test.js`, `.test.mjs` and `.test.ts` under `test/`, excluding the separately invoked `test/release/`. TypeScript tests run their compiled outputs, and each source file runs once. Browser discovery covers `e2e/*.spec.js`. The basic stage also runs p0/p1/p2, static checks and runner self-tests. Native builds use the existing Mac toolchain.

`--native` requires an unlocked Mac with existing system permissions and visible test windows. Mixed files retain Web/protocol coverage while native variants remain deferred by default. The report lists deferred files/variants and actual test skips. `--packages` only builds candidates; it does not validate their final installation, upgrades, signing/notarization or real model behavior.

## Reading reports

Each execution writes `.tmp/release-tests/<timestamp-and-random-id>/`:

| File                       | Evidence                                                                                                                                                               |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `report.json`              | Source commit/dirty flag/digest, environment, options, actual commands/files, step results/counts, planned case mappings, pending acceptance, candidate package hashes |
| `summary.md`               | Engineering outcome, step duration/skips, manual and deferred work                                                                                                     |
| Step `.log`                | Local stdout/stderr and the first failure; redact before sharing                                                                                                       |
| Browser step `.json`       | Actual Playwright results; retry passes remain flaky                                                                                                                   |
| Browser step `-artifacts/` | Isolated browser artifacts, failure traces and records retained across stages and reruns                                                                               |

Engineering outcomes are `passed`, `passed_with_skips`, `failed`, `interrupted` and `incomplete`. A failure, timeout or missing valid test statistics stops later steps. Ctrl-C terminates the current process group. Each step defaults to a 1,800-second timeout; use `--timeout-seconds N` to change it.

Exit code 0 means selected engineering steps passed, possibly with explicit skips; 1 means failed/incomplete, and 130 means interrupted. `--strict` returns 2 when engineering checks pass but release evidence remains incomplete. Passing one stage does not validate the complete release.

Release readiness remains INCOMPLETE. Catalog coverage still needs review, and the runner does not establish real-model, final-package or manual acceptance. File passes are engineering evidence. Case mappings remain `partial_mapping` or `planned`; maintainers review release evidence separately.

A source change during execution records the difference and changes an otherwise passing result to `incomplete`; rebuild and save a fresh report.

## Maintaining the release catalog

`test/release/catalog.json` owns stage rules, test anchors and manual checks. New Node tests under `test/` and root browser files are discovered automatically; unmatched Node files go to basic and unmatched browser files go to App. Add stage rules for new domains or user tasks. Runner tests verify single-stage assignment, compiled execution paths, ESM failure propagation and existing case/file mappings.

For a feature, add user actions and acceptance criteria to the catalog documentation, then add tests and anchors. Keep plans, actual execution and manual confirmation distinct. Computer Use supports a persistent policy within one desktop host and Task-scoped window sessions. Isolated real Pi/HTTP tests use a controlled clock for renewal; browser tests cover settings and takeover. Unlocked native input, clean-install first permissions, actual App restart and signed upgrades require independent evidence.

## In-app update acceptance

Public checking/publishing regressions live in `test/update-release-public.test.js` and `test/public-release-publish.test.js`; desktop coordination, save gates and installation boundaries are in the desktop update tests. Ordinary Node verification does not replace real Apps. Explicit native checks use only disposable App copies, DMGs and profiles:

```sh
ATRIA_MANAGED_UPDATE_NATIVE=1 node --test test/desktop-update-install.test.js
ATRIA_PUBLIC_APP_UPDATES_SMOKE=1 ATRIA_DESKTOP_APP=.tmp/release/mac-arm64/CoworkOS.app npx playwright test e2e/public-app-updates-desktop.spec.js --workers=1 --output=.tmp/public-app-update-native
```

The packaged test maps fixed public URLs to local HTTP only inside its test process, preserving production URL and integrity validation. It exercises the real download, DMG/signature checks, exit, installer helper, replacement, new-process receipt and version/draft recovery after reopening. Public network access is separate: after publication, anonymously verify the real static feed, installers and complete SHA-256. Clean-machine installation, Gatekeeper, Developer ID/notarization and actual providers remain independent checks.
