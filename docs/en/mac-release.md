# Mac builds, releases and acceptance

[中文](../mac-release.md) | English

The App targets macOS 14+ on Apple Silicon. Electron/Node is included. Current beta archives use ad-hoc signing, with no Developer ID signing, Apple notarization or accepted Intel build. Release notes must state the support scope and unfinished acceptance. Installation and model configuration are covered in [getting started](getting-started.md) and [configuration](configuration.md).

## Candidate archives

Prepare Node and npm on a supported Mac build machine; offline full archives also require uv:

```sh
npm ci
npm run verify
npx playwright install chromium
npm run test:browser
npm run desktop:pack
npm run test:desktop
npm run desktop:dist
# Separate internal fixture acceptance; does not certify the default archive.
npm run test:desktop
```

`desktop:pack` writes `.tmp/release/mac-arm64/CoworkOS.app`. `desktop:dist` creates and verifies `release/CoworkOS-<version>-mac-arm64.dmg` and SHA-256. Local builds never upload or publish. The hidden build directory avoids duplicate Spotlight/Launchpad installations.

`npm run test:desktop` checks the host, TXT creation/edit/save, Pi with a local model, drafts, quit/recovery and relocated upgrades. Domain editors and component installation are excluded.

## App tags and draft Releases

The default release builds on a local Apple Silicon Mac to avoid hosted macOS minutes. Complete local regression before tagging, then install dependencies, check out the clean version tag, and run `npm run release:local -- v<version>`. The command validates the tag and versions, builds the DMG, CLI and npm archives, and uploads a reviewable Release draft. After reviewing its assets, manually run the lightweight Ubuntu npm OIDC workflow; keep the npm Environment approval, then publish the GitHub Release draft after npm verification. Publish the separate public distribution release/update pointer separately when this version requires it. Pushing a tag does not start a hosted Mac build. Beta/rc tags use Pre-release status.

The [Mac release workflow](../../.github/workflows/release-mac.yml) remains available as a manual cloud fallback. It rebuilds the candidate on macOS 15 arm64 and consumes hosted macOS minutes.

Review and commit release source, documentation and validation before tagging. Follow the [version process](../beta-release-process.md) (Chinese) and existing release notes. Use a new version to repair an already-published artifact; never overwrite published assets or move a published tag. The npm workflow downloads and verifies locally built npm archives from the draft, publishes them in order, and checks the public registry. Publish the GitHub Release draft after reviewing the npm results and assets.

npm may accept an upload before the version becomes publicly visible. Registry verification retries and checks each archive's SHA-512. If processing outlasts verification, run the workflow from `main` with the same tag and `verify_only` enabled to verify accepted packages without republishing them.

## App updates and signing

Settings → Updates in the installed App points to a local manual upgrade and performs no remote update check. Back up data, finish tasks and stop the standalone backend, retain the old App, then install a local DMG; see [installation](installation-reference.md#updates). Source updates require a clean fast-forward checkout; see [development](development.md#updating-a-source-checkout). Production signing, notarization and automatic updates belong to P6.

The CLI first installer can use an npm platform package and verifies registry SRI, the file list and DMG SHA-256. It does not replace an existing App. The release and update modules below remain for legacy clients and later acceptance; they are not the installed App update path for this candidate.

Older Apps have their GitHub update URL fixed in the old binary. Publishing an npm package does not change that URL. Keep the legacy GitHub update flow for historical Apps that can still reach it; users who cannot use the old source must migrate once using the [installation guide](../getting-started.md). Do not describe this migration as an automatic update.

The historical managed updater implements candidate verification, replacement after exit and rollback; this installed App does not enable that entry.

Prepare and publish the next npm installer/App update in this order. The platform tarball contains only the matching DMG, license and version/checksum manifest; the CLI tarball contains the installer code. Complete candidate regressions, DMG acceptance and isolated npm installation first. Publish the desktop package, read its registry metadata anonymously and verify a complete install, then publish the CLI package:

```sh
VERSION=0.1.1
ATRIA_DESKTOP_NPM_PACKAGE_DIR="$PWD/.tmp/npm-release" npm run desktop:npm:pack
ATRIA_PACKAGE_DIR="$PWD/.tmp/npm-release" npm run npm:pack
npm publish ".tmp/npm-release/coworkos-desktop-darwin-arm64-${VERSION}.tgz" --access public
npm publish ".tmp/npm-release/coworkos-app-${VERSION}.tgz" --access public
```

Published versions are immutable. Package `publishConfig` selects the `latest` or `beta` tag; after publication, use anonymous `npm view` to verify the version, platform restrictions, dist-tag and integrity metadata. Before publishing the CLI, exercise the real npm transport through the installer; App update provider acceptance belongs to P6. An npm release does not rewrite the URL inside an older GitHub-update client; build a compatible bridge release or follow the one-time migration guide.

GitHub DMG/CLI Releases and the static update pointer remain for legacy clients and explicit manual archives. For a reviewed clean tag, generate provenance with `node scripts/release-artifacts.mjs` and run `npm run release:publish:public`; the publisher compare-and-swaps `updates/coworkos-latest.json` and never replaces published assets or moves the pointer backwards.

The maintainer-only publisher uploads eight explicitly allowed ad-hoc artifacts (DMG, CLI, signing report and provenance, each with SHA-256), verifies server digests, publishes the release, and then updates the static feed with a compare-and-swap content SHA.

Published versions are immutable; the feed cannot move backwards. The public Git branch contains download information and update metadata, never the private development checkout or user data.

Current public publishing rejects Developer ID ZIP/feed combinations until their explicit cross-repository asset contract and acceptance are added.

Maintainers explicitly select a Developer ID Application identity using `CSC_NAME`; optional Actions credentials are `CSC_LINK` and `CSC_KEY_PASSWORD`. A failed, ad-hoc or development signature cannot produce the signed update ZIP. With no explicit identity, automatic signing discovery is disabled and only the DMG path is used. Certificates and private keys never enter source.

Signing alone does not establish notarization, Gatekeeper acceptance or real old-to-new upgrade success.

## Data and installation acceptance

Users drag CoworkOS from DMG into Applications. Data remains under shared `~/.atria/`, relocated with `ATRIA_HOME`; external project originals require their own backups. Replacing the App preserves documents, conversations, settings. Back up important data before upgrades and verify recovery after restart. See [storage layout](../task-workspace-layout.md) (Chinese).

The selected execution host stores model and search keys in `credentials.json` (0600) beside its configuration; settings APIs return redacted status. Electron safeStorage encrypts client session credentials, and the renderer accesses the selected backend through the trusted host. See [connection storage](configuration-reference.md#connection-storage-and-compatibility) for boundaries and migration. Gatekeeper may require the system's explicit approval flow for the current beta. Stable distributions still require Developer ID signing, notarization, stapling and downloaded-quarantine acceptance. Do not disable system protections.

Actual model connections, a separate clean machine, interruption/upgrade recovery, source/license review and final artifact hashes are independent acceptance evidence. Skipped checks and protocol fixtures cannot be reported as passed. The App and development runtime omit the speech helper, microphone/speech privacy descriptions and audio-input entitlement. Electron’s generic system-audio capture description remains; Computer Use retains separate screen and accessibility permissions. Inspect the final App resources and signature with its hash. The [Chinese release guide](../mac-release.md) contains the detailed native resource and acceptance checklist.
