# Mac App quickstart

[简体中文](../getting-started.md) | English

<a id="installation-and-first-task"></a>

macOS 14+ · Apple Silicon

<a id="mac-app"></a>
<a id="before-installing"></a>

## Install through npm

With Node.js ≥22.19.0 and npm installed, run:

```sh
npx coworkos-app@latest desktop install
```

The installer downloads the Apple Silicon desktop package from npm and verifies the npm tarball integrity, DMG SHA-256, application identity and signature before installing it in `~/Applications/CoworkOS.app` without administrator access. It preserves macOS security checks. Node.js and npm are needed only for installation; the App includes its own runtime. If macOS blocks the first launch, follow [Apple's guidance](https://support.apple.com/en-us/102445) in System Settings → Privacy & Security.

Upgrade an installed App manually with a local DMG. Back up user data and external projects, finish tasks and stop the standalone backend, then quit the App. Retain the old App, copy the new one into the installation directory and verify your data after launch. See [installation and upgrades](installation-reference.md#updates). The npm first installer does not overwrite an existing App; use `--directory /absolute/path` for another writable installation directory.

Updating or uninstalling the npm CLI affects only the CLI/installer; it does not remove the independent App or user data. This beta has not been notarized by Apple.

## Connect a model

Open Settings → Model connections and enter your provider's API URL, model ID and API key. Use a root URL or `/v1`, such as `https://your-service.example/v1`.

New connections default to Responses; Chat Completions is also available. The service must support streaming and tool calls in the selected format. Native Anthropic endpoints cannot be used directly.

Select Test connection, then Save connection after the test passes. Testing uses model quota. See [model settings](configuration.md) for more options.

## Create a project

In Finder, create an empty folder named `coworkos-quickstart` in Documents.

In CoworkOS's sidebar, select `+` beside Projects. Enter a project name and choose that folder. Then select `+` beside the project title to open a new conversation.

## Complete your first task

Send:

> Create hello.txt in the current project, write “Hello, CoworkOS.”, then read the file and confirm its contents.

When the task finishes, open the selected `coworkos-quickstart` folder in Finder. It should contain `hello.txt` with the text `Hello, CoworkOS.`.

<a id="cli-archive"></a>

<a id="cli-from-source"></a>

<a id="updates"></a>
<a id="data-exit-and-upgrades"></a>
<a id="troubleshooting"></a>

[CLI](cli-quickstart.md) · [From source](development.md#environment) · [Updates & troubleshooting](installation-reference.md)
