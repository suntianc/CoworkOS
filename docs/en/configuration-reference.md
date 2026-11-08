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

The App encrypts client session credentials with Electron safeStorage in `client-sessions.json` in the desktop data directory. A system authorization failure is displayed and a retry preserves the saved credentials. Model and search keys belong to the selected execution host.

The standalone execution host keeps model and search keys in `credentials.json` (mode 0600) beside its configuration; `COWORK_CREDENTIALS` selects another path. Settings responses carry only `configured`, `credentialUnavailable` or `secretUnavailable`, and a concrete `credentialError`; they never return a key. A blank key keeps the stored value, and explicitly clearing the search key removes it. Old desktop ciphertext counts as unavailable until migrated and is never reported as configured.

To convert an old Electron configuration once, stop the backend and run `node scripts/migrate-desktop-settings.mjs --config <model config>` from the repository (optional `--credentials`, `--legacy-secret`; isolated validation can pass `--host-arg --use-mock-keychain` to avoid real Keychain access). The tool decrypts every value through the old host before writing, backs the original up as `<config>.before-host-credentials`, then rewrites the configuration atomically. A failure leaves the original, backup and credential file unchanged; a success removes ciphertext and plaintext keys from the configuration. Re-running reports `already-migrated` and adds no connections. Restart the backend afterwards; a running backend does not re-read its configuration from disk. The settings page and real runs share this host store, and keys never enter renderer state, logs or events.

Legacy single connections appear as Default configuration. The first multi-profile save creates a `.before-model-profiles` backup and retains the old desktop `model-secret.bin`. Unknown versions cannot be overwritten. Quit before restoring a backup, and treat configurations and backups as private data.

Client sessions use the `CoworkOS Client` encryption identity through a separate Keychain process; legacy model migration continues to use `Atria`. Keys encrypted under the previous development identity may need re-entry. Original ciphertext and source directories remain available. Native Keychain and signing compatibility require separate acceptance checks.

## Model roles

`roleModels` in the execution host's configuration names one saved connection per role: `host` defaults for every project on the machine, and `projects` overrides indexed by the shared project's stable id. Neither travels with shared project data, so another backend never inherits them. Resolution prefers an explicit per-launch selection, then the project override, then the host default, then the deployment's active connection.

Main reads its role when a Run is admitted and records the non-sensitive source as `main.run_spawned.modelSelection`; a later settings change affects the next Run while an in-flight Run and a saved request retry keep their recorded selection. `executor` and `reviewer` are read each time a delegated work item actually starts — including an item still queued behind its prerequisites — so a binding change applies to items that have not started while a started attempt keeps its choice. With no binding the item keeps the launching Run's connection, which is why the settings view reports no fixed effective connection for them. `router` remains a later path's configuration key. A saved role referencing a missing connection reports the role, scope and connection id and is refused rather than falling back to another account.

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

## Network proxies

| JSON field   | Environment variable          |
| ------------ | ----------------------------- |
| `httpProxy`  | `HTTP_PROXY` / `http_proxy`   |
| `httpsProxy` | `HTTPS_PROXY` / `https_proxy` |
| `noProxy`    | `NO_PROXY` / `no_proxy`       |

Environment variables take precedence. Only HTTP(S) proxy URLs are accepted, such as `http://proxy.example:8080`. The bypass list always includes `localhost`, `127.0.0.1` and `::1`, preserving other entries.

Settings apply to CLI Main, headless CLI, subagents, model discovery, connection checks and separate vision requests with both model protocols. Sessions, vision analyses and checks release their proxy connections on completion or cancellation. Interactive Pi uses SDK environment proxies; there are no separate model or vision proxy variables. Treat credential-bearing proxy URLs as private configuration.

## Project data storage

The project ledger and shared project identities live in a separate project data service: a personal deployment defaults to local SQLite and may explicitly choose PostgreSQL. Both modes share one domain service, HTTP surface and Main tool; business behaviour does not depend on the engine. The engine is fixed when the service starts. An invalid configuration, unreachable database or failed authentication refuses to start and names the engine and target; it never switches to the other engine or continues on an empty database.

```json
{
  "projectData": {
    "engine": "postgres",
    "postgres": { "connectionString": "postgresql://coworkos@db.example:5432/coworkos" }
  }
}
```

A secondary backend does not open a local engine; it reaches the same authority through the authenticated client:

```json
{
  "projectData": {
    "authority": { "url": "http://127.0.0.1:3880", "token": "host credential" }
  }
}
```

`authority` excludes `engine`, `sqlite` and `postgres`. At startup the client exchanges the host credential for one local session and presents only that session afterwards; the credential stays in server configuration or `COWORK_PROJECT_DATA_TOKEN` and never enters the UI, tool arguments or error text. An unreachable authority returns `storage_unavailable`; a revoked session returns `shared_auth_failed`. Neither fakes a successful claim or transfers ownership. Main session records, development records and the board are shared through the same client, while the Task, Pi transcript, checkout directory and execution ownership stay on the backend that created them; another backend cannot record or settle a Run for a session it does not own, and it can only read the checkout it prepared itself. The merge configuration's repository and target branch are checked by the configured execution backend on its own host; the authority only stores the validated shared fact and never runs Git against a remote path. Shared projects keep one `projectId`; each backend registers only its own local directory binding, and a remote absolute path never becomes a local execution directory.

A development workspace is an isolated `git worktree` outside the target repository, under the data root at `ATRIA_HOME/runtime/development-workspaces/<developmentId>` (default `~/.atria/runtime/development-workspaces`). It is not part of shared data and is never written into the user's own working directory. A work item bound to a development forks its own site under the sibling `work-items/<callId>` and reuses that directory and branch when it resumes. A merge builds its combined version in its own temporary `merges/<mergeId>` site and removes it after the target update or on failure; it never overwrites the user's site, earlier merges or unmerged branches. Backup and restore run on the authority's backend; a remote client refuses them explicitly.

SQLite defaults to `project-data.sqlite` under the data root (`ATRIA_HOME/runtime/project-data.sqlite`, `~/.atria/runtime/project-data.sqlite` by default); `projectData.sqlite.path` selects another file, and a relative path resolves against the data root. PostgreSQL also accepts separate `host`, `port`, `database`, `user`, `password` and `ssl` fields. Connection credentials stay in the serving host's configuration or `COWORK_PROJECT_DATA_URL` and never enter the UI, tool arguments or error text.

This stage verified the integration with Node 22.23.4 (the minimum is 22.19.0), the built-in `node:sqlite` (SQLite 3.53.4), a PostgreSQL 18.6 server (the official `postgres:18.6-alpine3.24` image) and the locked `pg` 8.23.1 client; other engine versions were not verified here. The engine is fixed at startup, and switching it never reads the other engine's data.

Choosing an engine is not a data migration: switching engines does not move the existing project catalog, Task/Run, attachments or Pi history, and this stage adds no cross-engine move, dual write or live switch. The existing project catalog still supplies the stable `projectId`; shared project rows keep only that identity, while the local directory is a binding of the current backend, so a shared row's directory is never used as a local execution directory.

### Backup and restore

The service applies versioned schema migrations at startup. `GET /api/project-data` reports the current engine, server version and applied schema version; `target` is a file path or `postgresql://host:port/database` and carries no credential. Backup and restore use the same service against the current engine:

```sh
coworkos data backup --to ~/backups/project-data.json
coworkos data restore --from ~/backups/project-data.json
```

A backup is a local logical snapshot (mode 0600) of the shared projects, this host's directory bindings, requirements, revisions, decisions, references, board entries and events, Main sessions and Run ownership, development records, review channel decisions, fixed-candidate reviews with their findings and rulings, per-backend workspace bindings and the project merge configuration. Pi transcripts and the checkout files are not in the snapshot; the executing backend keeps them locally. Restore replaces those records in one transaction in foreign-key order and refuses a snapshot from the other engine or an older schema. Stop the backend writing the data root before a restore and restart it afterwards. A backend using `projectData.authority` has no local database; run backup and restore on the authority's backend.

## External Main capacity

The external service's Main quotas live in the host's own configuration. Leaving them out keeps the previous internal-only behavior and refuses to create external sessions. `resident` is a positive integer, `continuation` a non-negative integer, both capped at 32; an invalid value fails configuration reads instead of guessing.

```json
{ "mainCapacity": { "resident": 2, "continuation": 1 } }
```

`resident` bounds the external regular Mains running at once and `continuation` is reserved for continuation Mains; neither kind borrows from the other, and internal Mains spend no external capacity. A project may save as many external regular sessions as `resident`; a saved session occupies no running slot, and continuation sessions do not count toward the project limit. Lowering a quota below the running count or below any project's saved regular sessions is refused with its reason and never ends running work.

Quotas and state are read with `GET /api/main-capacity` and changed with `POST /api/main-capacity`; running and waiting facts live in the data root's `main-capacity/state.json` (default `~/.atria/runtime/main-capacity/state.json`) beside the backend identity, not in shared project data. The program fills a free slot in arrival order and releases it on process exit, failed start, cancellation, crash and restart reconciliation; reconciliation only inspects this host's own processes and stops nothing unrelated. A recoverable failure (shared service unreachable or authentication unavailable) releases the unused slot but keeps the accepted demand, retried with backoff and shown as waiting/failed with its last error; a permanent refusal keeps the input too and becomes `failed` without spending retries. A failed demand keeps its input and `POST /api/main-capacity` with `retry` puts it back in line. A dispatched Main registers its own pid before doing any work; reclaiming a stale reservation is a single check-and-remove in the capacity store, so a Main that registered in between keeps its slot and is counted, and a Main whose reservation is already gone refuses to start. The CLI and main-worker read the same file and write to the same queue. A waiting demand keeps only its explicit profile/model/thinking choice: the host and project role defaults are resolved when it actually gets a slot, so a default changed during the wait applies to that Run.

Interface details: [Product API](../product-api.md#external-main-capacity).

## Paths and environment variables

| Variable                                              | Purpose                                                                                      |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `COWORK_CONFIG`                                       | Explicit configuration file                                                                  |
| `COWORK_API_BASE` / `COWORK_MODEL` / `COWORK_API_KEY` | Model URL, ID and key                                                                        |
| `COWORK_MODEL_API`                                    | Same values as `api`                                                                         |
| `COWORK_THINKING_FORMAT`                              | Thinking format for the current process                                                      |
| `COWORK_SUPPORTS_IMAGES`                              | `1` / `true` enables; `0` / `false` disables                                                 |
| `COWORK_REASONING_EFFORT`                             | Reasoning level                                                                              |
| `COWORK_SUPPORTS_REASONING_EFFORT`                    | `1` / `true` enables; `0` / `false` omits effort fields                                      |
| `COWORK_SUPPORTS_PROMPT_CACHE_KEY`                    | `1` / `true` enables; `0` / `false` disables third-party cache keys                          |
| `ATRIA_HOME`                                          | App, CLI and Web user home, default `~/.atria`; explicit path overrides still win            |
| `COWORK_DESKTOP_DATA`                                 | Separate desktop data directory                                                              |
| `COWORK_WORKSPACE`                                    | Persistent task data directory, default `~/.atria/workspace`                                 |
| `COWORK_PROJECT_DIR`                                  | Main's project directory for files and commands                                              |
| `PI_CODING_AGENT_DIR`                                 | Pi state directory, default `~/.atria/pi`                                                    |
| `COWORK_TASK_ID`                                      | Fixed Main Task, used with its original Pi session for recovery                              |
| `COWORK_UI_PORT`                                      | Source Web port, default 3880                                                                |
| `COWORK_TRUSTED_CLIENT_ORIGINS`                       | Trusted local page origins; exact loopback `http://127.0.0.1:<port>` values, comma-separated |
| `COWORK_PROJECT_DATA_ENGINE`                          | Project data engine: `sqlite` (default) or `postgres`                                        |
| `COWORK_PROJECT_DATA_SQLITE`                          | SQLite data file path                                                                        |
| `COWORK_PROJECT_DATA_URL`                             | PostgreSQL connection URL; overrides `projectData.postgres` in the file                      |
| `COWORK_PROJECT_DATA_AUTHORITY`                       | Shared project data authority URL; overrides `projectData.authority.url`                     |
| `COWORK_PROJECT_DATA_TOKEN`                           | Authority access credential; overrides `projectData.authority.token`                         |

`COWORK_TRUSTED_CLIENT_ORIGINS` accepts only exact local `http://` origins and never a wildcard. Named origins may read this backend's responses across ports and appear in its page's `connect-src`; credentials and the `127.0.0.1` listener are unchanged. A browser page managing another local backend names both origins on the two backends. See [Product API](../product-api.md#trusted-local-client-origins).

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
