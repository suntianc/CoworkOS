# Contributing and development conventions

English | [中文](CONTRIBUTING.md)

Use Node >=22.19.0 and `npm ci`. People and coding agents start with [AGENTS](AGENTS.en.md), the [code map](docs/en/code-map.md), and target-directory instructions. Source uses [MIT](LICENSE); dependency origins/licenses are in [third-party notices](THIRD_PARTY_NOTICES.md).

## Definition of a completed change

1. Define the triggering scenario, resulting behavior, owning module and consumers. Include concrete scope and acceptance criteria.
2. Reproduce in isolated data and fix the owning service/adapter/controller. Domain tools have their own modules; entrypoints compose dependencies.
3. Add meaningful behavioral coverage for failure, cancellation, async identity, conflict or recovery where affected; use the code map to select tests.
4. Match validation to scope: documentation-only edits need link/format checks; behavior changes need related tests and lightweight `npm run verify`. Run `npm run verify:full` for releases or broad changes; add UI/native/package acceptance where relevant and report failures/skips.
5. Update current docs and code map; describe problem, outcome, validation and limitations.

```sh
npm run test:unit -- --file test/name.test.js
npm run verify
# UI / HTTP-UI integration; install Chromium first if needed
npm run test:browser
# Mac host, exit/recovery or package changes: Apple Silicon Mac
npm run desktop:pack
npm run test:desktop
```

Verify owns ordinary local engineering checks. Native, actual model and five-section release checks remain separate; see [local testing](docs/en/testing-local-run.md). A skip does not certify a platform; local model fixtures do not certify actual model capability.

## Code and interface rules

- TypeScript strict, ESM and `.js` local TS imports; Electron host remains `.cjs`. Validate external JSON/files/HTTP/IPC/model tool arguments at entry. Narrow unknown inputs; add no explicit any.
- Shared services do not import CLI; runtime/applications do not import Dashboard. Routes spawn no processes, Run writes no HTTP responses, and importing a service opens no port or installs signals. ESLint/architecture tests enforce direction.
- Extend existing tools/adapters/drivers/stores/controllers. Before splitting, assign ownership for state, persistence, processes and presentation. Do not concentrate new behavior in Coordinator, Pi entry or `web/app.js`.
- Update producers and consumers for HTTP/event/adapter/software/IPC/persistence changes. Define defaults, compatibility and recovery. Changes to field meanings, revisions or serialization require explicit version/migration.
- Back up before migration; test upgrade from previous version, failure preserving old data and rejecting future-version downgrade. Update version records only after success. Shared writes use revision CAS and preserve drafts on conflict.
- Lifecycle tests include real subprocesses or Pi hooks and assert observable outcomes, durable state and failure recovery. Avoid assertions that repeat the implementation.
- Do not patch Pi `node_modules` or generated files to fix product code. Third-party changes record upstream version/origin/local differences and update notices.
- Format only changed files. `npm run format` and `format:check` follow the incremental CI policy; avoid unrelated mass formatting or dependency upgrades.

Never commit model keys, private settings, user workspaces/traces, test outputs or release packages. Do not log secrets or full configuration. Tests use temporary directories/local fixtures and never clean real tasks/resources.

## PR, review and release

Keep one long-lived main branch. Temporary feat/fix branches start from main and merge through PRs, then are deleted. Main represents reviewed integration code; fixed tags and Releases identify user versions. See [version management](docs/beta-release-process.md) (Chinese).

Keep each PR focused on one complete change. Use the [PR template](.github/pull_request_template.md): final problem/outcome, consumers, data impact, actual validation and uncovered scope. Review roles are in [module ownership](docs/module-ownership.md) (Chinese). Cross-interface work involves both ends; maintainers review until real people are assigned. Role/workflow files do not prove CODEOWNERS/branch protection is enabled.

After local verify, add relevant browser/platform/native/install acceptance and include evidence in the PR. Routine GitHub checks are manual-only, running lightweight `check:ci` build/static checks without automatic push/PR triggers; the Mac workflow uploads only Release drafts, which maintainers publish after acceptance. Local behavioral requirements remain unchanged. Triggers are in [development](docs/en/development.md#github-actions).

Before making the corresponding product/platform commitments, a formal/stable release satisfies the following P0 gates: license/notices, distribution, actual models, Developer ID signing/notarization, clean installation and upgrade recovery. A public beta with limited scope documents its support, installation method and pending acceptance separately; it does not certify that every stable-release P0 gate is complete.

A public beta still requires source, third-party license and package-content review, a reviewed commit/tag, an artifact manifest and SHA-256 checksums.

The initial Mac beta is an ad-hoc signed DMG targeting macOS 14+ Apple Silicon, without Developer ID or notarization; first installation uses the DMG and normal Gatekeeper approval. In-app updates can verify and replace the App in user-writable locations while retaining a previous-App backup and preserving system security. No Developer ID signed ZIP/feed is produced without that signing identity. CLI requires Node >=22.19.0; declare tested platforms from the candidate's actual evidence, without inferring other platforms from compilation.

Release notes separately record completed local verify, protocol/browser regressions, native/package checks and their versions/environments, alongside pending acceptance. Actual model connections and installation/upgrade on another machine without a development environment still require independent acceptance. Local fake models, packaging and minimum-OS configuration do not certify those results. Unexecuted, failed, skipped or older-candidate results must not be reported as passing this candidate.

## Documentation and languages

See [documentation policy](docs/documentation.md) (Chinese) for fact ownership/sync and the [index](docs/en/README.md) for navigation. Critical user/developer entrypoints have Chinese/English versions. Update both when changing commands, support, boundaries or acceptance criteria. Specialized API references are currently mainly Chinese and are labeled accordingly.
