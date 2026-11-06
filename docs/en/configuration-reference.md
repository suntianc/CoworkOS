# Configuration reference

[简体中文](../configuration-reference.md) | English

For everyday setup, see [model and runtime configuration](configuration.md).

## Model parameters

| JSON field                            | Values and defaults                                                                                                                 |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `baseUrl`                             | Service root or `/v1`; legacy `apiBase` is supported                                                                                |
| `model`                               | Provider model ID                                                                                                                   |
| `apiKey`                              | Private configuration key, or use `COWORK_API_KEY`                                                                                  |
| `api`                                 | `openai-responses` or `openai-completions`; new connections default to the former, legacy files without the field retain the latter |
| `supportsImages`                      | `false` for new connections                                                                                                         |
| `thinkingFormat`                      | `auto` (default), `openai` or `zai`; affects Chat Completions only                                                                  |
| `reasoningEffort`                     | `off`, `low`, `medium`, `high`, `xhigh`, `max`; requires service support                                                            |
| `supportsReasoningEffort`             | `false` for new connections, omitting effort fields                                                                                 |
| `supportsPromptCacheKey`              | `false` for third-party services; enable after confirming support                                                                   |
| `contextWindow`                       | 256000 tokens by default; must be a positive safe integer                                                                           |
| `mainMaxTokens` / `subagentMaxTokens` | 8192 each for new connections; integer 1 to 65536, within service limits                                                            |
| `workspaceRoot`                       | Persistent task and application data directory; prefer an absolute path                                                             |

`contextWindow` controls context budgets and automatic compaction for Main, subagents and recovered tasks. It is not sent as a request parameter. Older connections without the field use 256000. Output limits are separate.

`off` always omits effort fields. Legacy `minimal` values remain readable and appear as legacy settings in the UI. Editing other fields preserves them until another level is selected and saved. Unspecified legacy connections may retain the Runtime defaults of `high` and reasoning support; new connections use `off` / `false`.

Connection tests, Main and subagents share capability clamping and request serialization. If a service rejects an explicit effort, the test fails without trying other levels. Tests use short synthetic messages and tools, excluding real conversation history. With images enabled, they also check a synthetic image's background color and a random large digit, 2 or 4. Long contexts, content policies and real tasks need separate checks.

For custom GLM gateways the SDK does not recognize, select GLM format or set `thinkingFormat: "zai"`. Enabled thinking sends `thinking: {type: "enabled", clear_thinking: false}`; disabled thinking sends `thinking: {type: "disabled"}` and omits `reasoning_effort`. `openai` uses standard effort fields, while `auto` uses SDK detection. The choice follows the connection through Main, subagents and recovery; Responses is unchanged.

`supportsPromptCacheKey` controls `prompt_cache_key` for third-party services. Opting in sends a stable session key, hashed with SHA-256 when longer than 64 characters; the default omits it. `api.openai.com` retains SDK defaults, and programmatic `cacheRetention: "none"` always omits the key. Main, subagents and recovery share the setting. Sending a key cannot enable server caching or guarantee a hit; automatic prefix caching may work without it.

## CLI files

The launcher selects the first matching file without merging files:

1. The path in `COWORK_CONFIG`.
2. `.cowork/config.json` in the launch directory.
3. `config.json` in the launch directory.
4. `~/.atria/config.json`, or `ATRIA_HOME/config.json`.

Starting the CLI or running `doctor` requires the file specified by `COWORK_CONFIG` to exist. `init` can create a new file at that path. Invalid JSON or fields in the selected file cause an error without falling back to the next file.

Environment variables override the selected file. Explicit arguments override corresponding fields at their entrypoint, such as Main's `--thinking low`. Relative configuration paths resolve from the launch directory.

`coworkos init` creates the user configuration by default. If a project file exists or `COWORK_CONFIG` is set, it uses that file. Existing files are preserved unless `--force` is given. `coworkos init --force` reads and updates the existing configuration, reusing its saved URL, model and key. It prompts only for missing required values. Pass `--base-url` or `--model` to change those values. To replace the key, first set `COWORK_API_KEY`, or use `--api-key-env` to name an environment variable containing the new key. Other fields and the existing message format are preserved.

If the existing file cannot be parsed or contains invalid fields, fix it first; `--force` still reads it. Automated setup can read a key from an environment variable you have already set:

```sh
coworkos init --base-url https://your-service.example/v1 --model your-model-id --api-key-env COWORK_API_KEY
```

Optional flags: `--images`, `--reasoning`, `--thinking high`, `--max-tokens 8192`, `--force`. `init` has no message format option. For a Chat Completions-only service, set `"api": "openai-completions"` in the selected configuration file, or set `COWORK_MODEL_API=openai-completions` when starting the CLI.

To create a separate configuration for the current project, run from its directory:

```sh
COWORK_CONFIG="$PWD/.cowork/config.json" coworkos init
```

Initialization creates the required directories. Then run `coworkos doctor` to confirm the selected configuration path.

For source development, you can also copy the example from the CoworkOS source repository root:

```sh
mkdir -p .cowork
cp config.example.json .cowork/config.json
chmod 600 .cowork/config.json
```

Replace the example URL, model and key, or remove `apiKey` and use the environment. The example's `workspaceRoot: ".tmp"` suits source development; use a fixed absolute directory to share tasks across projects. Keep real keys out of command arguments and shared scripts.

Source Web uses the same file precedence. Installed Apps use host-managed configuration. `coworkos doctor` checks local requirements, configuration and workspace writes, and validates offline finding, content search and ignore rules with temporary files. It does not print keys. Only `--test-connection` requests the model.

On macOS, Finder/Dock launches add existing `~/.local/bin`, Homebrew `bin`/`sbin`, `/usr/local/bin`/`sbin` and user/system LibreOffice directories to the backend `PATH`, inherited by Main, subagents and commands. Tool directories precede a system-only path; custom ordering is preserved with missing entries appended. Discovery does not execute shell profiles or guess version-manager directories. Terminal CLI uses the caller's environment.

## Connection storage and compatibility

The App uses Electron safeStorage's macOS encryption. Web / CLI typically use local JSON with mode 0600. The App's model, search and component credentials share Keychain save behavior: failure or cancellation preserves the form and previous configuration, and another Save retries without falling back to plaintext.

The standalone execution host keeps model and search keys in `credentials.json` (mode 0600) beside its configuration; `COWORK_CREDENTIALS` selects another path. Settings responses carry only `configured`, `credentialUnavailable` or `secretUnavailable`, and a concrete `credentialError`; they never return a key. A blank key keeps the stored value, and explicitly clearing the search key removes it. Old desktop ciphertext counts as unavailable until migrated and is never reported as configured.

To convert an old Electron configuration once, stop the backend and run `node scripts/migrate-desktop-settings.mjs --config <model config>` from the repository (optional `--credentials`, `--legacy-secret`; isolated validation can pass `--host-arg --use-mock-keychain` to avoid real Keychain access). The tool decrypts every value through the old host before writing, backs the original up as `<config>.before-host-credentials`, then rewrites the configuration atomically. A failure leaves the original, backup and credential file unchanged; a success removes ciphertext and plaintext keys from the configuration. Re-running reports `already-migrated` and adds no connections. Restart the backend afterwards; a running backend does not re-read its configuration from disk. The settings page and real runs share this host store, and keys never enter renderer state, logs or events.

Legacy single connections appear as Default configuration. The first multi-profile save creates a `.before-model-profiles` backup and retains the old desktop `model-secret.bin`. Unknown versions cannot be overwritten. Quit before restoring a backup, and treat configurations and backups as private data.

Release and development Apps use the same `Atria` encryption identity through a separate Keychain process; the development window shows CoworkOS Dev. Keys encrypted under the previous development identity may need re-entry. Original ciphertext and source directories remain available. Native Keychain and signing compatibility require separate acceptance checks.

## Separate vision connection

`modelConnections.visionId` references a saved connection with `supportsImages` enabled. Native image models receive pixels directly; the separate vision connection is used when a text-only model calls `read_image`. See [model connections](configuration.md#app-and-web-model-connections) for the UI.

CLI environment configuration requires `COWORK_VISION_API_BASE`, `COWORK_VISION_API_KEY` and `COWORK_VISION_MODEL` together. A complete configuration overrides the saved vision connection; missing fields fail.

| Optional variable                         | Purpose and default                                     |
| ----------------------------------------- | ------------------------------------------------------- |
| `COWORK_VISION_MODEL_API`                 | Vision connection's message format                      |
| `COWORK_VISION_THINKING_FORMAT`           | Vision connection's thinking format                     |
| `COWORK_VISION_MAX_TOKENS`                | 8192 by default; 1 to 65536, capped at 8192 for reviews |
| `COWORK_VISION_REASONING_EFFORT`          | `off` by default                                        |
| `COWORK_VISION_SUPPORTS_REASONING_EFFORT` | `false` by default                                      |

Trusted child processes inherit the selected connection. Keys stay out of UI and queues, using the existing encrypted or private JSON storage.

## Web search

Without explicit settings, search uses Exa. Existing `serperApiKey`, `COWORK_SERPER_API_KEY` or `SERPER_API_KEY` retains Serper. An explicit `webSearch.provider` (`exa` / `serper` / `off`) takes precedence over credential inference. Legacy `webTools: false` and `COWORK_WEB_TOOLS=0` disable search, with environment disabling taking precedence. `COWORK_WEB_TOOLS=1` can override the old boolean but not an explicit `provider: "off"`. Upgrades do not rewrite existing choices.

For your own Exa key, set `webSearch.exaApiKey` or `COWORK_EXA_API_KEY` / `EXA_API_KEY`; environment values win. Serper still requires its own key. Main, subagents and recovered conversations use the same search settings.

The default [official Exa MCP](https://exa.ai/docs/get-started/exa-mcp) endpoint is `https://mcp.exa.ai/mcp?tools=web_search_exa,web_fetch_exa`. Only basic search and fetching are enabled, with JSON/SSE, session/protocol headers, cancellation and a 30-second total deadline. `COWORK_EXA_MCP_ENDPOINT` is for trusted test services only; the UI has no endpoint input.

Tools preserve source titles, URLs, bodies and available dates without inventing missing dates. A single-URL fetch needs a valid source and nonempty body, preserving redirects; multiple sources must match the requested URL. Invalid sources, empty structures, metadata-only results or unrelated bodies fail. Provider JSON envelopes are not page evidence. Only a genuine empty result list counts as zero results. Network, proxy, protocol, timeout and cancellation errors are failures.

## Scientific environments

`science.enabled`, `science.pythonExecutable` and `science.chemistryPythonExecutable` control the switch, base Python and RDKit Python. `COWORK_SCIENCE_TOOLS`, `COWORK_SCIENCE_PYTHON` and `COWORK_SCIENCE_CHEMISTRY_PYTHON` override individual fields; environment-managed fields are locked in the UI.

Interpreter values accept absolute paths or command names. Clearing the base path restores `python3`; clearing the RDKit path inherits the base environment. Explicit checks validate the draft interpreter, dependency versions and a fixed RDKit sample. Saving does not run the check.

Tasks retain their selected directory and interpreter. Changes apply to new tasks; enabling or disabling takes effect when the next session process starts. Recovered tasks retain their historical interfaces after disabling, but computation returns unavailable. Installation supports cancellation and reuse. Success fills the draft; failure preserves existing configuration and environments. See [scientific tools](scientific-tools.md) for installation and dependencies, and [Product API](../product-api.md#scientific-environment-settings) for HTTP contracts.

## Network proxies

| JSON field   | Environment variable          |
| ------------ | ----------------------------- |
| `httpProxy`  | `HTTP_PROXY` / `http_proxy`   |
| `httpsProxy` | `HTTPS_PROXY` / `https_proxy` |
| `noProxy`    | `NO_PROXY` / `no_proxy`       |

Environment variables take precedence. Only HTTP(S) proxy URLs are accepted, such as `http://proxy.example:8080`. The bypass list always includes `localhost`, `127.0.0.1` and `::1`, preserving other entries.

Settings apply to CLI Main, headless CLI, subagents, model discovery, connection checks and separate vision requests with both model protocols. Sessions, vision analyses and checks release their proxy connections on completion or cancellation. Interactive Pi uses SDK environment proxies; there are no separate model or vision proxy variables. Treat credential-bearing proxy URLs as private configuration.

## Paths and environment variables

| Variable                                              | Purpose                                                                           |
| ----------------------------------------------------- | --------------------------------------------------------------------------------- |
| `COWORK_CONFIG`                                       | Explicit configuration file                                                       |
| `COWORK_API_BASE` / `COWORK_MODEL` / `COWORK_API_KEY` | Model URL, ID and key                                                             |
| `COWORK_MODEL_API`                                    | Same values as `api`                                                              |
| `COWORK_THINKING_FORMAT`                              | Thinking format for the current process                                           |
| `COWORK_SUPPORTS_IMAGES`                              | `1` / `true` enables; `0` / `false` disables                                      |
| `COWORK_REASONING_EFFORT`                             | Reasoning level                                                                   |
| `COWORK_SUPPORTS_REASONING_EFFORT`                    | `1` / `true` enables; `0` / `false` omits effort fields                           |
| `COWORK_SUPPORTS_PROMPT_CACHE_KEY`                    | `1` / `true` enables; `0` / `false` disables third-party cache keys               |
| `ATRIA_HOME`                                          | App, CLI and Web user home, default `~/.atria`; explicit path overrides still win |
| `COWORK_DESKTOP_DATA`                                 | Separate desktop data directory                                                   |
| `COWORK_WORKSPACE`                                    | Persistent task data directory, default `~/.atria/workspace`                      |
| `COWORK_PROJECT_DIR`                                  | Main's project directory for files and commands                                   |
| `PI_CODING_AGENT_DIR`                                 | Pi state directory, default `~/.atria/pi`                                         |
| `COWORK_TASK_ID`                                      | Fixed Main Task, used with its original Pi session for recovery                   |
| `COWORK_UI_PORT`                                      | Source Web port, default 3880                                                     |

Runtime state defaults to `~/.atria/runtime` in every entrypoint. Project settings save `projectName`, `projectId` and `projectDirectory`; the first message creates the conversation. Project working directories are separate from internal storage under `workspaceRoot` / `COWORK_WORKSPACE`.

Explicit old `.tmp` / `.tmp/pi-agent` paths still work. Source entrypoints no longer select checkout `.tmp` implicitly. Release and development Apps share data and the instance lock. Explicit `COWORK_DESKTOP_DATA` and `ATRIA_HOME` overrides skip automatic legacy desktop copies; an empty default desktop home copies the corresponding legacy profile while preserving its source.

Run `coworkos data paths` to inspect selected paths. To import other desktop data into an existing home, use `coworkos data import --from PATH --kind desktop --name old-app`; source workspaces use `--kind workspace`. Imports preserve their source, reject duplicate names and register a separate workspace in the history catalog. See [persistent data layout](../task-workspace-layout.md) (Chinese).

## Interface language

Choose Simplified Chinese or English under Settings → General → Language. The default is Simplified Chinese. Switching saves application documents, checks conflicts and saves conversation and human-reply drafts before reloading. If saving is blocked, the current interface stays open.

Web stores the preference per origin in `localStorage` under `atria.language`. App stores it in `language.json` in its user data directory, independently of the backend's random port. This setting covers shared App/Web chrome, settings, conversations and workbench actions. It does not change existing user content, model response language, CLI, native system dialogs or third-party embedded editors' own language settings. Raw backend and external-tool errors retain their original language.

## Appearance storage

The App saves appearance in `appearance.json` in its user data directory; Web stores it per browser site. Missing or invalid App preferences use Follow system. Web defaults to Dark when its preference is missing or invalid, and falls back to Follow system if browser storage is unavailable. Existing manual choices remain. Light mode preserves the nebula, stars and multi-agent galaxy. System forced colors hide decorative canvases.

## Advanced limits

These are underlying Runtime defaults, overridden by files or environment settings. New connections use 8192 output tokens and `off` / `false` reasoning settings; existing connections are not rewritten.

| JSON field                  | Environment variable                  | Runtime default                                                 |
| --------------------------- | ------------------------------------- | --------------------------------------------------------------- |
| `mainMaxTurns`              | `COWORK_MAIN_MAX_TURNS`               | 2000                                                            |
| `subagentMaxTurns`          | `COWORK_MAX_TURNS`                    | 200                                                             |
| `mainMaxTokens`             | `COWORK_MAIN_MAX_TOKENS`              | 65536; new connections 8192                                     |
| `subagentMaxTokens`         | `COWORK_MAX_TOKENS`                   | 65536; new connections 8192                                     |
| `contextWindow`             | `COWORK_CONTEXT_WINDOW`               | 256000 tokens                                                   |
| `mainTimeoutMs`             | `COWORK_MAIN_TIMEOUT_MS`              | 0, unlimited                                                    |
| `subagentTimeoutMs`         | `COWORK_SUBAGENT_TIMEOUT_MS`          | 0, unlimited; legacy `COWORK_TIMEOUT_MS` affects subagents only |
| `commandTimeoutMs`          | `COWORK_COMMAND_TIMEOUT_MS`           | 1800000 (30 minutes); 0 is unlimited                            |
| `maxAttempts`               | `COWORK_MAX_ATTEMPTS`                 | 3 including the first delegation; 1 disables delegation retries |
| `subagentQuestionTimeoutMs` | `COWORK_SUBAGENT_QUESTION_TIMEOUT_MS` | 180000 (3 minutes); 0 disables questions to Main                |
| `humanAnswerTimeoutMs`      | `COWORK_HUMAN_ANSWER_TIMEOUT_MS`      | 60000 (1 minute)                                                |
| `subagentMaxQuestions`      | `COWORK_SUBAGENT_MAX_QUESTIONS`       | 3                                                               |

Timeouts are milliseconds. `maxAttempts` is a delegation budget, separate from model request retries. See the [runtime reference](runtime-reference.md#request-retry-and-context-recovery) for long tasks and retries.

Implementation: [configuration](../../src/runtime/config.ts), [runtime settings](../../src/runtime/runtime-settings.ts), [model profiles](../../src/runtime/model-profile.ts). Regression tests: [CLI setup](../../test/cli-onboarding.test.js), [model protocol](../../test/model-protocol.test.js).
