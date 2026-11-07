# Runtime reference

[简体中文](../runtime-reference.md) | English

This page maintains runtime contracts for tools, delegation, recovery and monitoring. See [configuration reference](configuration-reference.md) for models and budgets, [data layout](../task-workspace-layout.md) for stored files, and [Product API](../product-api.md) for HTTP fields.

## Conversations and messages

The project folder supplies file and command operations; history and recovery data live in user data storage. Changing the project folder does not move history or external files. Existing absolute paths and document bindings retain their locations. See [project ownership](../task-workspace-layout.md#项目与会话归属) for path contracts.

App/Web persist text, attachments and edit drafts separately by project or conversation. Ordinary messages submitted during execution queue; steering instructions enter at the next model call, after the current call or tool finishes. Stopping cancels unfinished execution while preserving drafts and file changes already made.

Editing the latest accepted message runs again from the preceding conversation history with the new input. It does not undo earlier file changes or external actions. See [request retry and context recovery](#request-retry-and-context-recovery) for exact replay of failed requests.

## Input formats

### Mathematical formulas

Web/App support inline `\(...\)` and `$...$`, and display math with `\[...\]` and `$$...$$`. Code and unsupported formulas retain their source. The terminal does not render formulas.

## General and optional tools

Terminal and App Main share the Cowork extension and capability rules. The lower-level `single` command uses an explicit single-agent tool factory and does not automatically receive Main's delegation or application tools. Coordinator accepts an external `capabilityProvider`.

`enable_tools({})` discovers groups; `enable_tools({groups:["applications"]})` loads application tools. Explicit loading survives Main Run recovery. Attachments, referenced resources and granted jobs can also enable tools through context. Loading does not grant permission: jobs still require `longRunning`, and computer actions check authorization on every call.

Browser/CUA objects belong to the current Pi session and are cleared on exit or session change. Restoring groups does not restore pages or script objects. Ordinary subagents do not inherit them automatically. See [Browser Use](../browser-use.md), [Computer Use](../computer-use.md) and [CUA scripting](../cua-scripting.md).

Cancellation, timeout or excess output ends a managed foreground command's process group. Completion also cleans up unregistered descendants. Descendants that create their own session or process group are outside this scope; Windows manages only the direct command process. Use `start_job` and `check_job` for work that spans tool calls. Stopping Main's turn does not automatically cancel delegated subagents; use `cancel_subagent` explicitly.

`run_command` / `run_tests` report nonzero exit, startup failure and timeout as tool errors. `cwd` is relative to the current agent's working directory; the project becomes the default only with project-write access. Main and subagents may have different private working directories.

Builtin `run_command` / `run_tests` write raw stdout and stderr bytes separately under the current agent's `logs/commands/<id>/`, with a default hard limit of 64 MiB per stream. Exceeding that limit stops the command and reports an error. Returned `stdout` / `stderr` retain head/tail previews of at most 8,000 bytes each by default, including omission notices. Preview truncation alone does not stop execution. Cancellation, timeout and log-write errors preserve captured output and available logs. A log-write failure reports a tool error while retaining the command's observed exit code, including `0`.

Command receipts retain exit status, `stdoutBytes` / `stderrBytes` (bytes observed on the pipes), `stdoutLogBytes` / `stderrLogBytes` (bytes actually logged), preview truncation flags and log references. `stdoutPath` / `stderrPath` are normally Task-relative and support byte-offset pagination with `browse_workspace({mode:"read",path,offset})`. When Task and agent roots differ, `stdoutReadPath` / `stderrReadPath` also support `read_file`. Separate programmatic roots use `logPathBase:"agent"` to identify agent-relative paths. Logs may be incomplete after a hard-limit or log-write failure.

`createBuiltinTools` accepts `commandMaxLogBytes` and `commandPreviewBytes` to configure each stream's hard limit and preview byte budget independently. If `commandMaxLogBytes` is absent, explicit `maxOutputBytes` still overrides the legacy command hard limit. File reads retain their default 128,000-byte behavior. This preview and log mechanism does not change the SDK behavior of Main's native `bash`.

## Delegated resources and candidate acceptance

Ordinary `call_subagent({task,mode})` remains supported. Application bindings, attachments and desktop authorization are not all inherited. Share the required scope explicitly:

```javascript
call_subagent({
  task: "Check assembly parts and motion parameters; return evidence",
  mode: "async",
  resources: [{ resourceId: "referenced-resource-id", access: "read" }],
  attachments: ["explicitly-shared-upload-id"]
});
```

`read` exposes adapter-declared read-only tools; `candidate` permits editing a private copy. Built-in adapters supply these grants; third-party window MCP tools are not delegated automatically. Attachment readers accept only shared IDs. A resource ID can be omitted when only one resource supports the tool; specify it when several do.

Candidate edits return `saved:false` and `candidatePath`, accumulating consecutive operations in one copy. Main checks the candidate and evidence before calling `accept_resource_candidate({candidatePath})`. Acceptance checks durable grants and the base revision, then commits the complete operation sequence as one atomic revision. `revision_conflict` preserves both sides; reread and redelegate rather than changing the base revision to force an overwrite.

Recovered queues retain their original grants independently of Main's current binding. Resource grants do not expand Task file or command permissions. Missing capability providers fail explicitly. A successful subagent or its summary does not replace candidate acceptance.

### One-way Subagent peer messages

An active Subagent can call `send_peer_message({targetCallId, message, priority?})` to send a non-blocking message to another Subagent in the same Task/Run. Main must provide `targetCallId` in the delegated brief or later guidance. Messages are limited to 8,000 characters and are intended for short questions, corrections, findings, or file/artifact paths.

The message is persisted in the recipient's Inbox and injected at its next safe model turn. The tool returns only a queued result and never waits for a reply; the recipient may send another message independently. Missing or terminal calls are rejected. A peer message does not create nested delegation or a synchronous dependency; Main remains responsible for final acceptance and Task completion.

### Querying Task and delegation status

`get_task_status()` returns compact delegation identities, states, callback states and diagnostic paths by default. It omits repeated subtask briefs, result bodies, error bodies and output lists. `resultAvailable` means a persisted callback or diagnostic file exists; during a retry it may describe an earlier attempt, and does not establish completion or successful verification. `resultDelivered` is `true` only after callback consumption has been durably confirmed. Calls without a callback, including synchronous delegations, omit that field and use `callbackState: "none"`.

To recover a specific asynchronous result, pass `get_task_status({resultCallIds:["<callId>"]})`. Only those calls include the stored callback body, error and output paths; other calls remain compact. Queries neither claim nor consume Inbox messages. Receive pending results through the existing callback or `wait_for_subagents`. Synchronous calls have no callback body to reread; diagnostic paths point to complete execution records for targeted inspection when needed.

### Partial progress after subagent interruption

When a subagent fails, times out or is cancelled, its result includes at most 6,000 characters of partial progress:

- The two latest visible statements;
- The six latest file changes with tool receipts;
- The four latest returned tool records;
- Up to two operations with unknown completion.

Command records retain exit codes and output excerpts from both ends. File bodies, patch content and reasoning are excluded, and no extra model request generates the handoff. Excerpts may omit earlier work and do not establish task or test completion. Inspect the effects of an operation with unknown completion before repeating it.

Synchronous delegations return the result directly; asynchronous delegations use the existing Inbox. Diagnostic paths remain available for targeted inspection of full records when needed.

## Request retry and context recovery

Main and subagents default to at most five automatic retries after the first request. Main normally backs off for 2, 4, 8, 16 and 32 seconds while retaining explicit Pi settings. Subagents can override `maxErrorRetries`. Explicit missing-model, authentication, permission and exhausted-quota errors do not retry automatically. Connection tests request once. `COWORK_MAX_ATTEMPTS` is a separate delegation budget.

App/Web Retry resends the failed request's saved serialized body, including system messages, model, tool definitions, attachments and generation parameters, without adding a recovery instruction. Completed tool results are retained. New callbacks queue during replay and enter afterward; inputs and document changes absent from that body are not treated as already read.

A private snapshot is saved before transmission and checks the Task storage root, working folder, application resource origins and tool ownership. Changed settings or sources, damaged snapshots and older snapshots without ownership records prevent exact replay while preserving the data. Older conversations without snapshots can continue only from saved context. Cancellation takes precedence; stale retry actions cannot revive a cancelled run. See [data layout](../task-workspace-layout.md) for formats and backup boundaries.

When a headless Run checkpoint already ends with complete final text and has no unfinished tool call, recovery finishes persistence without another model request. A successful Run ID cannot be reused; new work needs a new Run. Lifecycle commands alone do not start model execution.

Explicit CLI `COWORK_TASK_ID` takes precedence over automatic association. Recovery rejects Tasks and conversations from different projects. For legacy sessions without an association, use `COWORK_TASK_ID=my-task coworkos --session <session-id-or-path>`; later recovery uses that association.

### Summary input and output

Compaction preserves full conversation history and changes only subsequent model context. Both Main and subagents retain a historical summary and recent original messages. Main automatic compaction and `clear_context` retain Pi's native cut points and recent history; subagents retain their durable summary cursor. The summarizer receives the actual previous summary and the ordered history being removed. Main history and split-turn prefix summaries, and subagent summaries, use a copy of each tool result capped at 2,000 characters: retain call attribution, known error or exit status, and both ends of the output while omitting the middle. Labels and omission notices count toward that budget. Original tool records and command execution limits are unchanged. Calls without a matching result in the covered range retain bounded identity information separately. This means only that no result was seen within that range; later retained messages and current state may update their completion status.

Subagents default to a soft target of about 20,000 tokens of recent original messages and can choose a safe cut within a long active turn without waiting for a new user message. Cut points keep individual messages intact and preserve tool call/result pairs. A single message or tool pair may therefore exceed the target; a single oversized latest user message is retained intact.

Main's current phase, pending delegations and auxiliary goal enter through dynamic context refreshed for each request, capped at 12,000 characters overall. The goal is not repeated when already present in visible user messages. Bounded auxiliary memory and experiment records are added after the first successful compaction instead of accumulating as an old summary. Auxiliary records are marked as potentially stale or incomplete; the recorded runtime goal is not a complete copy of user requirements. A summary describes only its covered history. Later retained messages and refreshed runtime state may update that historical state.

Summaries keep the native Markdown headings and reconcile still-valid goals, constraints, net changes, unfinished work, essential decisions, verification evidence and concrete next steps. Plans, attempts, confirmed changes and verified results remain distinct; calls without results have unknown completion. Verification retains the command, explicit result and known scope. Earlier passing tests do not establish that later changes pass. About 1.5–3k tokens for ordinary summaries, with shorter prefix summaries, is a soft target, enforced neither by truncating generated output nor by an extra model-based semantic review.

Empty, thinking-only, incomplete, failed, cancelled or tool-calling summaries do not advance the cursor. Main's native validation and the subagent commit guard each reject tool calls in summaries. On failure or during cooldown, subagents continue with the last successful summary and original messages not yet summarized; without a successful summary, they retain the original history. Summaries may omit facts; use evidence references to inspect original files and history when needed. Content already absent before compaction cannot be rebuilt automatically. Branch summaries and unrecognized requests retain native behavior.

Automatic compaction failures for the same summary input receive successive cooldowns of 5, 15 and 30 seconds, capped at 30 seconds for later failures. Expiry allows the next normal trigger to try again; it does not start a background retry. Input identity covers the model, previous summary/cursor and prefix being removed, so merely appending retained tail messages does not bypass cooldown. Main applies cooldown only to threshold compaction; manual compaction, `clear_context` and context overflow recovery can still try immediately. Native request retries remain unchanged. Cancellation is not counted as failure, and a successful commit clears the matching cooldown. At most 32 inputs are tracked in session memory, outside checkpoints, so a restart permits a fresh attempt.

## CLI exports and feedback

These exports need no model connection:

```sh
coworkos session export <session-id-or-path> --format json --output audit.json
coworkos session export <session-id-or-path> --format html --output conversation.html
# Compatible legacy offline HTML export.
coworkos --export /path/to/session.jsonl conversation.html
```

The session argument accepts a full ID, unique prefix or path. Existing files are preserved by default. Even `--force` cannot overwrite the source session or its links. Export validates branch references and preserves source and existing output on failure. JSON includes all branches; standalone HTML has no scripts or external resources. See the [export format](../task-workspace-layout.md#coworkos-会话导出格式).

The interactive terminal supports `/export [json|html] [path]`, `/share [path]` and `/bug [description]`. Sharing copies and feedback reports stay local without automatic upload. `/help` lists commands and `/changelog` shows updates. Diagnostics are available through `/coworkos-debug`, `ATRIA_DEBUG=1 coworkos` and `Ctrl+O`.

Model-request archives and private retry snapshots are separate. Archives contain user content, tool results and model responses. Although authentication headers are excluded, protect these as private data. Usage represents only fields reported by the service; missing values are not zero and cannot prove upstream cache behavior. Paths, formats and retention belong to [data layout](../task-workspace-layout.md).

## Tasks, workers and human questions

Installed CLI users can replace `npm run cli --` with `coworkos`. These examples use an isolated development workspace:

```sh
npm run cli -- single "Read the project and summarize its implementation" --workspace /tmp/atria-dev
npm run cli -- task cancel <task-id> --workspace /tmp/atria-dev
npm run cli -- task resume <task-id> --workspace /tmp/atria-dev
# A single checkpoint resumes with the same Task and Run.
npm run cli -- single "Continue the current task" --workspace /tmp/atria-dev --task <task-id> --run <run-id> --resume
```

While Main waits for human input, list and answer durable questions from the CLI:

```sh
npm run cli -- human list --workspace /tmp/atria-dev --task <task-id> --status pending
npm run cli -- human reply --workspace /tmp/atria-dev --task <task-id> --request <request-id> --answer "Confirmed answer"
```

Accepted answers are consumed once. Reply drafts are saved per Task and question through failed submission and navigation. Waiting and background callbacks share durable delivery; read-only status checks do not consume callback results.

Independent recovery requires the correct Task, Run, model connection and budget:

```sh
# Restore the subagent queue and check once.
npm run cli -- worker --workspace /tmp/atria-dev --task <task-id> --run <run-id> --once
# Restore Main Inbox or an interrupted checkpoint.
npm run main-worker -- --workspace /tmp/atria-dev --task <task-id> --once true
# Report by default; --spawn true starts model processes.
npm run cli -- main-supervisor --workspace /tmp/atria-dev
npm run cli -- main-supervisor --workspace /tmp/atria-dev --spawn true
npm run cli -- watch-supervisor --workspace /tmp/atria-dev --task <task-id> --program <program-id>
```

Task/Watch/Worker commands validate options before execution. Place task or answer text beginning with `-` after `--`. Help and version queries do not start supervisors.

## Programmatic runs

`PiSession` / `RunService.runPi` accept these explicit options:

| Option                            | Contract                                                                                                                                                                                                   |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxTurns`                        | `0` disables the local turn limit                                                                                                                                                                          |
| `maxLengthContinuations`          | 0 to 100, default 0; permits extra continuation after truncation, without guaranteeing completion                                                                                                          |
| `contextWindow`, `compaction`     | Supply known context capacity and local compaction settings                                                                                                                                                |
| `sampling: { temperature, topP }` | Sent through the SDK; omission retains service defaults                                                                                                                                                    |
| `maxToolResponseChars`            | 64 to 16000000, default 16000; counts UTF-16 characters and retains text head/tail, images, error flags and full `details`; `load_skill` loads completely by default but still respects an explicit budget |
| `signal`                          | `runPi` propagates host cancellation to model and tools while retaining recoverable checkpoints                                                                                                            |

`lastStopReason` and `continuations.providerErrors/outputLimits` record the final stop reason and wrapper recovery counts, excluding normal tool-loop turns. Cancellation or timeout prevents later recovery. Coordinator persists queued options; caller defaults fill only fields missing from older queues.

The tool text budget covers returned content from ordinary runtime tools and additional `AgentTools`; restored history is not rewritten. Command feedback reserves exit and interruption status, log references and byte counts before allocating head/tail previews to stdout/stderr. It marks logs incomplete when fewer bytes were logged than observed. A small explicit budget prioritizes exit and interruption status and may omit other metadata; the full structure remains in `details`. `load_skill` retains complete instructions by default so required middle rules are not lost. Hosts can still explicitly choose a larger or smaller text budget.

Programmatic `createWebTools` / builtin `web` retains its existing contract. Without `provider: "exa"`, `visit` reads source text directly. Optional Jina Reader and extraction callbacks remain subject to total timeout and cancellation. Product Main search settings are in [web search](configuration.md#web-search). Model smoke and evaluation entry points are in [local testing](testing-local-run.md).

## Long-term goal interfaces and scheduling

`manage_goal` registers goals. Default `scope=background` uses an independent Task/Main; `scope=session` attaches to the current conversation. Read the current revision before editing or handing off. `action=steer` durably queues instructions without implying completion, changing the brief or resuming paused work. `record_goal_progress` saves plans, facts and wait conditions; `publish_goal_update` reports by topic. Reread after revision conflicts.

Use `record_goal_progress(nextReviewAt)` for reviews and `sleep_until(programId=...)` for session-goal sleep. Continued waiting needs an active source or explicit review time. Ordinary replies do not finish standing goals. After handoff, further model turns and automatic retries of the original request cannot create replacement collectors.

`create_watcher(programId=...)` attaches sources. Custom packages follow the [authoring skill](../../.pi/skills/virtual-agent-authoring/SKILL.md) and pass an explicit `activate_virtual_agent` probe. Only `activated=true` with a `monitorId` enables polling; failed probes remain drafts. Versioned handler loading, atomic upgrades and rollback are not implemented.

`npm start` scans the whole workspace by default; Task locks prevent duplicate scheduling. `COWORK_DISABLE_WATCH_SUPERVISOR=1` disables scheduling. `COWORK_SUPERVISOR_INTERVAL_MS` defaults to 60000. Sampling does not periodically invoke the model; no-change checks run no analysis. Analysis and Main-wake quotas are separate and retain evidence when exhausted. Model budgets use normal Main settings.

Successful analysis is saved before Inbox delivery; restart or delivery failure retries the saved result. Failure, timeout and cancellation retain source events for retry. Watch analysis uses a separate Run without replacing the Task's active Main Run. Fields and states are in [Product API](../product-api.md#persistent-monitors); pause behavior is in the [pause contract](../monitoring-pause-contract.md).

### macOS source monitoring service

After building a source checkout, explicitly install a user-level launchd service if needed. Ordinary startup does not install it:

```sh
npm run monitor-service -- install --workspace /absolute/path/to/workspace --config /absolute/path/to/config.json --port 3884
npm run monitor-service -- status --workspace /absolute/path/to/workspace --config /absolute/path/to/config.json
npm run monitor-service -- stop --workspace /absolute/path/to/workspace --config /absolute/path/to/config.json
npm run monitor-service -- uninstall --workspace /absolute/path/to/workspace --config /absolute/path/to/config.json
```

Installation saves the configuration path without copying model keys. The service binds to `127.0.0.1`, writes logs under workspace `.service/` and loads after login. `stop` unloads this instance; `uninstall` also removes login startup. `--global-index` and `--tabs-index` select existing indexes. Shutdown or sleep prevents checks, and source retention windows may limit catch-up.
