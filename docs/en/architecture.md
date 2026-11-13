# Architecture and development boundaries

English | [中文](../architecture.md)

CoworkOS is a local, single-user harness. CLI, Web and Electron share the runtime. Use the [code map](code-map.md) to find owners and tests, the [development guide](development.md) for setup, and the [workspace reference](../task-workspace-layout.md) (Chinese) for persistence.

## Composition and dependencies

```text
scripts/atria.mjs → src/cli/ → runtime / tools / workspace
desktop/ → src/cli/dashboard.ts → src/dashboard/
web/ ─────── HTTP/SSE ─────────→ src/dashboard/
                                 ├→ runtime / ProcessHost
                                 ├→ gui → security / native driver
                                 └→ workspace / storage / domain
Pi launcher → .pi/extensions/ → .pi/runtime/ → runtime / tools
```

Runtime workers also use tools and workspace services. Shared services do not import executable CLI modules. Runtime does not import Dashboard. GUI does not import HTTP or CLI. ESLint and [architecture tests](../../test/architecture-boundaries.test.js) enforce these directions.

The [project data service](../../src/workspace/project-data-service.ts) owns the project ledger, shared project identities and the demand board. The Dashboard opens the configured SQLite or PostgreSQL database at startup and applies versioned migrations; a bad configuration or unreachable database stops startup instead of switching engines. HTTP routes, the Main tool and `coworkos data backup/restore` use the same service interface; SQL dialect, connections and transactions stay inside the [storage adapters](../../src/storage/project-data/), so business code does not branch on the database. The Main tool reaches only its Task's project and cannot name another. The board is a separate projection of ledger requirements: a controlled external publish writes the requirement and its board item in one transaction, while an internal need stays ledger-only; a claim is a conditional update with one winner, pausing keeps ownership, and only an explicit release returns it to the unclaimed pool. The same service holds each project's persistent Main sessions and Run ownership; a session names one local Task as its history container, while the Pi transcript and execution directory stay on the backend that runs it. Another backend reaches the same authority through the [authenticated remote client](../../src/workspace/project-data-remote.ts) and binds only its own local directory, so a remote path never enters execution.

| Layer                    | Owns                                                                                      | Entry                                                                                                                                                 | Boundary                                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| CLI                      | Arguments, diagnostics, launch and signals                                                | [launcher](../../scripts/atria.mjs), [CLI](../../src/cli/cowork.ts), [Dashboard executable](../../src/cli/dashboard.ts)                               | Executable entrypoints; reusable HTTP code lives elsewhere                                 |
| Page/controllers         | Navigation, display, drafts, SSE, user interaction                                        | [app](../../web/app.js), [controllers](../../web/assets/controllers/), [UI](../../web/assets/ui/)                                                     | Services decide Task/Run outcomes; requests retain their original identity                 |
| Dashboard                | Local service composition, HTTP/SSE, Main process ownership                               | [application](../../src/dashboard/application.ts), [routes](../../src/dashboard/routes.ts), [Run](../../src/dashboard/run-service.ts)                 | Routes validate and map responses; Run writes no HTTP responses; routes spawn no processes |
| Runtime                  | Pi sessions, delegation, inbox, checkpoint, recovery, completion                          | [Coordinator](../../src/runtime/coordinator-runtime.ts), [RunService](../../src/runtime/run-service.ts), [PiSession](../../src/runtime/pi-session.ts) | No HTTP/DOM; completion accounts for workers, jobs, questions and messages                 |
| ProcessHost              | Process groups, duplicate launch protection, stop and bounded shutdown                    | [ProcessHost](../../src/runtime/process-host.ts)                                                                                                      | Does not decide conversation state                                                         |
| Pi integration           | Hooks, tool registration and context composition                                          | [thin entry](../../.pi/extensions/cowork.ts), [runtime](../../.pi/runtime/extension.ts), [tools](../../.pi/runtime/tools/)                            | Domain tools have their own modules; do not patch upstream Pi                              |
| GUI/security             | Window grants, observation/actions, serial queue, cancellation, audit                     | [ComputerUse](../../src/gui/computer-use.ts), [permissions](../../src/security/execution-permissions.ts)                                              | Trusted host grants authority; no model decisions                                          |
| Workspace/storage/domain | Task/Run data, inputs/artifacts, catalogs, events, trace, locks, types                    | [workspace](../../src/workspace/), [storage](../../src/storage/), [domain](../../src/domain/)                                                         | Explicit format compatibility, path ownership and migration                                |
| Desktop                  | Native windows, trusted IPC, encrypted client credentials, user directories, save on exit | [main](../../desktop/main.cjs), [preload](../../desktop/preload.cjs), [backend](../../desktop/backend.cjs)                                            | Renderer has no Node privileges; artifact preview has no trusted bridge                    |

Importing `createDashboardApplication()` opens no port and installs no signal handlers. `src/cli/dashboard.ts` owns listening and shutdown signals. Tests explicitly compose and stop reusable services.

## Task, Run and process lifetime

A browser request flows through HTTP routes → Dashboard Run → AgentProcessHost → Pi launcher → Pi extension → Coordinator. CLI can use runtime services directly. These entrypoints share business semantics.

Dashboard Run owns the Main process and serializes starting/stopping the same Task. Runtime RunService owns the actual Pi session, Task/Run events and checkpoints. Persist state and output before announcing completion; the last text message alone is insufficient.

Main is resident: one Run is served by one Pi process, a finished turn leaves that process running, and later user messages and callbacks arrive through its own durable Inbox and start the next turn. The process is identified by the host and OS start time recorded at launch, so a backend restart or upgrade re-adopts the Main still running. Only closing the session (which also stops the Subagents that session started), the idle timeout and a model request that cannot continue end it. A pause stops at the step boundary and keeps the process; a cancel interrupts the current turn only. An idle exit keeps the session file and Task state, and the next message or callback starts Main again on the same session. Whether a Main process exists and whether a turn is running are separate facts, reported by the backend record and by the process heartbeat.

Delegation converges on the backend too: Main's `call_subagent` only registers a work item with the backend, which writes it into that Run's durable queue, launches a separate Pi process as soon as its dependencies and lease allow, and projects the process's exit back into the queue, the Run events and Main's callback. One owner per workspace root launches and settles delegated processes: while the Dashboard runs, the CLI worker takes no work, and a restarted owner re-adopts the subagents still running and delivers the callbacks that ended while it was away. A subagent's session, site and conclusion are recorded per work item, so a rework appends one turn to the original Executor's Pi session file and checkout; no session or workspace state lives only in the dispatch request or in process memory.

On desktop exit, trusted IPC first waits for the renderer's draft/document save check; unsaved documents or task drafts prompt the user to return and fix them or confirm the exit. The backend and accepted runs continue after the desktop closes. Save failures preserve the window and draft.

Desktop and Web read and save model and search settings through the selected execution host; the host rejects changes while tasks are running. Open forms bind to a backend instance. The desktop encrypts client session credentials and injects them into trusted main-window API requests. Task notifications use the shared catalog stream and deduplicate by backend and completion.

Pi `before_agent_start` registers tools before the first request; `context` refreshes context between later requests. Tests must cover real Pi hook order and subprocess termination.

The durable Inbox is the delivery channel Main and delegated processes share: the backend writes callbacks, external events, guidance, questions and peer messages into the target process's own Inbox, and the process's extension reads it at a safe turn boundary. `main.interrupt` and `main.resume` travel the same channel as process commands, consumed without entering the model context. An idle delegated process is woken by a file watch, never over standard input and never by polling. A message counts as consumed only once it is in the process's Pi session context, so it survives backend restarts and is read exactly once. Timed parks and Main recovery keep their rules: the Dashboard Run service checks periodically and starts a Main again for a Task with callbacks or a due wake when no Main is alive, and Main decides whether to continue.

Visual observations share the Task image archive. Dashboard/desktop owns native ComputerUse policy, exclusive sessions and current action credentials; Main/Pi owns its ephemeral Chromium context.

QuickJS keeps current Pi-session script state and dispatches each operation to an already active native/browser tool, which retains parameter, ownership and authorization checks. Session change/shutdown clears the VM and closes the browser, retaining Task images and accepted downloads. Persisted tool selection restores groups, not objects. See the Chinese [visual](../visual-observation.md), [browser](../browser-use.md) and [script](../cua-scripting.md) guides.

## Conversation and UI consistency

Composer Session stores drafts and validated attachments per conversation. Sending captures the original Task, draft token, model and attachments. Refresh, switching, queued/steered messages and attachment reads retain that identity. Streaming updates preserve DOM identity, focus, selection, reading position and expanded details.

Desktop ports change between launches, so origin localStorage alone cannot restore drafts. Trusted preload restores private `composer-drafts.json` before page startup and mirrors only allowed draft keys. Files have format/size checks, atomic writes and corrupt backups. Web uses origin storage.

## Trust and support limits

- Local development may omit a token; Host/Origin checks still apply. Desktop uses a random port/token and IPC readiness. API authentication uses a local HttpOnly cookie or trusted child-process header.
- Native IPC accepts only the main window's main frame. Secrets stay out of renderer state, source and packages. Desktop encryption differs from Web/CLI configuration storage; see the runtime guide.
- Computer Use has three Settings buttons: Screen Recording, Accessibility and window access. System permissions are requested separately and their buttons become disabled once actually granted. Window access defaults off and can only be enabled when both are ready; trusted desktop IPC checks fresh status before persisting enabled=true/mode=control and permits all conversations to observe and control every visible application window.

  Policy stays separate from Task/window sessions. Legacy observe-only policy is restored disabled with its source file preserved, rather than silently gaining control. HTTP/agents consume that policy without changing it.

  One Task owns the complete observe/action workflow; other Tasks wait in FIFO order. Global sessions renew automatically; legacy manual grants retain five-minute expiry. Takeover requires explicit human resume. Cancellation, navigation/crash, shutdown and workspace changes revoke temporary sessions; restart restores policy only.

- macOS 14+ capture, unlocked input, models that accept image input, commercial apps and clean-machine permissions require separate evidence. Permission/lock-screen skips do not certify input.
- `GrantedPermissions` covers GUI host grants; it does not prove Pi bash/jobs are confined by a universal OS sandbox.
- The App targets Apple Silicon Mac. Windows/Linux GUI drivers, remote workers, multiple users and unattended updates are not shipped.

Update producers, consumers, compatibility/recovery docs and behavior tests together. Review roles are in [module ownership](../module-ownership.md) (Chinese); PR requirements are in [CONTRIBUTING](../../CONTRIBUTING.en.md). Public gates are in [contribution requirements](../../CONTRIBUTING.en.md#pr-review-and-release) and the [Mac release guide](../mac-release.md) (Chinese).
