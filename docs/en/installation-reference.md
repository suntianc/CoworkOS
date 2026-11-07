# Installation, updates and troubleshooting

[简体中文](../installation-reference.md) | English

For first installation, see the [Mac App](getting-started.md) or [CLI quickstart](cli-quickstart.md).

## Name and compatibility

The product is now CoworkOS, with the same logo. `coworkos` is the primary command; Release archives retain `atria` as a compatibility alias. The npm package exposes only `coworkos`.

Starting the CLI or running `coworkos doctor` refreshes legacy search adapters to the current runtime path. Only product-owned scripts are replaced; user-installed tools and symbolic links are preserved.

The existing `~/.atria/` home, `ATRIA_*` environment variables, desktop bundle ID, system keychain identity and persisted format identifiers remain stable. Existing configuration and tasks need no migration; legacy `Atria` / `Atria Dev` data directories are still recognized. GitHub repository URLs and historical release assets retain their real addresses. New builds use the CoworkOS application name and `coworkos-cli` archive name (the Release archive retains its internal package name `atria-cowork-cli` for upgrade ownership; the npm registry package is `coworkos-app`), and can read legacy update assets.

An older App's update URL is stored in its binary. Current installed Apps use a local DMG for manual upgrades; existing user data stays in its data directory.

The old source updater also rejects the new project name. For the first rename upgrade, save documents and finish tasks, then run `git pull --ff-only`, `npm ci` and `npm run build` in a clean checkout with an upstream branch, and restart. The new updater accepts the one-way transition from `cowork-harness` to `coworkos`, while rejecting unrelated project identities and the reverse rename.

## Updates

Save documents and finish running tasks before updating.

Upgrade the Mac App manually from a local DMG:

1. Back up `~/.atria/` (or the actual `ATRIA_HOME`) and external projects, then finish running tasks. For each running data root, use a matching CLI to run `coworkos backend stop` and confirm `stopped` or `absent`; then quit the App.
2. Verify the DMG SHA-256 and open it. Rename the old App to retain it, then drag the new App to the original installation directory. App resources and user data are separate.
3. Open the new App and check connections, conversations, attachments and settings. If startup or data validation fails, quit the new App, restore the retained old App and any needed data backup, and retry.

See [development](development.md#standalone-backend) for standalone backend start, status and stop. Production signing, notarization and automatic updates belong to P6.

For an npm installation, exit the CLI and update with:

```sh
npm install -g coworkos-app@latest
```

`coworkos update --check` checks the npm tag; `coworkos update` prints the matching npm command. The npm installer never replaces the independent desktop App; upgrade the App manually as above.

For a Release archive or source installation, exit the interactive interface first, then run these commands in your system terminal:

```sh
coworkos update --check
coworkos update
coworkos --version
```

`--check` only checks; it does not install. After `update` completes, the next launch uses the new version. Upgrade non-global CLI installations with their original package manager. For source checkout requirements and commands, see [development](development.md#updating-a-source-checkout).

## Data and backups

Configuration and tasks default to `~/.atria/`. Project files stay in the project folder from which you start the CLI. Inspect the actual paths in your terminal:

```sh
coworkos data paths
```

Back up important user data and external project files together. See [workspace persistence](../task-workspace-layout.md) (Chinese) for the layout. Updates preserve existing data; do not delete the user directory to troubleshoot. After reopening the App, continue in the original conversation. See [CLI quickstart](cli-quickstart.md) for CLI exit and recovery.

## Troubleshooting

### `node: command not found` or an old Node.js version

Install Node.js 22.19.0 or newer from [Node.js](https://nodejs.org/en/download), then reopen your terminal and run:

```sh
node --version
npm --version
```

Continue with CLI installation after both commands print version numbers.

### `coworkos: command not found`

If you installed to `~/.local` using the quickstart, run this in the current terminal:

```sh
export PATH="$HOME/.local/bin:$PATH"
coworkos --version
```

To keep PATH in new terminals, choose the command for your shell below and add it once. Run `echo "$SHELL"` if you need to check your shell.

zsh (the macOS default):

```sh
printf '%s\n' 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.zshrc"
```

bash (common in Linux terminals):

```sh
printf '%s\n' 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"
```

Open a new terminal and confirm with `coworkos --version`.

### Installation or checksum verification reports `ENOENT` / `No such file or directory`

Enter the folder where you saved the archive and check that both files exist. Replace the first path if you did not save them in `~/Downloads`:

```sh
cd "$HOME/Downloads"
ls coworkos-cli-0.1.2-beta.12.tgz coworkos-cli-0.1.2-beta.12.tgz.sha256
```

The version in the file names must match your download. If a file is missing, download it again from [CLI setup](cli-quickstart.md#download-and-install), then verify and install. If verification prints `FAILED`, download both files again and install only after verification passes.

### Global npm installation reports a permission error

If the error points to a system global installation directory, install into your user directory instead. Run this from the folder containing the archive:

```sh
archive="coworkos-cli-<version>.tgz"
npm install --global --prefix "$HOME/.local" "./$archive"
export PATH="$HOME/.local/bin:$PATH"
coworkos --version
```

If downloading a platform dependency fails, restore network access and rerun the installation command. Do not skip installation scripts with `--ignore-scripts`.

### `配置已存在，未覆盖` (configuration exists; not overwritten)

`coworkos init` creates a new configuration without overwriting an existing file. First run this in your project folder:

```sh
coworkos doctor
```

Read the path printed after `配置路径：`. If the saved configuration is valid, run `coworkos` directly. To change it, open that file and edit `baseUrl`, `model`, `apiKey` or `api` using [CLI files and environment variables](configuration.md#cli-files-and-environment-variables). `coworkos init --force` retains populated fields rather than asking for every connection value again.

### `FAIL 模型配置` or `FAIL 流式模型连接与工具调用`

Read the error on that line and the printed configuration path:

- Missing configuration: run `coworkos init` in your project folder and enter your provider's API URL, model ID and API key.
- Invalid JSON or model fields: open the printed configuration file and fix it using [CLI configuration](configuration.md#cli-files-and-environment-variables). Do not post the full file or key in issue reports.
- A service that only supports Chat Completions: run the commands below in the current terminal, then test again.
- Authentication, access or quota errors: check the provider's API key, model access and balance, then test again.

```sh
export COWORK_MODEL_API=openai-completions
coworkos doctor --test-connection
```

The format switch above is only for Chat Completions services and only applies in the current terminal. See [CLI configuration](configuration.md#cli-files-and-environment-variables) to save it. For a Responses service, fix its configuration and rerun `coworkos doctor --test-connection` directly. Start a task only after all checks pass.

### The Mac App cannot open or save a connection

If macOS blocks the first launch, follow the system prompt using the [Mac installation guide](getting-started.md#mac-app). If saving a connection stays on Saving, respond to the Keychain prompt. If access was denied, select Save again to retry.

When reporting problems, include the version, OS and chip, installation method, reproduction steps and a redacted error. Do not send API keys, complete private configuration or unfiltered task logs.
