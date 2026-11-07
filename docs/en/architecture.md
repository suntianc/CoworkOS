# Architecture and development boundaries

English | [中文](../architecture.md)

CoworkOS is a local, single-user harness. CLI, Web and Electron share runtime and application services. Use the [code map](code-map.md) to find owners and tests, the [development guide](development.md) for setup, and the [workspace reference](../task-workspace-layout.md) (Chinese) for persistence.

## Composition and dependencies

```text
scripts/atria.mjs → src/cli/ → runtime / tools / workspace
desktop/ → src/cli/dashboard.ts → src/dashboard/
web/ ─────── HTTP/SSE ─────────→ src/dashboard/
                                 ├→ runtime / ProcessHost
                                 ├→ applications → software
                                 ├→ gui → security / native driver
                                 └→ workspace / storage / domain
Pi launcher → .pi/extensions/ → .pi/runtime/ → runtime / applications / tools
```

Runtime workers also use applications, tools and workspace services. Shared services do not import executable CLI modules. Runtime and applications do not import Dashboard. GUI does not import HTTP, application document protocols or CLI. ESLint and [architecture tests](../../test/architecture-boundaries.test.js) enforce these directions.

The [project data service](../../src/workspace/project-data-service.ts) owns the project ledger and shared project identities. The Dashboard opens the configured SQLite or PostgreSQL database at startup and applies versioned migrations; a bad configuration or unreachable database stops startup instead of switching engines. HTTP routes, the Main tool and `coworkos data backup/restore` use the same service interface; SQL dialect, connections and transactions stay inside the [storage adapters](../../src/storage/project-data/), so business code does not branch on the database. The Main tool reaches only its Task's project and cannot name another. The demand board is a separate projection of ledger requirements: a controlled external publish writes the requirement and its board item in one transaction, while an internal need stays ledger-only; a claim is a conditional update with one winner, pausing keeps ownership, and only an explicit release returns it to the unclaimed pool. Another backend reaches the same authority through the [authenticated remote client](../../src/workspace/project-data-remote.ts) and binds only its own local directory, so a remote path never enters execution.

| Layer                    | Owns                                                                                      | Entry                                                                                                                                                                         | Boundary                                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| CLI                      | Arguments, diagnostics, launch and signals                                                | [launcher](../../scripts/atria.mjs), [CLI](../../src/cli/cowork.ts), [Dashboard executable](../../src/cli/dashboard.ts)                                                       | Executable entrypoints; reusable HTTP/MCP code lives elsewhere                                    |
| Page/controllers         | Navigation, display, drafts, SSE, tabs, user interaction                                  | [app](../../web/app.js), [controllers](../../web/assets/controllers/), [workbench](../../web/assets/workbench/)                                                               | Services decide resource revisions and Task/Run outcomes; requests retain their original identity |
| Dashboard                | Local service composition, HTTP/SSE, Main process ownership                               | [application](../../src/dashboard/application.ts), [routes](../../src/dashboard/routes.ts), [Run](../../src/dashboard/run-service.ts)                                         | Routes validate and map responses; Run writes no HTTP responses; routes spawn no processes        |
| Runtime                  | Pi sessions, delegation, inbox, checkpoint, recovery, completion                          | [Coordinator](../../src/runtime/coordinator-runtime.ts), [RunService](../../src/runtime/run-service.ts), [PiSession](../../src/runtime/pi-session.ts)                         | No HTTP/DOM; completion accounts for workers, jobs, questions and messages                        |
| ProcessHost              | Process groups, duplicate launch protection, stop and bounded shutdown                    | [ProcessHost](../../src/runtime/process-host.ts)                                                                                                                              | Does not decide conversation/resource state                                                       |
| Pi integration           | Hooks, tool registration, application context composition                                 | [thin entry](../../.pi/extensions/cowork.ts), [runtime](../../.pi/runtime/extension.ts), [bridge](../../.pi/runtime/application-bridge.ts), [tools](../../.pi/runtime/tools/) | Domain tools have their own modules; do not patch upstream Pi                                     |
| Applications             | Registry, instances, shared resources, binding, revision/CAS, history, source files, MCP  | [service](../../src/applications/application-service.ts), [types](../../src/applications/types.ts), [adapters](../../src/applications/adapters/)                              | Callers share operation semantics; no screen input                                                |
| Software                 | Generic software behavior, async drivers, binary/project resources                        | [contracts](../../src/software/contracts.ts), [service](../../src/software/software-service.ts), [registry](../../src/software/provider-registry.ts)                          | Preserve v1 semantics; drivers own cancellation, candidate commits and failure recovery           |
| GUI/security             | Window grants, observation/actions, serial queue, cancellation, audit                     | [ComputerUse](../../src/gui/computer-use.ts), [permissions](../../src/security/execution-permissions.ts)                                                                      | Trusted host grants authority; no document CAS or model decisions                                 |
| Workspace/storage/domain | Task/Run data, inputs/artifacts, catalogs, events, trace, locks, types                    | [workspace](../../src/workspace/), [storage](../../src/storage/), [domain](../../src/domain/)                                                                                 | Explicit format compatibility, path ownership and migration                                       |
| Desktop                  | Native windows, trusted IPC, encrypted client credentials, user directories, save on exit | [main](../../desktop/main.cjs), [preload](../../desktop/preload.cjs), [backend](../../desktop/backend.cjs)                                                                    | Renderer has no Node privileges; artifact preview has no trusted bridge                           |

Importing `createDashboardApplication()` opens no port and installs no signal handlers. `src/cli/dashboard.ts` owns listening and shutdown signals. The application MCP client lives in `src/applications/mcp/local-api-client.ts`. Tests explicitly compose and stop reusable services.

## Task, Run and process lifetime

A browser request flows through HTTP routes → Dashboard Run → ProcessHost → Pi launcher → Pi extension → Coordinator/application services. CLI can use runtime services directly. These entrypoints share business semantics.

Dashboard Run owns the Main child process and serializes starting/stopping the same Task. Runtime RunService owns the actual Pi session, Task/Run events and checkpoints. Persist state and output before announcing completion; the last text message alone is insufficient.

On desktop exit, trusted IPC first waits for the renderer's draft/document save check; unsaved documents or task drafts prompt the user to return and fix them or confirm the exit. The backend and accepted runs continue after the desktop closes. Save failures preserve the window and draft.

Desktop and Web read and save model and search settings through the selected execution host; the host rejects changes while tasks are running. Open forms bind to a backend instance. The desktop encrypts client session credentials and injects them into trusted main-window API requests. Task notifications use the shared catalog stream and deduplicate by backend and completion.

Pi `before_agent_start` discovers bound applications/tools before the first request; `context` refreshes changes between later requests. Tests must cover real Pi hook order and subprocess termination.

Main/Watch supervisors, durable inbox, goal management and explicit Virtual Agent activation exist. In-app activity/digests and desktop task notifications are implemented; broader real sources and sustained-run evaluation remain planned.

Visual observations share the Task image archive. Dashboard/desktop owns native ComputerUse policy, exclusive sessions and current action credentials; Main/Pi owns its ephemeral Chromium context.

QuickJS keeps current Pi-session script state and dispatches each operation to an already active native/browser tool, which retains parameter, ownership and authorization checks. Session change/shutdown clears the VM and closes the browser, retaining Task images and accepted downloads. Persisted tool selection restores groups, not objects. Existing Adapters provide application-specific operations. See the Chinese [visual](../visual-observation.md), [browser](../browser-use.md) and [script](../cua-scripting.md) guides.

## Resource and UI consistency

Resources belong to application space; conversations hold references. Multiple conversations can share one document. Application resource roots and Task storage roots are independent: a project resource service can manage references, manifests and instance loading relationships for Tasks in user data, without assuming Tasks live beneath its resource root. New independent editors also create their holding Tasks in the default real Task store; existing project-local holding Tasks remain in place. Application-service caches distinguish both the resource root and Task storage root.

After binding, HTTP, Run and Pi use [Task application resolution](../../src/applications/task-service.ts) to restore the active resource root from the same durable Task binding, without migrating old bindings to the current project folder. Separating the paths does not migrate or delete old data; backups cover both roots and external originals.

Writes use revision CAS and preserve manual drafts on conflict. MCP processes belong to application windows/local service and outlive a single Run. Resource updates reuse Run SSE; workbench polling covers tasks without an active Run.

v1 is a synchronous UTF-8 protocol for text files; binary resources use immutable snapshot manifests. The default application catalog is empty, and registered adapters generate candidates outside the lock before validating them and committing manifest CAS inside it. General multi-file transactions, remote drivers and complete generic v2 UI/history are unfinished.

Workbench polling removes only invalid tabs confirmed in its captured snapshot. Creating a document rekeys `window:<instanceId>` to `resource:<resourceId>` in place. Explicit navigation captures Task/draft identity and a navigation token and checks them after each async step. Late work may complete in the background but cannot replace newer navigation.

Composer Session stores drafts and validated attachments per conversation. Sending captures the original Task, draft token, model and attachments. Refresh, switching, queued/steered messages and attachment reads retain that identity. Streaming updates preserve DOM identity, focus, selection, reading position and expanded details.

Desktop ports change between launches, so origin localStorage alone cannot restore drafts. Trusted preload restores private `composer-drafts.json` before page startup and mirrors only allowed draft keys. Files have format/size checks, atomic writes and corrupt backups. Web uses origin storage. Review reads snapshots; undo creates a new revision through CAS.

## Trust and support limits

- Local development may omit a token; Host/Origin checks still apply. Desktop uses a random port/token and IPC readiness. API authentication uses a local HttpOnly cookie or trusted child-process header.
- Native IPC accepts only the main window's main frame. Secrets stay out of renderer state, source and packages. Desktop encryption differs from Web/CLI configuration storage; see the runtime guide.
- Computer Use has three Settings buttons: Screen Recording, Accessibility and window access. System permissions are requested separately and their buttons become disabled once actually granted. Window access defaults off and can only be enabled when both are ready; trusted desktop IPC checks fresh status before persisting enabled=true/mode=control and permits all conversations to observe and control every visible application window.

  Policy stays separate from Task/window sessions. Legacy observe-only policy is restored disabled with its source file preserved, rather than silently gaining control. HTTP/agents consume that policy without changing it.

  One Task owns the complete observe/action workflow; other Tasks wait in FIFO order. Global sessions renew automatically; legacy manual grants retain five-minute expiry. Takeover requires explicit human resume. Cancellation, navigation/crash, shutdown and workspace changes revoke temporary sessions; restart restores policy only.

- macOS 14+ capture, unlocked input, actual vision models, commercial apps and clean-machine permissions require separate evidence. Permission/lock-screen skips do not certify input.
- `GrantedPermissions` covers software v2/GUI host grants; it does not prove Pi bash/jobs are confined by a universal OS sandbox.
- The App targets Apple Silicon Mac. Windows/Linux GUI drivers, remote workers, multiple users and unattended updates are not shipped.

Update producers, consumers, compatibility/recovery docs and behavior tests together. Review roles are in [module ownership](../module-ownership.md) (Chinese); PR requirements are in [CONTRIBUTING](../../CONTRIBUTING.en.md). Public gates are in [contribution requirements](../../CONTRIBUTING.en.md#pr-review-and-release) and the [Mac release guide](../mac-release.md) (Chinese).

## Durable goals, monitoring and pause

`WatchProgram.goal` owns the durable brief, plan, facts, waiting conditions and reporting preferences; multiple sources share one goal. `GoalStore` owns locks/revisions; `GoalManagement` is shared by Pi and HTTP; `GoalSupervisor` repairs persisted side effects and queues instructions/reviews without planning for Main. Goal context is bounded, and full activity is not automatically injected. In-app activity, unread state and digests are implemented; system push and sustained real-source evaluation remain roadmap work. See the [goal reference](../long-term-goals-architecture.md) (Chinese).

`WatchManagement` shares source activation/controls. `ScriptWatcher` uses terminable child processes and an atomic state/outbox checkpoint; `WatcherRuntime` acknowledges only after durable Inbox acceptance. `WatchSupervisor` separates sampling, analysis, retries and wake delivery. Dashboard owns scheduling over registered workspaces and launches Main through its existing Run service; CLI supervisors coordinate through Task cycle locks. An independent background goal has its own Task/Main, while session goals use the current Main.

Exiting the host or machine sleep stops checks; startup resumes durable state. A macOS source checkout may explicitly install a user-level launchd service; ordinary startup does not install an OS service. See [runtime](runtime-reference.md#long-term-goal-interfaces-and-scheduling).

Pause is durable control intent, including legacy records whose remaining sources are paused. Fully paused background work holds saved clocks, callbacks, answers and retries without launching Main or creating replacements. Only user-authorized resume releases them; session pause does not stop unrelated work. Activation and control share a short lock and recheck intent after probing. See the [pause contract](../monitoring-pause-contract.md).
