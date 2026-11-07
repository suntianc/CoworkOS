# CoworkOS contributor entry point

[中文](AGENTS.md) | English

This guide is for contributors and coding agents. Users start with [README](README.md). Product agent prompts and skills live under `.pi/` and are separate from repository development instructions. `AGENTS.md` is the canonical instruction file; this page is its English translation.

## Start a change

1. Use the [code map](docs/en/code-map.md) to find the implementation owner, consumers and tests before adding branches to entrypoints.
2. Read the target directory's `AGENTS.md`; read both sides when crossing directories.
3. Code, tests and [architecture](docs/en/architecture.md) define current behavior. Choose work from current issues and acceptance criteria.
4. Reproduce the problem, edit the owning module, run relevant behavior tests and local verification, then report commands, failures and skips actually observed.

## Repository map

| Location                                        | Responsibility                                                | Local instructions                           |
| ----------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------- |
| `src/cli/`, `scripts/atria.mjs`                 | User commands, launchers and smokes                           | [Code map](docs/en/code-map.md)              |
| `src/dashboard/`                                | Local HTTP/SSE, composition and Run orchestration             | [Service](src/dashboard/AGENTS.md)           |
| `src/runtime/`                                  | Task/Run, scheduling, recovery, models and Pi sessions        | [Runtime](src/runtime/AGENTS.md)             |
| `src/applications/`                             | Registration, resources, revisions, windows, MCP and adapters | [Applications](src/applications/AGENTS.md)   |
| `src/software/`, `src/gui/`, `src/security/`    | Software engines, native interaction and permissions          | [Integration](docs/software-integration.md)  |
| `src/domain/`, `src/storage/`, `src/workspace/` | Domain types, persistence, workspaces and artifacts           | [Data layout](docs/task-workspace-layout.md) |
| `.pi/`                                          | Product Pi composition, domain tools and skills               | [Pi](.pi/AGENTS.md)                          |
| `web/`                                          | Shared Web/Desktop UI, controllers and editors                | [Frontend](web/AGENTS.md)                    |
| `desktop/`                                      | Electron windows, trusted IPC and backend lifecycle           | [Desktop](desktop/AGENTS.md)                 |
| `test/`, `e2e/`                                 | Node regressions and browser/native acceptance                | [Testing](test/AGENTS.md)                    |
| `docs/`                                         | User guides, development conventions and API references       | [Documentation](docs/AGENTS.md)              |
| `scripts/`, `.github/`                          | Builds, verification, packaging and CI                        | [Development](docs/en/development.md)        |
| `vendor/`                                       | Third-party source                                            | Keep product business logic elsewhere        |

Directory guides and specialized API references currently use Chinese. They are authoritative for those modules; the English code map and architecture summarize their boundaries.

## Implementation rules

- CLI and Desktop share services. Shared modules must not import CLI entrypoints; runtime and applications must not import Dashboard. ESLint enforces these directions.
- Routes validate, call services and map responses. Run/ProcessHost own processes. Importing a service must not bind ports, install signals or issue model requests.
- Extend the owning service, Adapter, controller or `.pi/runtime/tools/`. Keep entrypoints focused on composition; do not centralize new capabilities in `web/app.js`, Coordinator or the Pi extension.
- Use strict TypeScript and ESM with `.js` suffixes in local TS imports; Desktop keeps `.cjs`. Validate external JSON, files, tool arguments, HTTP and IPC at their entrypoints. Errors must be actionable and must not reveal secrets.
- When changing persisted formats, events, HTTP, Adapter or IPC interfaces, update producers and consumers together. Document migration and recovery for breaking changes; do not reinterpret existing fields in place.
- Do not repair products by editing Pi in `node_modules` or generated files. Record origins, versions and local changes for vendored code.
- Keep public entrypoints, licenses, example configuration and tool configuration at the root. Put maintained technical documentation in `docs/`, and build/launch scripts in `scripts/`. Do not commit generated outputs or machine-specific bindings as source.
- Format only changed files. Avoid unrelated reformatting, dependency upgrades or module moves.
- UI: avoid unnecessary secondary labels and descriptions. Let the layout do the explaining.

## Interface design

Avoid unnecessary secondary labels, explanations, helper copy, descriptions and redundant microcopy. Let layout, visual hierarchy, spacing and clear primary actions do the explaining.

- Prefer strong visual hierarchy and self-explanatory structure over explanatory text.
- Do not add slogans, tutorial paragraphs or help descriptions beneath every section by default.
- When extra information is necessary, prefer an info icon with a tooltip over permanently visible secondary text.
- Keep necessary form labels and accessible names for screen readers; visual simplicity must not compromise accessibility.
- Dangerous or irreversible actions, including deletion, payment and permanent submissions, must retain clear consequence warnings.
- After removing explanations, first-time users must still understand where to click next and what will happen.
- When revising an interface, remove redundant labels and explanations first. If clarity decreases, improve layout and button wording.

## Verification and delivery

Use Node >=22.19.0 and `npm ci`. Match validation to the change: documentation-only edits run `check:docs` and `format:check`; behavior changes run related tests and lightweight `npm run verify` (CLI and web asset builds, source hygiene and static checks). Explicitly run `npm run verify:full` for release acceptance or changes with broad impact; it performs a complete build, release-runner self-tests and the full deterministic Node suite. Do not repeat the full suite for every small edit. `npm run test:unit -- --match model` selects test files; `npm run check:docs` checks documentation links; `npm run check:source` checks current source for private configuration, credentials, personal paths and generated/retired documents. See [local testing](docs/en/testing-local-run.md) for the full command inventory. Test doubles do not replace lifecycle tests; browser, native, real-model and clean-install evidence are separate.

Routine GitHub checks are manual-only and do not run automatically on pushes or PRs. They execute the lightweight static checks in `npm run check:ci`. Run complete regressions and release acceptance locally and record evidence. The manually triggered Mac workflow builds and uploads to a draft Release; see the [Mac release guide](docs/mac-release.md). CI passing does not mean the complete test suite passed; do not add browser, native or cross-platform test matrices by default.

Change descriptions include the problem and resulting behavior, affected modules/interfaces, checks run and unverified scope. Update the relevant guide and code map when changing commands, features, paths or interfaces. The roadmap records status, next work and acceptance criteria.

`config.json`, `.cowork/`, `.tmp/`, `applications/`, `workspace/`, `task-*/`, supervisor locks and user data are not source. Do not read real secrets, delete running data, clean user tasks or include them in packages. Tests use their own temporary directories and local fake model servers.

Record independent evidence for third-party notices, distribution channels, signing/notarization, clean-machine installation and real model connections. Formal/stable releases satisfy the corresponding P0 gates. A limited public beta follows the contributing policy and declares its support, ad-hoc/non-notarized installation and pending acceptance; incomplete checks must not be reported as passing. Original CoworkOS code uses MIT; see [third-party notices](THIRD_PARTY_NOTICES.md) for exceptions. Follow [contributing](CONTRIBUTING.en.md) and the [Mac release guide](docs/mac-release.md).
