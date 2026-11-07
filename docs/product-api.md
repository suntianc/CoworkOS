# Cowork Product API

Route implementations: [Dashboard](../src/dashboard/routes.ts), [applications](../src/dashboard/application-routes.ts), and [HTTP boundary](../src/dashboard/http.ts). This document covers the local HTTP API; software v2 remains a host interface.

Computer Use discovers/selects windows using an enabled desktop global policy or consumes a legacy Task grant for observation/actions through [task-scoped HTTP routes](computer-use.md#产品和宿主边界). GET /api/computer/access reports policy/ownership metadata; GET /api/computer/status reports the execution host's native capabilities and permission state. Task status includes access, and POST discover/select/release consumes or releases existing global authority. The internal host endpoints require a matching backend identity and an explicit token, and reject browser Origin, fetch metadata and cookies. Permission requests, local confirmation and enabling or resuming access require the host credential; session credentials can still read, pause or revoke access. The backend supplies Main and Watch commands with an in-memory business credential that expires on restart. Coordinator command environments stay in memory, and standalone CLI or Main delegation forwards a credential only after the backend identifies it as a business session.

Actions accept optional `observeAfter: true` for atomic post-action feedback; `dispatched` acknowledges delivery, while `effectVerified: false` requires the caller to inspect the returned observation.

GET preview returns the last frame without replacing the agent observation; POST preview refreshes a human screenshot using the existing task session without issuing or replacing an agent observation ID.

This is the boundary between the Cowork Runtime and the desktop/Web UI. The UI must consume this API instead of reading Task workspace files directly.

The current implementation is a local single-user service bound to `127.0.0.1`. Host/Origin checks apply to every request.

The serving process publishes a host credential in its instance record. A client exchanges that credential for a named local session, which authorizes business requests; see [Local sessions and management commands](#local-sessions-and-management-commands). Development mode without a token remains local-only. Remote/multi-user deployment is unsupported: the listener stays on `127.0.0.1`, and Host/Origin checks run before any credential check. See [architecture](architecture.md) and [software integration](software-integration.md) for current module and protocol boundaries.

## Global APIs

```text
GET  /api/backend
POST /api/session
GET  /api/session
DELETE /api/session/:sessionId
GET  /api/operations/:operationId
GET  /api/events/snapshot
GET  /api/events/stream?cursor=<seq>
GET  /api/models
GET  /api/model-settings
POST /api/model-settings
POST /api/model-settings/test
GET  /api/web-search-settings
POST /api/web-search-settings
POST /api/workspace/choose
POST /api/projects
PATCH /api/projects/:projectId
POST /api/projects/choose-directory
GET  /api/projects/:projectId/experience
POST /api/projects/:projectId/experience
```

Models returns `{ current, models, configured }`. `GET /api/tasks` returns the grouped catalog `{ workspaceRoot, currentWorkspaceRoot, model, tasks, projects }`, rather than a bare Task array. Explicit projects remain in `projects` with `tasks: []`; legacy automatic groups retain their directory-based IDs and the sidebar hides them when they have no unarchived conversations.

`GET /api/backend` returns `{ backendId, pid, startedAt, protocol }` for the process serving this data root. `protocol` is `{ version, minClientVersion, capabilities }`. The standalone backend keeps `backendId` across restarts, so a client can tell a restarted process from a different backend, and `pid` lets a host stop only the process it recorded. The route is local and credential-checked like the other `/api/*` routes and exposes no configuration.

Desktop and Web use the same model and search HTTP routes. Desktop keeps its client session credential in the host and authorizes the selected backend's requests through the host-managed session.

Model and search credentials belong to the execution host. `GET /api/model-settings` never returns a key: it returns the connection list plus `configured` and `credentialUnavailable`/`credentialError` when a saved key cannot be read here. `POST /api/model-settings` writes the submitted key to the host credential file (`credentials.json`, mode 0600, beside the configuration; `COWORK_CREDENTIALS` overrides the path) and returns the same redacted status. A blank key keeps the stored one. Old Electron ciphertext is reported as unavailable instead of configured, `POST /api/model-settings/test` rejects it with the same message, and submitting a key replaces it. `GET /api/web-search-settings` follows the same rule with `secretUnavailable`; `POST` stores or clears the Exa key in that file. Use `node scripts/migrate-desktop-settings.mjs --config <config path>` while the backend is stopped to convert old ciphertext once; it backs up the original as `<config>.before-host-credentials` and reports `already-migrated` on a rerun. See [connection storage](configuration-reference.md#连接存储与兼容).

Create a project with `POST /api/projects { projectName, projectDirectory }`; update its name and/or folder with `PATCH /api/projects/:projectId`. Both return `{ project }`, containing `projectId`, `projectName`, `projectDirectory`, `workspaceRoot` (the project folder), `createdAt`, `updatedAt`, and `tasks`. Newly created IDs are stable `project_<uuid>` values. Names must be nonempty and at most 120 characters. The directory must be an existing absolute folder; duplicate project directories return 409. Creation persists an empty project without creating a Task or calling the model.

Folder changes apply to every associated conversation. Active Main/subagents, waiting work, scheduled wakeups, or command jobs reject directory changes with 409; renaming is allowed. Project changes and run startup are serialized to prevent changing a running conversation's CWD.

`POST /api/projects/choose-directory` opens the local picker and returns `{ cancelled, projectDirectory? }`; choosing a folder does not save a project.

Empty migrated records without valid history or application documents are omitted from `GET /api/tasks`, while their persisted indexes and files remain intact. An otherwise empty legacy project with a real document exposes `hasApplications: true`. Internal editor holding Tasks do not establish projects; empty legacy groups derived only from Task storage are omitted. Explicit creation or editing adopts the project as a user choice, so it remains visible when empty.

New documents in an unbound conversation use the project folder; loaded instances and old resource references retain their original roots. New resource metadata and resolved application tabs include an optional, host-resolved `projectId` for stable document ownership; referencing conversations and project folder changes do not rewrite it. Older resources remain compatible without the field. Application workspace discovery includes durable references and loaded instance roots, so old documents remain accessible after a folder change without registering their roots as Task storage.

The legacy global `POST /api/workspace/choose` still accepts `{ workspaceRoot }` (or opens the picker when omitted) and returns `{ cancelled, ...taskList }` for application/data compatibility. Its task-scoped `{ taskId, workspaceRoot }` form returns 410: change the owning project's settings instead. Conversations inherit their project's folder and cannot independently reassign it.

Model connection testing accepts `{ baseUrl, model, api?, apiKey?, supportsImages? }` without saving. An omitted or blank key uses the existing local secret; environment-managed connections test the effective configuration. `api` accepts `openai-completions` (default for legacy configurations) or `openai-responses`; unknown values are rejected before saving or requesting. Omitted values preserve the saved format. GET settings returns the effective format; `COWORK_MODEL_API` overrides local configuration and makes Web settings environment-managed.

The service verifies a function call in the selected protocol and, when enabled, a synthetic image challenge. Success returns `{ ok: true, model, supportsImages, durationMs }`; errors contain only local diagnostics and never provider response bodies or credentials. Desktop and Web both call `POST /api/model-settings/test`. This is a connection check, not a general quality benchmark or a guarantee of arbitrary tool compatibility.

## Local sessions and management commands

Route implementations: [sessions](../src/dashboard/session-routes.ts), [local access](../src/dashboard/local-access.ts), [protocol](../src/dashboard/backend-protocol.ts) and [commands](../src/dashboard/management-commands.ts). This is the protocol seam every local client shares; the desktop host, the Web UI and future clients must use it instead of reading backend files.

A host credential authorizes once and names this client as a session. Every later request presents the session credential in the same headers the host credential uses. Sessions belong to the data root and survive a backend restart; only their hashes are written. Revoking one client never disturbs the owner's other clients, and the host credential itself keeps working for owned tools that never authorize.

| Endpoint                           | Behavior                                                                                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/session`                | `{ clientName?, protocolVersion }` → HTTP 201 `{ session: { sessionId, token, clientName?, protocolVersion, createdAt }, backend, protocol }`. |
| `GET /api/session`                 | `{ current: { kind, sessionId? }, sessions }`; the host sees every session, a session sees itself. Listing never repeats a secret.             |
| `DELETE /api/session/:sessionId`   | Revoke one session (a session may end itself, the host may end any) → `{ sessionId, revokedAt, revoked: true }`. Repeating is a success.       |
| `GET /api/operations/:operationId` | The saved receipt `{ operationId, command, status, body, completedAt }` of this identity's command, or HTTP 404 `operation_unknown`.           |

`protocolVersion` is `major.minor`. The major number is compatibility; a client minor newer than this backend is refused, an older one is accepted. A missing version returns HTTP 400 `protocol_required`; an incompatible one returns HTTP 409 `protocol_incompatible` naming both versions, so both sides can show an actionable upgrade message. Capabilities describe the protocol this backend serves; clients branch on capability names instead of route probing. `events.snapshot` and `events.stream` name the catalog reconciliation below: a client that requires them and does not find them reports the missing names instead of probing routes or half-loading a screen.

Change commands accept an optional `operationId`: `POST /api/projects`, `PATCH /api/projects/:projectId`, `POST /api/tasks` and `POST /api/tasks/:taskId/goals/:programId/control`. Management clients send one on every change; omitting it keeps the legacy single-shot behavior the current Web UI uses.

- The same identity, `operationId` and command content returns the saved status and body, marked with the `x-cowork-replayed: 1` response header, instead of applying the change again. Two in-flight duplicates still produce one result.
- The same `operationId` with different content returns HTTP 409 `operation_conflict` and changes nothing.
- Receipts are per identity: one client never reads another client's command result. A receipt exists only for a command that succeeded; a failed command can be retried.
- A lost response is reconciled by reading the receipt, then retrying with the same identity, `operationId` and content. The receipt is written before the response, so a restart between them replays the saved result.

Object changes carry the expected revision their service checks under its own lock: goal lifecycle controls send `revision`, and a stale value returns HTTP 409 `revision_conflict` without changing state. An operation id is the command's identity, not a substitute for the revision check: a replay returns the saved result, while a new command with a stale revision is refused.

Stable error codes: `unauthorized`, `session_revoked`, `session_unknown`, `host_credential_required`, `protocol_required`, `protocol_incompatible`, `operation_id_invalid`, `operation_conflict`, `operation_unknown`, `operation_receipt_invalid`, `revision_conflict`, `cursor_required`, `cursor_expired`, `cursor_unknown`. Messages stay in the server's user-facing language; clients branch on the code. A damaged receipt is never treated as "no command": it returns 500 `operation_receipt_invalid` and leaves the file in place, because re-running the command could apply it twice.

## Snapshot and event recovery

Route implementation: [catalog events](../src/dashboard/catalog-events.ts) over the [durable event ledger](../src/dashboard/event-ledger.ts); the shared client is [management-events.js](../web/assets/controllers/management-events.js). A client that reconnects reconciles here instead of re-reading every Task: the snapshot is the same authoritative catalog `/api/tasks` serves, and the sequence it names is what a subscription resumes from.

`GET /api/events/snapshot` returns `{ backendId, cursor, revisions, ...taskList }` (the fields of `GET /api/tasks`, plus `backendId`, `cursor` and `revisions`). `revisions` maps `project:<projectId>` and `task:<taskId>` to the object revision the snapshot describes. `cursor` is the last event sequence included in the lists. The snapshot and the cursor are taken together, so a change that commits after the snapshot answers is replayed by the subscription rather than lost in the handoff.

`GET /api/events/stream?cursor=<seq>` is Server-Sent Events. Each `data:` frame is one event record:

```json
{
  "version": 1,
  "backendId": "backend_...",
  "seq": 42,
  "eventId": "backend_...:42",
  "scope": "task",
  "objectId": "task-1",
  "revision": 3,
  "type": "task.changed",
  "occurredAt": "2026-01-01T00:00:00.000Z",
  "payload": { "taskId": "task-1", "title": "...", "status": "running" }
}
```

- `seq` is the backend-wide order; `eventId` is the stable identity; `scope` and `objectId` name the object; `revision` counts that object's own published changes. The cursor is the last `seq` the client applied.
- `type` is `project.changed`, `task.changed` or `task.deleted`. `payload` is the whole object (`{}` for a deletion), so applying an event never depends on a delta the client did not have.
- A `task.deleted` tombstone is published for an object this backend already published and that then disappears from a complete catalog read. A workspace root that cannot be read is not treated as a deletion.
- A `stream.reset` frame reports that the subscriber fell behind the retained log; it names `code` and the current `cursor` and ends the connection. The client takes a new snapshot instead of continuing from a hole.

Cursor outcomes: a missing or non-integer `cursor` returns HTTP 400 `cursor_required`; a cursor older than the retained log returns HTTP 409 `cursor_expired`; a cursor above the current sequence (another backend's, or a lost history) returns HTTP 409 `cursor_unknown`. Both 409s name the retained range and require a new snapshot. The log keeps the newest 2000 records by default (`COWORK_EVENT_LEDGER_RECORDS`, 4–100000); compaction folds older records into a persisted index that keeps each object's revision.

Events are written and fsynced after the business change commits. Every change published by `POST /api/projects`, `PATCH /api/projects/:projectId`, `POST /api/tasks`, `PATCH /api/tasks/:taskId`, `POST /api/tasks/:taskId/action` and `DELETE /api/tasks/:taskId` appends its event immediately. A change made by another writer (a Run transition, an MCP edit) becomes an event when the catalog is next read: on any snapshot, including the first one after a restart, and about once a second while a subscription is open (`COWORK_EVENT_RECONCILE_MS`). Nothing reconciles in the background at backend startup: a restart heals a committed change whose event was never written when the next snapshot is taken or the next subscription opens. Reconciliation publishes such a change and never rolls a published object back.

A client must follow these rules; [management-events.js](../web/assets/controllers/management-events.js) implements them:

1. Bind to one backend identity. Drop any snapshot or record whose `backendId` is not the bound one; after switching backends, close the old connection, discard its cache and take a new snapshot.
2. Snapshot first, then subscribe from that snapshot's `cursor`.
3. Ignore a record at or below the applied cursor (duplicate); ignore a record whose object `revision` is not newer than the snapshot's (stale replay).
4. On a `seq` gap, reconnect from the applied cursor so the server replays the missing records in order; on `cursor_expired`/`cursor_unknown` or `stream.reset`, take a new snapshot.
5. Reconnecting replays events only. A command is never re-sent by a reconnect; use the `operationId` and receipt rules above when a command's response was lost.

`createManagementEventClient({ backendId, baseUrl, fetch, headers, onSnapshot, onEvent, onReset, onStatus })` exposes `start()`, `snapshot()`, `switchBackend({ backendId, baseUrl })`, `stop()` and `state()`. The Web UI and the desktop host consume the catalog through it rather than opening their own event channel.

### Shared browser client

[management-client.js](../web/assets/controllers/management-client.js) is the one module a browser page uses for the whole protocol: it authorizes a named session with `POST /api/session`, checks the returned protocol and capabilities, reads the catalog snapshot, follows the event stream, and sends change commands with an `operationId` and receipt reconciliation. It downloads backend files and uploads attachments through the same session, so a page never needs Electron IPC or a second transport.

- One bound `backendId` + `baseUrl`. Sessions are stored per backend origin, so a token minted by one backend is never presented to another.
- `switchBackend({ baseUrl })` aborts every in-flight request, stops the old event stream, and retires the old identity. A response that still resolves afterwards is rejected as `stale_client`; a late event is dropped because its `backendId` does not match. The page also swaps its draft namespace (`composer-session.js`), so drafts stay with the backend that owns them and a switch back restores them.
- `authorize()` is explicit. A revoked or unknown session puts the page in `unauthorized` with a reauthorize action; an incompatible version or missing capability (`incompatible`/`unsupported`) names both versions or the missing names. Nothing silently retries.
- `command(path, { method, body, operationId })` sends the command once. If the response is lost it reads `GET /api/operations/:operationId` and only re-sends content the backend never accepted.
- `snapshot()`, `blob(path)`, `download(path, name)`, `upload(file)`, and `openStream(path)` keep the session header and the bound origin, which is what lets one page manage another trusted local backend.

### Trusted local client origins

A page served by one local backend may manage another. Browsers send that request with the page's `Origin` and require CORS, and the serving page's own `Content-Security-Policy` must allow the other origin in `connect-src`. `COWORK_TRUSTED_CLIENT_ORIGINS` names those exact origins:

```text
COWORK_TRUSTED_CLIENT_ORIGINS=http://127.0.0.1:3880,http://localhost:3881
```

Only exact loopback `http://` origins are accepted. The value is never wildcarded and never opens the listener to a non-local host; every other origin keeps the single-origin rule and `sec-fetch-site: cross-site` stays refused. For each named origin the backend answers the preflight, adds `Access-Control-Allow-Origin` for that exact origin with credentials, and lists those origins in the page's `connect-src`. The credential policy (host credential or session) still applies to every real request, so naming an origin does not itself grant access.

The local host credential is a host-scoped cookie, so browsers sharing `127.0.0.1` present the same credential to every local backend served there. `POST /api/session` therefore succeeds against another local backend only when the host installed a credential that backend accepts in the same browser context. Cross-machine remote entry remains out of scope (P6).

## Project experience

`GET /api/projects/:projectId/experience` returns `{ revision, settings, items }`, with `Cache-Control: no-store`. Catalog resolution owns the stable project identity and paths; request bodies cannot choose a storage directory. `settings` contains independent `enabled`, `learningEnabled`, `autoActivate` (all default false), optional `model`, `maxTokens` (default 2048, range 256–4096), and `maxRequestsPerHour` (default 6, range 2–24). Items include formal and candidate experience/skill records, state, manual/automatic origin, pin, current version, bounded historical versions and source/validation quotes. Internal queues, quota timestamps and deduplication records are not returned.

POST actions all carry the GET `snapshotRevision`. `configure` accepts `{ action, snapshotRevision, settings }`; settings are a partial update, and `model:""` clears the override. `save` accepts `{ action, snapshotRevision, item:{id?,revision?,kind,title,description?,content} }`; an existing item requires its current revision. A save activates and pins manual content; editing a candidate also accepts it. Configuration and save validate snapshot revision under the store lock.

Other actions require `{ action, snapshotRevision, id, revision }` and validate the targeted item revision: `set_state` adds `state:"active"|"disabled"|"rejected"`, `pin` adds `pinned`, `rollback` adds the historical `version`, and `remove` adds no fields.

All successes return the latest GET shape. Conflicting revisions return 409 without overwriting user drafts; invalid fields or capacity return 400; an unknown project returns 404. Existing local Host/Origin/session authentication applies.

Only active formal items enter the current project's optional context/catalog. Automatic promotion requires opt-in, three distinct verified Task sources and host-side evidence checks; it never overwrites manual/pinned content. See [Project experience](en/project-experience.md) for capacities, provenance, scheduling, model usage and the distinction between reviewing saved checks and executing new validation.

## Project ledger

The ledger is the authoritative shared record of what a project needs, its revisions, its effective decisions and the sources it came from. It is stored by the [project data service](configuration-reference.md#项目数据存储); the HTTP shape is identical on SQLite and PostgreSQL.

```text
GET  /api/project-data
GET  /api/projects/:projectId/ledger?q=<text>&status=open|delivered|withdrawn&limit=1..200
GET  /api/projects/:projectId/ledger/:requirementId
POST /api/projects/:projectId/ledger
GET  /api/tasks/:taskId/ledger
POST /api/tasks/:taskId/ledger
```

`GET /api/project-data` returns `{ engine, target, serverVersion, schemaVersion, source }` and carries no credential. Project routes resolve the project through the local catalog; a request cannot choose a storage directory, and a shared project's directory is never used as a local execution directory.

POST bodies carry `action`:

- `query` (`q`, `status`, `limit`) and `get` (`requirementId`) read.
- `create` (`title`, `content`, optional `source` `{ kind: internal|external|legacy, reference? }`, optional `references` `[{ kind: task|session|delivery, value }]`) returns 201 with revision 1. An internal requirement stays ledger-only and creates no board entry.
- `update` (`requirementId`, `expectedRevision`, optional `title`, `content`, `status`, `note`, `taskId`) appends the next revision.
- `decide` (`requirementId`, `expectedRevision`, `text`, optional `effective`, `source`) records a decision at the revision the caller read.
- `set_decision_effective` (`requirementId`, `decisionId`, `expectedRevision`, `effective`) retracts or restores a recorded decision without deleting it.

A requirement returns `projectId`, `requirementId`, `title`, `content`, `source`, `status`, `revision`, timestamps, `decisions` and `references`; reading one requirement also returns every `revisions` entry. A stale `expectedRevision` returns 409 with `code:"revision_conflict"` and `currentRevision`, and never overwrites the newer revision. Unknown requirements return 404; invalid fields return 400.

The Task-scoped routes are the Main tool's boundary: the Dashboard resolves the Task's project from its local catalog, so a tool argument cannot select another project. On the project routes a request carrying `x-cowork-task-id` is refused with 403 `project_scope_denied` unless that Task belongs to the named project.

## Main sessions

A project's persistent Main sessions are shared records, while their Pi transcripts stay local. Each session names one Task as its history container (`<storage>/<taskId>/sessions/main/pi`) and one `backendId` that may run it. A session handles requirements one after another; finishing a requirement ends that Run, not the session.

```text
GET  /api/projects/:projectId/main-sessions
GET  /api/projects/:projectId/main-sessions/:sessionId
POST /api/projects/:projectId/main-sessions
```

A session returns `sessionId`, `projectId`, `title`, `entryKind` (`internal|external`), `kind` (`regular|continuation`), `backendId`, `taskId`, `currentRequirementId`, `currentRequirementTitle`, timestamps, `projectDirectory`, `local`, `activeRunId` and `runs` (`runId`, `requirementId`, `state`). `local` is true only when this backend owns the Task, so a session created on another backend is visible but cannot be continued here. These routes never move or copy a transcript.

POST bodies carry `action`:

- `create` (`title`, optional `entryKind`, `kind`, `requirementId`) creates the Task history container and the session, and makes the requirement current.
- `select_requirement` (`requirementId`, with the session in the path or as `sessionId`) changes the session's current requirement without starting work.

A session's Run uses the existing Task route with the session identity:

```text
POST /api/tasks/:taskId/run   { prompt, mainSessionId, requirementId? }
```

The session must belong to this backend and name that Task; a mismatch is refused before a process starts. The Run is recorded against the session before the process starts, `requirementId` also becomes the session's current requirement, and a settled or cancelled Run updates its state. A conversation that predates sessions is adopted on first list or run, keeping its original Pi history in place.

## Task APIs

```text
GET  /api/tasks
GET  /api/tasks/:taskId
POST /api/tasks
PATCH /api/tasks/:taskId
POST /api/tasks/:taskId/run
POST /api/tasks/:taskId/interject
POST /api/tasks/:taskId/interject/:messageId/steer
POST /api/tasks/:taskId/interject/:messageId/cancel
POST /api/tasks/:taskId/action
GET  /api/tasks/:taskId/stream
GET  /api/tasks/:taskId/agents/:agentId/trajectory
```

Create a Task:

```json
{ "taskId": "optional-id", "goal": "Analyze the repository", "projectId": "project_<uuid>" }
```

Start or continue Main:

```json
{ "prompt": "Read the current task and continue from the last checkpoint" }
```

The response is accepted asynchronously:

```json
{ "taskId": "task-1", "runId": "main-...", "status": "running" }
```

The Runtime owns Task transitions. The UI may request `cancel`, `resume`, or `complete`, but it must render the returned state rather than assuming the action succeeded.

`POST /api/tasks/:taskId/run` with `{ "resume": true }` and no prompt continues the saved Main turn without adding a user message or recovery instruction. It requires a prior run and retains saved tool results. The full accepted input is saved privately as `runs/<runId>/main-input.json` before process launch; an input missing from the Pi transcript after a startup failure is restored once. For a captured failed or interrupted Main request, continuation replays its exact serialized body and original model, ignoring a replacement `model` selection for that retry. The returned `model` identifies the model actually used. A completed request is never selected for replay; a new nonempty prompt invalidates the prior retry slot and uses current settings. Changed project/binding/endpoint returns `409` with `code: "main_retry_context_changed"`; an invalid snapshot returns `400` with `code: "main_retry_snapshot_invalid"`, retaining the saved record and prior Run state. Legacy sessions with no request snapshot retain context-based continuation. An empty prompt without `resume: true` is rejected. Supplying a nonempty prompt remains a new user turn, including with `resume: true`.

`GET /api/tasks/:taskId` exposes optional `retryRequest: { requestId, model }` only for an idle failed/interrupted Main request. It never exposes the private request body. `retryRequestUnavailable: true` reports missing or damaged recovery data for a model failure; the UI preserves drafts and rejects manual retry rather than silently regenerating the request. `POST /api/tasks/:taskId/run` with `{ "resume": true, "retryRequestId": "<request UUID>" }` resends that original serialized request using its original model and protocol; omit `prompt` and new attachments. The service validates the Task/Run/request identity under the startup lock, rejects stale or concurrent retries and completed/cancelled requests, and requires the original service address. Current authentication is resolved normally and is never stored in the recovery record. A later tool-loop request serializes its new results normally. Startup failures that have no model request retain the accepted-input continuation described above. Legacy histories without a raw recovery record can continue their saved context but cannot reconstruct exact unsaved wire bytes.

Exact retries also require the original canonical working directory, Task storage root and structured application ownership (resource ID, application/instance, source root/path and Adapter/MCP tools). A changed directory, binding or source returns `409` with `code: "main_retry_context_changed"` before launch without replacing the archived request or history; restore the original scope to retry. Missing execution ownership on older readable snapshots reports `retryRequestUnavailable: true` and rejects replay with `400` / `main_retry_snapshot_invalid`. Ownership remains protected through the replay response's tool batch; a later model request can discover a new binding. Application dispatch rejects mismatches as non-retryable `execution_scope_changed` (409) without applying operations.

`GET /api/tasks/:taskId` also returns optional `editableMessage: { messageId, versionId, runId, scopeToken, body, attachments }` for the latest accepted composer/Inbox user input present in the active Pi branch. Internal continuation controls, human answers and pending queue notifications are not editable. `editableMessageError` reports an invalid message/attachment reference while retaining readable history. `conversationVersion` identifies the selected branch so renderers discard cached events from a replaced version. `conversationVersions` contains metadata only (`versionId`, source `messageId`, `currentMessageId`, `groupId`, `replacedBy`, `preview`, `createdAt`, `activityCount`), without archived message/event bodies or private session/retry paths. Repeated edits of one user turn retain the same group and point to its newest active message.

`GET /api/tasks/:taskId/message-versions/:versionId` returns `{ messages, runtimeEvents }` for a version belonging to that Task. Version IDs are opaque safe identifiers (legacy Pi Run/session IDs remain supported). Malformed IDs return `400`; unknown or cross-Task IDs return `404`. The conversation UI shows only the current version; this endpoint retains access to archived records.

`POST /api/tasks/:taskId/messages/edit` accepts `{ messageId, versionId, runId, scopeToken, editId, body, attachmentIds, textAttachments?, model? }`. `editId` is a UUID retained for a lost-response retry; `scopeToken` is the SHA-256 scope identity supplied by task detail. The Task/project operation lock validates idle process state, active Run, latest accepted user, version and current canonical project/application ownership. Conflicts return `409 / main_message_edit_conflict`; they never queue the edit into an active run. Empty bodies require at least one attachment. Existing upload IDs are verified against this Task’s original files; new uploads are validated and attached to this Task. Legacy inline text attachments retain the existing 128 KiB / three-file limits.

An accepted edit creates a new Run and an explicit Pi session containing only entries preceding the replaced user input; subsequent runs select that same session. Pending and unanswered human questions created after that input in the replaced Run are cancelled with the old branch, so they cannot block the new request or accept late decisions. Questions outside that tail retain their state; ordinary continuation still requires pending questions to be answered. An explicit project-folder change forks the selected branch into the new canonical working directory and atomically updates the session pointer while preserving its version identity and old transcript. The old session, user input, replies, tool activity and private original retry snapshot remain archived. Editing retires the active exact-retry slot and uses current model settings; it does not replay an old failed request body. Repeating an identical `editId` returns the first Run without spawning another process; changing its body or target is rejected. Startup rejection before acquiring a process restores the prior version, retry state and retired questions. Recovery before launch readiness also restores those questions; recovery after readiness retains their cancellation with the accepted branch. File modifications and external actions are not rolled back or reported as newly executed evidence.

While Main is active, `interject` accepts `{ "message": "Updated instructions", "delivery": "steer" }` (`delivery` is optional; default `steer`, or `followUp` to wait until the current tool/model loop finishes), durably enqueues a human command and returns `202 { taskId, runId, delivered: true }`. The response means accepted for delivery, not already acted on by the model. With no active run it returns 409; use `run` for a new request. A request captures the current Main process before reading its body; if that process ends or changes before serialized acceptance, it returns 409 without enqueuing the message, including when the resumed process reuses the same run ID. The UI defaults to `followUp`. Pending follow-ups stay unclaimed in the durable Inbox until the current work ends. `POST /api/tasks/:taskId/interject/:messageId/steer` sends one original queued message: while running it promotes that message under the Inbox lock; while stopped it resumes the same conversation with the queued text as the initial prompt. The message remains leased until its durable prompt identity is acknowledged, preventing duplicate delivery; failed startup releases the lease for retry. Task start, stop and queue actions are serialized. Repeated sends are idempotent. `POST /api/tasks/:taskId/interject/:messageId/cancel` cancels an unclaimed follow-up (also when stopped), returning `{ taskId, messageId, cancelled: true }`; repeated cancellation succeeds, while a claimed/promoted message returns 409. Cancellation emits `user.message_cancelled`, so refresh does not restore the queue item. Unknown/cancelled messages cannot be sent. Existing queued attachments and unrelated composer drafts are retained. `user.message_promoted` and consumed receipts retain the original message identity. The trajectory endpoint returns the bounded execution trace for Main or a member of the active run; it does not select arbitrary historical runs.

A follow-up in an existing Task continues that Task's Pi session, including after completion; `resume: false` does not clear the conversation. A completed request may start a new run, while its messages and title remain attached to the same Task. Create a new Task to start an independent conversation. The extension initializes an empty goal once and preserves an existing title across subsequent requests and context resets.

`POST /api/tasks` accepts `projectId` to inherit the saved project's directory; an unknown project is rejected. The browser's project `+` opens a draft and sends this field when its first message creates the Task. Creating a Task itself does not launch a model run. The legacy optional `workspaceRoot` form remains compatible with directory-grouped history; it does not create an explicit project.

`POST /api/tasks` also accepts `{ taskId?, goal, projectId:null }` or `{ taskId?, goal, temporary:true }` to allocate an isolated durable managed workspace without a project. Its response includes `projectId:null`, `temporaryWorkspaceRoot`, effective `projectDirectory` and the original `storageRoot`. Optional `temporaryWorkspaceRoot` may reuse an already managed root for an explicitly chosen independent editor's collaboration; arbitrary folders are rejected. Conflicting project/directory fields and invalid booleans are rejected. Legacy omitted-project requests retain historical directory adoption. Temporary records are visible in the task list but never synthesized into projects.

Main's native file and command tools run in the owning project's directory (`projectDirectory` and `workspaceRoot` in Dashboard responses). The launcher loads its own configuration, extension, prompt, and bundled skills by absolute path so another project does not remove Cowork capabilities. Each Main turn receives explicit absolute paths for the project, Task workspace, private drafts, final deliverables, and memory. `browse_workspace` remains rooted in the Task directory rather than the project directory. Task metadata has optional `projectId` and legacy `projectDirectory`; absence preserves directory-based history. Detail exposes `projectId`, `projectName`, `projectDirectory`, and `storageRoot` for the stable task storage root. Application resource roots are independent of this Task storage root. HTTP application APIs, Run startup and Pi resolve the same real Task storage for state, resource references and instance loading relationships, including when an independent editor lives in the project folder. Project folder updates do not move Task storage, artifacts, or bound documents. Pi history is continued across a CWD change by forking its session header into the new CWD, retaining messages and leaving the original session file intact. Historical absolute paths are not rewritten; the current system context explicitly identifies the current directory.

Runtime SSE tails newly appended log bytes every 40 ms; durable Task events retain their 250 ms refresh cadence. The event schema and replay identities are unchanged. The browser batches rendering by animation frame and preserves existing DOM nodes; provider/network pacing still determines when model output becomes available.

For existing Task sessions recorded under the old harness working directory, the launcher copies the full Pi session into the selected project using Pi's session-fork API before continuing. The original session is retained, and later requests reuse the aligned session; this avoids Pi's CWD filter silently starting an empty conversation.

### Delegated work and completion

An async `call_subagent` acceptance is returned only after durable queue registration. Completion callbacks are persisted in Main's Inbox and delivered with Pi steering before the next model inference. Queuing a message is not consumption: its Inbox lease remains pending until the message appears in Main's saved context. Delivery is serialized and deduplicated, including while a slow tool is running; a restored session can acknowledge an already saved callback without sending it again.

Failed delivery releases the lease for recovery and leaves Task state unchanged. Actual `agent_start` marks Main as running; accepting an Inbox message does not reopen a settled Task or take ownership from a newer Run. Background delivery and status notifications tolerate a disposed Main context, so outstanding Subagents can finish and persist their callbacks after a provider failure.

`wait_for_subagents` waits for execution, then returns so Main can receive queued callbacks. `finish_task` is optional completion-summary registration and rejects completion while calls, local dispatch/recovery, callbacks, or human answers remain outstanding. If Main stops before delegated work returns, its session waits and continues with the actual callbacks. A natural final answer completes the request once those dependencies are resolved, including conversations carrying legacy `completion.policy: explicit` metadata. Runtime never injects an instruction to continue solely because `finish_task` was omitted; retired completion-check messages are filtered from model context on subsequent requests while audit history is retained. Process exit without a complete final answer (including tool-budget stops and truncated responses) leaves the Task incomplete.

These checks enforce execution and delivery state. Main remains responsible for inspecting results and deciding whether the user's requested work is complete.

## Task detail shape

`GET /api/tasks/:taskId` returns:

```json
{
  "task": {},
  "coordination": {
    "calls": [],
    "pending": [],
    "callbackPending": []
  },
  "events": [],
  "runtimeEvents": [],
  "artifacts": [],
  "messages": [],
  "statistics": null,
  "humanRequests": [],
  "humanResumePending": false,
  "runtime": { "active": false }
}
```

`coordination.calls` is the structured Agent Office state. A UI should use its `status`, `agentId`, `task`, `response`, and `error` fields to drive the agent card; it should not infer state from animation timers.

Calls, progress entries, delegation results, and callbacks also include `name`, a stable human-readable team name derived from the durable Agent identity. Use `name` on cards, activity records, and result attribution; retain `agentId` and `callId` for API routing.

New delegations atomically reserve distinct private directories, including across completed requests in the same Task.

`messages` contains the conversation's user/assistant messages, including timestamps and the final reply saved when Main settles. `runtimeEvents` contains Main activity from all Task runs in creation order, wrapped as `runtime_event` records. Persisted run logs also restore messages missing from older snapshots. The UI groups thinking and tool activity by the user request that produced it and retains each group's expanded/collapsed state during updates and navigation.

Subagent results, progress, and callbacks may include `outputFiles` (Task-relative paths to private candidate files) and `diagnostics: { tracePath, resultPath }`. These are execution information, separate from the Task's formal `artifacts` list.

Main can inspect candidates through `browse_workspace`, then use `publish_artifact({sourcePath, name?})` to copy an accepted file into the canonical Task `artifacts/` directory. Relative source paths resolve from the selected project. The tool returns indexed metadata and `absolutePath` for final links, and fails for missing or non-file sources or unsafe destination paths. Ordinary writes into `artifacts/` remain discoverable; no recursive scan promotes unrelated drafts or logs.

### Current run statistics

`statistics` is `null` before a run starts. Otherwise it contains `scope: "conversation"`, `taskId`, the current `runId`, `runCount`, `startedAt`, `endedAt`, `elapsedMs`, `timingPartial`, `active`, `observedAt`, aggregate `usage`, and `agents: [{ agentId, callId?, name, current, usage }]`.

The single task panel contains artifacts, the agent team, 会话运行概览, and background processes in that order. Member selection opens a collapsible, bounded execution trace in the same panel; there are no workspace/team tabs.

`elapsedMs` sums Main process intervals across every durable run in the conversation, including tool execution and waits for delegated work. Idle gaps between runs or resumed invocations are excluded. The UI may advance the timer from `observedAt` only while `statistics.active` is true. Completion/failure/waiting events freeze the duration. A historical run without an exit event freezes at its own last recorded activity, never at the current Task's update time. Unknown timing is `null`; `timingPartial` marks a sum with missing run timing. Follow-ups, page reloads and server restarts recover the same cumulative values from disk.

Each `usage` contains `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`, `responses`, `reportedResponses`, `coverage` (`complete`, `partial`, or `unavailable`), and `scanning`.

Pi's input excludes cache, so total input for display is `input + cacheRead + cacheWrite`; `output` already includes reasoning. `totalTokens` sums these four components, recovering older traces whose numeric total was redacted.

Only finalized assistant `message_end` records count: stream updates and repeated turn/session snapshots do not. All recorded attempts across all runs count, including consumption before failure or cancellation. Responses are deduplicated per agent across retries and replayed history.

Agent totals are grouped by their stable identity; historical members remain in the breakdown. Only current members link to the current execution trace, so historical rows cannot accidentally open another member or run. Exact Token counts are displayed without K/M rounding.

Missing/zero-filled provider usage is unavailable, not zero consumption. `totalTokens` is `null` when no response reported usage.

The UI displays accumulated numeric counts without qualifiers or reporting-status notes; missing totals render as `—`. Coverage metadata remains available in the API.

Large legacy traces are scanned incrementally with bounded memory and read budgets; `scanning` marks totals still being collected. Missing, malformed, or oversized records can leave coverage partial. There is no monetary estimate because configured model prices are placeholders.

### Human questions and continuation

`humanRequests` contains durable `askhuman` questions (`requestId`, `taskId`, `runId`, `question`, optional `context` and `options`, `status`, and answer timestamps). Pending questions appear in the composer area, with explicit single-choice options and a free-text field. No option is preselected or submitted automatically. Drafts survive polling, Task navigation and page reload in the same browser tab. Multiple questions are navigable and the paused run resumes once all pending questions are answered.

```text
POST /api/tasks/:taskId/human/:requestId/answer   { "answer": "User's selected or written answer" }
POST /api/tasks/:taskId/human/resume
```

Answer submission returns `{ request, resume: { status, error? } }`. It persists the first answer, enqueues a deterministic `human-answer-<requestId>` Inbox message and resumes Main in the same run/session.

Concurrent submissions and retries cannot replace an accepted answer, re-enqueue a consumed message or launch duplicate Main runs. An answer arriving during `askhuman` shutdown waits for process finalization; startup Inbox messages are appended before the existing Dashboard prompt rather than racing it with a second model turn. Answers to a cancelled Task or a different active run are rejected.

`humanResumePending` indicates a saved but undelivered answer with no active Main process or outstanding question.

The UI then offers 继续运行, including after restart or a failed launch. An error does not discard the answer or local draft.

Normal run/complete actions reject outstanding questions so an ordinary prompt cannot silently bypass them. The CLI's human-answer protocol remains compatible.

## Artifact files and previews

`artifacts` contains only regular files physically present under the selected Task's `artifacts/` directory, discovered automatically and ordered by descending `mtimeMs`. Entries include `relativePath`, `displayName`, `size` (bytes), `mimeType`, `sha256`, and `mtimeMs`.

Application exports additionally carry optional `sourceResource: { resourceId, sha256 }`; the hash identifies the original exported bytes, so external edits invalidate the link. Legacy exports are recognized from their indexed `exports/<resourceId>/<8-hex>-<displayName>` namespace and original indexed hash.

Paths are relative to `artifacts/`, support Unicode and spaces, and retain subdirectories so duplicate basenames remain distinguishable. JSON, logs, and code are valid deliverables when deliberately placed there; the UI must not filter them by extension.

Conversation Markdown resolves absolute local links only against this index under `<storageRoot>/<taskId>/artifacts/`. `workspaceRoot` names the project directory and may differ; it is used only as a compatibility fallback when `storageRoot` is absent. Supported editable files open directly in the declared application; other formats retain the preview/download drawer.

The Runtime keeps indexing metadata in Task `.runtime/artifacts.json`; no model-facing registration tool is required. Private Subagent `deliverables/`, Main `work/`, `sessions/`, and `runs/` are not scanned as final outputs. Legacy workspaces require the explicit migration described in [workspace layout](task-workspace-layout.md); ordinary discovery never promotes candidates.

```text
GET /api/tasks/:taskId/artifact?path=<URL-encoded relative path>
GET /api/tasks/:taskId/artifact?path=<URL-encoded relative path>&raw=1
GET /api/tasks/:taskId/artifact?path=<URL-encoded relative path>&download=1
```

The default response describes the preview:

```json
{
  "path": "reports/brief.md",
  "previewKind": "text",
  "mimeType": "text/markdown",
  "size": 8,
  "content": "# Brief\n",
  "truncated": false,
  "rawUrl": "/api/tasks/task-1/artifact?path=reports%2Fbrief.md&raw=1",
  "downloadUrl": "/api/tasks/task-1/artifact?path=reports%2Fbrief.md&download=1",
  "version": "opaque-file-revision"
}
```

`previewKind` is `text`, `pdf`, `image`, or `download`. Only `text` includes `content`; text preview reads at most 256 KiB, with `truncated: true` when only a prefix is shown. Render PDFs in an iframe and images as images using `rawUrl`. Office documents and other binary files use a download card, never a UTF-8 code editor. Every kind offers open/download actions; copying applies only to text and must identify truncated previews.

`raw=1` serves complete bytes with their MIME type; `download=1` serves the same file as an attachment with a Unicode-compatible filename. Encode the entire path query value, and never resolve it against a different Task or outside `artifacts/`.

Invalidate cached previews when `sha256`, `mtimeMs`, size, or the returned `version` changes, and version media URLs too. Unchanged Task polling should preserve the active preview and reading position.

## SSE stream

`GET /api/tasks/:taskId/stream` returns Server-Sent Events. Each data message is a persisted run event:

```json
{
  "eventId": "event_xxx",
  "type": "main.run_completed",
  "taskId": "task-1",
  "runId": "main-...",
  "agentId": "main",
  "occurredAt": "2026-09-06T12:00:00.000Z",
  "payload": {}
}
```

The client should keep the latest `eventId` and refetch Task detail after receiving an event. The stream is an invalidation channel, not a replacement for the durable Task detail API. A low-frequency refresh is still appropriate after reconnecting.

Main streaming activity uses `type: "runtime_event"`, with the Pi event in `payload` and a stable `eventId` containing the run ID and record index. Detail and SSE use the same IDs; deduplicate by identity rather than payload, since identical deltas can be distinct events. The stream follows the active run selected when connecting, so reconnect when `task.activeRunId` changes. Merge detail refreshes with newer SSE records to avoid dropping in-flight updates.

The durable ledger initially replays its latest 500 complete records, then reads appended byte ranges; an appended burst is not capped at 500. Idle streams check metadata without rereading history. Truncation or file replacement resets the read cursor, with recent event identities suppressing duplicates. Detail tail reads are bounded by the requested record count. Incomplete streaming UTF-8/JSON lines remain buffered until completed.

## External / Virtual Agent events

```text
POST /api/tasks/:taskId/events
```

Example:

```json
{
  "watcherId": "repo-watch",
  "source": "github",
  "type": "pull_request.updated",
  "dedupeKey": "pr-42:head-sha-abc",
  "payload": { "number": 42, "action": "synchronize" },
  "wake": true
}
```

The Runtime writes the observation to the Event Log and Main Inbox. `watcherId + dedupeKey` is idempotent; sending the same observation twice does not create a second Inbox message. By default ingestion does not call the model. With `wake: true`, and only when Main is not already running, the local Runtime Host starts a continuation of the existing Main session and asks it to inspect the Inbox. A production Worker/supervisor will own this wake decision when the Dashboard process is not running.

## Application Workbench APIs

A Shared Resource is live collaboration state that both the user and Main edit through one versioned protocol.

Resources live under `<application-resource-root>/applications/<appType>/`; that root can be a project folder or a resource's existing location. Each Task references them through `<task-storage-root>/<taskId>/applications/mapping.json`, with manifests/loading relationships in the same real Task storage; shared window instances are indexed under the application resource root. These roots need not match. Cross-root references record workspaceRoot; a legacy reference without it resolves from the Task storage root. Active manifests likewise preserve the bound instance's original workspaceRoot.

Multiple conversations can share the same resource without moving or copying it. Ordinary final files remain under `<task>/artifacts/`; the product's deliverables view combines both kinds. Resource saves need no additional publish step. Separating the roots does not move or delete existing resources or Task data; backups include both roots and any external originals. See [workspace layout](task-workspace-layout.md).

New resources created through a conversation inherit its project directory and affiliation. Resource metadata and window instances may carry a `project` snapshot with `projectId`, `projectName`, `projectDirectory` and optional `projectCatalogPath`; `null` explicitly means unassigned and missing fields retain legacy compatibility.

Loading or sharing existing resources never changes their affiliation or physical root. Resolved application tabs expose the physical root in `workspaceRoot` and the affiliation in `project`; the display name follows committed project renames.

Independent windows use the selected directory's existing project record, or remain unassigned when no record exists. The selected conversation never supplies a replacement label for an existing window.

`project` is the authoritative affiliation; resource/tab `projectId` is its compatibility alias. Older records containing only `projectId` resolve by stable catalog identity, retaining their physical roots when another project reuses the folder. An explicit `project: null` takes precedence over a legacy ID or root match. Discovery and tab resolution preserve the original metadata bytes.

Legacy directory groups without retained conversations or valid application content are omitted from the project list. Legacy groups can carry `hasApplications` as presentation evidence. Explicit empty projects remain visible. Filtering preserves the persisted catalog rows and all user data; querying an internal holding Task does not register a project.

### Global workbench and MCP

MCP tool calls allow up to 10 minutes. Startup and tool discovery retain their existing SDK deadlines. Stopping an Agent call or disconnecting its HTTP request propagates cancellation to the MCP request; late results cannot apply resource operations. Progress messages do not extend the total tool deadline. A shared MCP server stays available to its other windows after one request is cancelled.

```text
GET    /api/workbench/temporary-resources
POST   /api/workbench/open-application
POST   /api/workbench/bind-resource
GET    /api/workbench/tabs
GET    /api/workbench/revisions
POST   /api/workbench/tabs
PATCH  /api/workbench/tabs
DELETE /api/workbench/tabs
GET    /api/workbench/mcp/status
GET    /api/workbench/mcp/tools
POST   /api/workbench/mcp/call
```

- `temporary-resources`: lists retained managed documents with `accessTaskId` and physical `workspaceRoot`, including those whose tabs are closed. Reopening uses that explicit holding access context; the list does not create projects or delete data.
- `open-application`: `{ appType, workspaceRoot? }` opens an empty application before a conversation exists; omitting `workspaceRoot` allocates a fresh durable managed temporary root and unique hidden holding Task. Explicit roots retain existing project/shared-workspace behavior; returns the instance, holding Task, MCP status when available and resolved Tab state. A new project-scoped application stores its holding Task in the Dashboard default Task store, independently of its resource root; it creates no new Task/manifest in the project folder. Existing project-local holding Tasks and references remain in place for compatibility.
- `POST /api/tasks/:taskId/resources/:resourceId/save-copy`: `{ revision, format, directory }` or `{ revision, format, projectId }` exports the exact current revision to an existing selected folder/project. The two destinations are mutually exclusive. Returns `{ resource, path }`; `resource.savedCopies` records destination hashes/revisions and optional project provenance. Revision mismatch and externally modified copies return conflicts. First saves reject every existing destination, even identical bytes. Only persisted savedCopies receipts authorize repeat updates at the same path. An interrupted file commit without a receipt remains intact and is not adopted on retry. Previously unassigned resources gain the explicitly selected project affiliation, but their managed root, history, attachments and all conversation references remain intact. Cancellation is a UI action and sends no save request. Closing a tab never deletes temporary data.
- `bind-resource`: `{ taskId, fromTaskId, resourceId }` references and binds an existing resource to the target conversation. Empty-window handoff uses `fromAppInstanceId` with no resourceId. Regular conversation sharing preserves previous references; standalone handoff can close holding windows. Binding a project-scoped editor to a conversation updates the conversation's mapping/manifest in the real Task store; HTTP and Run/Pi discover that same binding. Active-resource roots come from the persisted binding, without moving old references to the latest projectDirectory.
- Tab `GET` reads resolved navigation state and the latest settled MCP status without starting or retrying application servers. A server still starting has no status entry until it settles; polling cannot block on its startup.
- Tab and revision reads share workspace discovery and instance snapshots only within each request. Later requests read fresh state; committed metadata still uses external-file reconciliation and durable recovery. Repeated reads do not rewrite already-present holding references.
- Tab `POST`: `{ kind: "conversation", taskId }`, `{ kind: "application", resourceId }`, or `{ kind: "application", taskId, appInstanceId }` for an empty window. Optional `activate: false` preserves focus; `bindTo` explicitly states the conversation to bind. Opening a resource tab does not grant a new Task reference by itself. Application opens await only the selected window's MCP startup, not other tabs' servers.
- Tab `PATCH`: `{ tabId }` activates a Tab; `{ tabId: null }` clears focus. `DELETE { tabId }` closes it; a document Tab close unbinds all referring conversations without deleting the document/references. Tab responses contain resolved navigation state.
- Resolved conversation tabs and each application tab's `conversations`, `loadedConversations` and `relatedConversations` entries include `storageRoot`, the actual Task data root. Native previews resolve `<storageRoot>/<taskId>` from the acting conversation; the application tab's `workspaceRoot` continues to identify the resource directory. This read-time field does not change the persisted tab format.
- `revisions`: optional repeated `appInstanceId` query parameters restrict the snapshot to those open windows; omitting them retains the complete snapshot. Unknown/closed IDs are omitted. Returns `{ instances: [{ appInstanceId, appType, resourceId?, revision?, contentVersion?, title }] }` for open application tabs. It reads committed metadata without loading document bodies, computing previews or waiting for a native operation. Instances with a pending durable resource transaction are omitted until commit completes. Empty instances are included so creating their first document can update the mounted window.
- MCP `status` returns the latest settled server snapshots without waiting for startups. `tools`: query by `resourceId`, or by `taskId` and `appInstanceId` for a window. `call`: `{ taskId, resourceId, name, params }`; Runtime reads the current resource revision and returns the tool result plus `baseRevision`. Tool discovery and calls revive missing servers on demand and wait for availability, including after a backend restart. A replayed bound call additionally supplies `executionTarget: { resourceId, appType, appInstanceId?, resourceWorkspaceRoot, resourcePath }`; these fields validate the persisted reference's identity and never grant path access. Mismatches return `execution_scope_changed` before the MCP call. Returned operations must still be submitted through the application operation protocol.

These MCP processes belong to the local service/application lifetime, not a single Main Run. They are revived on demand after a backend restart. Native mode supplies its protected API token to owned clients.

### Task resources and instances

```text
GET   /api/applications
GET   /api/tasks/:taskId/resources
POST  /api/tasks/:taskId/resources
GET   /api/tasks/:taskId/resources/:resourceId
PATCH /api/tasks/:taskId/resources/:resourceId
GET   /api/tasks/:taskId/resources/:resourceId/operations
POST  /api/tasks/:taskId/resources/:resourceId/operations
POST  /api/tasks/:taskId/resources/:resourceId/undo
GET   /api/tasks/:taskId/resources/:resourceId/download
POST  /api/tasks/:taskId/resources/:resourceId/preview
POST  /api/tasks/:taskId/resources/:resourceId/commands
GET   /api/tasks/:taskId/resources/:resourceId/attachments/:name
POST  /api/tasks/:taskId/resources/:resourceId/import-native
POST  /api/tasks/:taskId/resources/:resourceId/open
PUT   /api/tasks/:taskId/resources/:resourceId/selection
GET   /api/tasks/:taskId/app-instances
POST  /api/tasks/:taskId/app-instances
POST  /api/tasks/:taskId/app-instances/open
POST  /api/tasks/:taskId/app-instances/unbind
POST  /api/tasks/:taskId/app-instances/:instanceId/resources
PATCH /api/tasks/:taskId/app-instances/:instanceId
GET   /api/tasks/:taskId/active-app-context
```

`GET /api/applications` returns `{ applications: ApplicationDefinition[] }` for every registered application, including compatibility adapters, with supported resource kinds and operation schemas. The optional `catalogVisibility` is `"primary"` or `"compatibility"`; absence means `"primary"`. Default application launchers and the Pi `list_applications` tool omit compatibility entries. The built-in catalog is empty in this branch. Generic MCP adapters can extend the registry; the platform routes by the adapter declaration.

Resource creation accepts `{ kind, title, initialContent?, appType? }`; `{ fromArtifact, appType? }` opens the existing source resource for an unchanged application export (returns `reused: true`), or imports an unrelated artifact as an editable resource. The App first makes this request before reading or converting the file; only `unsupported_resource_kind` triggers browser conversion.

Browser-converted formats additionally send `{ appType, kind, title?, initialContent, artifactSha256 }` with `fromArtifact`; the server validates the declared import format and current source hash before creation, returning `source_file_conflict` when the source has changed.

Imported resources persist optional `importedArtifact: { storageRoot, taskId, relativePath, sha256 }`, where `storageRoot` is the canonical Task storage root. Existing `workspaceRoot` origin fields and symlink aliases are read compatibly. Reopening an unchanged source reuses its imported resource even after live edits or a restart; a changed source hash may create a new copy.

Concurrent imports of the same source are serialized using the Task's `applications/artifact-import.lock`. If creation was interrupted after saving the resource but before adding the conversation reference, retry restores the exact source's reference. Legacy resources without provenance are never merged by title.

Imports retain a temporary `creation.json` journal beside resource metadata until the initial content is committed. Recovery restores that same resource identity when interrupted before metadata or content publication. An independently changed destination is preserved and returns `resource_recovery_required` instead of being overwritten.

Task-detail resource deliverables expose optional `files: [{ relativePath, displayName?, mimeType?, size? }]` for editable imported originals and exports with matching provenance. These files share the resource's single panel row and remain downloadable. Read-only exports such as PDF remain independent preview rows. The full `artifacts` index and original bytes stay available; projection never deletes files or resources.

When a current editable artifact matches an imported resource's source hash, earlier imports of that exact source are grouped under its row as optional `previousVersions: [{ resourceId, name, revision, updatedAt }]`, newest update first. Grouping requires the same canonical storage root, Task, relative path, application and resource kind; equal titles never identify a version. The panel count follows the projected rows. Historical resources remain openable with their edits and revisions, and their matching exports remain in the row's downloadable `files`. If the current artifact is missing or has no matching imported version, all resources remain separate.

Task-detail file deliverables expose optional `sourceResourceId` only when the provenance hash matches and the conversation already references that resource. The App opens this source directly, preserving the current native content, revision, selection and instance rather than converting its export back into a duplicate. Titles and content similarity never identify a source; missing sources and modified exports follow the normal import path.

`PATCH` renames with `{ title }`. Download uses `?format=text` or `?format=markdown`, renders the current resource and returns attachment bytes; it does not write to artifacts. The old export route is removed.

`app-instances/open` accepts `{ appType }` and opens an empty application, not a document. `:instanceId/resources` creates a document inside that window and rekeys its global Tab by resourceId. `app-instances/unbind` detaches the Task's active application context. Instance creation/update remain window-state operations; consumers should not use them to bypass resource reference checks.

Submitting an operation:

Native application routes require the Task's resource reference and dispatch through the owning Adapter:

- `commands`: `{ command, params, baseRevision, operationId }`. Runs the Adapter tool outside the lock, then commits its single operation with CAS. A retry of a committed operationId returns the saved state without rerunning native code.
- `preview`: `{ content, options? }`. Does not create a revision; Adapter validates native pointers and may reject unsaved content.
- `attachments/:name?revision=N`: current revision required; mismatch returns 409. Adapter owns the filename allowlist, MIME type and hash validation.
- `import-native?revision=N&operationId=...`: raw file bytes, maximum 64 MiB. A failed candidate or stale revision leaves the previous scene intact.
- `download?format=...&options=<encoded JSON>`: exports the resource through its registered adapter. HTTP disconnect cancels ongoing operations.

The operation envelope is:

```json
{
  "operationId": "op_client_uuid",
  "appType": "custom-editor",
  "operationType": "text.replace",
  "baseRevision": 8,
  "payload": { "from": 42, "to": 48, "text": "目标用户" }
}
```

`baseRevision` is mandatory and enforced: a mismatch returns `409 revision_conflict` carrying `currentRevision`. There is no last-write-wins. Re-sending the same `operationId` returns the original result without creating a second revision, so a retry after a lost response is safe. Operations may also carry a hash of the text they expect to replace; a correct revision with wrong content is refused with `operation_precondition_failed`.

Undo applies the adapter's inverse as a new revision rather than rewriting history.

These routes return a typed error, while existing APIs keep their old `{ "error": "..." }` shape:

```json
{
  "error": {
    "code": "revision_conflict",
    "message": "资源已被更新，请重新读取后再提交",
    "retryable": true,
    "details": { "expectedRevision": 8, "currentRevision": 9 }
  }
}
```

Codes: `application_not_found` and `resource_not_found` and `instance_not_found` (404), `unsupported_resource_kind` and `invalid_operation` (422), `revision_conflict` and `operation_precondition_failed` (409), `resource_too_large` (413), `resource_recovery_required` (503), `unsafe_path` (400).

Task detail gains an `applications` index — resources, open tabs, the active tab, and per-resource counts of changes Main has not yet read. Its `workspaceRoot` identifies the persisted default document home, separately from top-level `storageRoot` (Task data) and `projectDirectory` (the current project folder). The loading menu includes these permitted homes and existing server-resolved references; unrelated project windows remain excluded. Loaded-conversation markers for a document use its exact source-root reference, including legacy mixed-root bindings. It never carries document content, since detail is polled.

Resource changes ride the existing Task SSE stream as ordinary run events, including `resource.created`, `resource.operation_applied`, `resource.selection_changed`, `application.instance_opened` and `application.instance_updated`. Operation/selection changes are published to all referring Tasks. Payload fields such as `appType`, `resourceId`, `appInstanceId` and `revision` identify what changed; their presence depends on event kind.

The browser checks `/api/workbench/revisions` while application tabs are open and the page is visible, waiting 500 ms after each completed check. Automatic Task/tab reads also pause for hidden pages, and hidden application tabs defer their content checks until visible again. Becoming visible triggers an immediate refresh. Explicit loading, saving, autosaving and flushing remain available, and SSE continues while the page is hidden. Changed revisions go only to affected adapters; hidden adapters defer their latest-content read until visible. This covers standalone editors, idle Tasks, and edits from another conversation or MCP process. Creating a document in an empty window refreshes the tab state. Unsaved local drafts remain in the editor and remote changes enter its existing conflict flow.

Each committed operation can appear before the Run finishes; rapid consecutive commits may coalesce into the latest state. Model tokens and native calculations that have not committed are not document revisions. The retained historical `resource.export_completed` type does not imply a current export endpoint.

Main gets five generic tools: `list_applications`, `list_resources`, `list_resource_changes`, `create_resource` and `apply_resource_operation`. They provide the shared protocol for registered applications.

`list_applications` returns `{ applications: ApplicationDefinition[] }` from the default catalog, unlike the complete HTTP catalog above. It omits definitions marked `catalogVisibility: "compatibility"`; it does not filter resources or the tools of a bound compatibility application. `create_resource` still accepts registered compatibility kinds or an explicit `appType` when needed.

Resource content is read through the bound application's domain tools. Generic platform tools manage resource identity, revisions and changes; they do not interpret text offsets, geometry or spreadsheet ranges. Domain tools are registered through `agentTools()` or an MCP server only while the application is bound. Text tools use unambiguous anchors instead of requiring a model to derive character offsets from a summary.

External adapters may provide domain-specific tools. Ordinary workspace files use the generic file tools.

Injected context includes platform metadata (kind, `size_bytes`, revision and title) and one application-provided `<shape>` line describing the resource structure without positions. A count ("3 个标题", "47 个特征") is safe because it is nothing a model can pass as an argument; an address ("第 3 行", "A1:C5", an offset) is not. `<selection>` may name a position, because that is a place the user chose.

Application tools return operations for the platform to commit through revision CAS, the operation log and undo.

## UI implementation rules

- Never write Task, Event, Inbox, or Artifact files from the Renderer.
- Keep API payloads and UI state separate; the UI may maintain a view model but the Runtime is the source of truth.
- Work logs present named participants, actions, relevant files/results, and local times. Fold tool start/end updates into one entry, skip queue/lease bookkeeping, and allow users to expand a result or jump to the participant's trajectory. Preserve expanded entries during refreshes; filter activity to the current run.
- Treat `queued`, `running`, `waiting`, `succeeded`, `partial`, `failed`, `timed_out`, and `cancelled` as distinct states.
- Display the current request's final answer only when `runtime.active` is false, `task.status` is `completed`, and both `coordination.pending` and `coordination.callbackPending` are empty. Natural completion is sufficient; legacy explicit-policy metadata must not hide a completed answer. The last assistant message must contain a final response rather than a tool call, truncated output, or error. Until then, keep assistant text in the execution history; show an incomplete/waiting state if Main has stopped. Preserve completed replies and activity from earlier user requests during follow-ups.
- One-shot callbacks must be processed before final completion. Later external/watch events may start a continuation; preserve the earlier conversation when they arrive.
- If progress marks a legacy large trace with `traceSampled: true`, label its turn/message counts as sampled rather than totals.
- Use fixture data with the same shapes for offline UI development on macOS.

## 交互与恢复契约

- `PATCH /api/tasks/:taskId` 接受 optional `title`（1–100 字符）、`pinned`、`archived`。原有 goal 与 Task 身份保持不变；旧记录缺省为未置顶、未归档。运行中的任务需先停止才能归档；搜索可重新打开已归档会话并恢复。
- `POST /api/tasks/:taskId/action` 的 cancel 通过 Run 服务终止对应 Pi 进程组、取消未完成委派并等待输出落盘，再返回。其他任务和后续运行不受影响。Detail 的 `runtime.stopping` 为停止中的 optional 标志。
- Web 和桌面共用 `GET /api/model-settings`：返回当前连接状态以及 `activeProfileId`、`visionProfileId`、`profiles`（`id`、`name`、`active`、`vision`、`configured` 和非密钥参数），不返回明文或加密密钥。POST 接受 `baseUrl`、`model`、`apiKey`、`api`、`supportsImages`、`contextWindow`（上下文容量，默认 256000 token，正的安全整数）、推理/输出参数，以及 `profileId`、`profileName`、`activate` 和 `vision`；`profileId: ""` 新建，非空编辑指定组，省略则兼容原单组调用、修改当前组。`activate: true` 保存并启用；首组自动启用。`vision: true` 将图像配置用于 `read_image` 的纯文本模型兜底，保存为 `modelConnections.visionId`；`vision: false` 只在该组当前承担此用途时取消，不切换聊天连接。空密钥只保留指定组原密钥，新组必须提供密钥。测试接口按 `profileId` 查找该组密钥，不修改当前启用项。环境管理的连接和运行中的任务拒绝保存。配置列表使用 `modelConnections.version: 1`，首次写入前保留 `.before-model-profiles` 备份，配置与备份权限为 0600。模型密钥保存在所选执行主机的凭据文件中，保存设置不重启后端。
- `GET /api/models` 新增 `connectionProfileId`，配置切换后前端清除旧服务的会话模型选择；已有会话历史保留，后续请求使用新启用的模型配置。
- 本地附件通过下方 [Local input uploads](#local-input-uploads) 的上传、预览与引用接口读取；现有文本草稿附件的限制不代表上传接口的文件能力。Run prompt 通过 stdin 传给 Pi，服务边界仍拒绝 NUL 和超限消息。
- interject 的 Inbox 投递不变；响应增加 `messageId`，事件保存完整消息用于跨 Run 的对话投影。`steer` 在界面显示为补充指令；`followUp` 排队时显示等待状态，消费后按新请求分组，保留前一请求的最终回复。
- `GET /api/tasks/:taskId/resources/:resourceId/review` 返回最近已保存操作的 `revision`、`baseRevision`、`eventId`、前后文本及摘要；无可还原历史时 `available=false`。可选 Adapter `reviewContent` 提供领域投影。
- undo 可额外携带 `baseRevision` 与 `eventId`，只撤销已审阅的对应操作；资源已改变时返回 revision_conflict。旧调用仍兼容。前后对比为整次操作，尚未提供分块接受和行评论。

## Local input uploads

- `POST /api/uploads?name=<encoded filename>` accepts a raw file body, bounded while streaming to 25 MiB. It returns `{uploadId,name,size,mimeType,kind,sha256,createdAt,relativePath}`. Content signatures and UTF-8 are checked; interrupted or rejected writes are removed.
- `GET /api/uploads/:uploadId` returns original bytes with private/no-store headers. Images display inline; documents/text download with the original Unicode filename.
- `GET /api/uploads/:uploadId/preview?page=1` returns image metadata, a bounded text excerpt, or a rendered PNG PDF page and total page count. Local parsing dependencies are required for PDF/Office.
- `POST /api/tasks/:taskId/run` and `/interject` accept optional `attachmentIds: string[]`, at most 10 IDs / 100 MiB. Original files are validated and copied to Task `inputs/` before the message reaches Main. Prompt metadata references those files; the conversation renderer displays filenames and image thumbnails. Main uses `read_attachment({id,offset?,limit?,page?,render?})` to read them explicitly.

Uploads stay local until an agent reads them during the user's model run. Reading a document sends extracted content to the configured model; image reading sends a vision block only when image input is enabled. Upload IDs are local references under the Dashboard's existing origin and desktop authentication boundary, not a public sharing mechanism.

## 联网搜索设置

`GET /api/web-search-settings` 返回 `{ enabled, provider, authenticated, managedByEnvironment }` 及可能的密钥不可用状态，不返回凭据。`POST /api/web-search-settings` 接收 `{ provider: "exa" | "serper" | "off", exaApiKey?: string, clearExaApiKey?: boolean }`，返回更新后的状态；密钥留空保留原值，显式清除回到匿名。任务运行中或由搜索环境变量管理时拒绝修改。沿用本机 Host/Origin、认证、JSON 大小与错误边界。

桌面和 Web 使用同一接口，搜索密钥保存在所选执行主机；桌面客户端会话凭据由宿主管理。保存不重启后端，新运行/恢复使用新配置。默认与兼容规则见 [联网搜索](configuration.md#联网搜索)。

### Web search settings (English)

`GET /api/web-search-settings` returns `{ enabled, provider, authenticated, managedByEnvironment }` and any secret-unavailable status without credentials. `POST` accepts `{ provider: "exa" | "serper" | "off", exaApiKey?: string, clearExaApiKey?: boolean }` and returns updated status. A blank key retains the existing value; explicit clearing restores anonymous use. Active runs and search environment management reject writes. Existing local authentication, Host/Origin, JSON-size and error boundaries apply.

Desktop and Web use the same interface, and the search key belongs to the selected execution host. Desktop client session credentials are host-managed. Saving does not restart the backend; new or resumed runs use the updated configuration. See [web search](en/configuration.md#web-search).

## Long-term goals

Goal HTTP routes and Pi tools share `GoalManagement`; routes are [goal-routes](../src/dashboard/goal-routes.ts) and [goal-service](../src/dashboard/goal-service.ts). `WatchProgram.goal` is optional, retaining older monitor records. Goal lists project effective legacy pause/completion state rather than treating a stale stored monitoring flag as active intent.

| Endpoint                                                                      | Behavior                                                                                                   |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `GET /api/goals`                                                              | Return `{goals,scheduler}` across registered workspaces.                                                   |
| `POST /api/goals`                                                             | Create a goal, return its detail with HTTP 201; planning is queued, not completed.                         |
| `GET /api/goals/activity?offset=N&unread=1&taskId=...`                        | Return up to 30 notifications with total/unread count; optional Task filter. Offset is an integer 0–10000. |
| `GET /api/tasks/:taskId/goals`                                                | Return that Task's goals and scheduler metadata.                                                           |
| `GET /api/tasks/:taskId/goals/:programId`                                     | Return goal, plan, sources, decision state and recent activity.                                            |
| `POST /api/tasks/:taskId/goals/:programId/control`                            | Apply edit, pause, resume, complete or respond through shared management.                                  |
| `GET /api/tasks/:taskId/goals/:programId/activity?offset=N`                   | Return up to 50 activity entries from a nonnegative integer offset.                                        |
| `POST /api/tasks/:taskId/goals/:programId/notifications/:notificationId/read` | Persist read acknowledgement and return `{ok:true}`.                                                       |

Creation accepts `{sourceTaskId?,requestId,scope?,brief}`. `requestId` (1–200 characters) provides stable creation identity; retries with the same identity reuse the goal, while a conflicting brief returns HTTP 409. `scope` defaults to `background`; `session` requires an active source Task. `brief` contains required `title` and `objective`, optional `completionCriteria`/`preferences`, and `notificationPolicy: "important_only" | "digest" | "all"`. Digest policy requires `{dayOfWeek,hour,minute,timeZone}`; day 0 is Sunday and the timezone must be recognized by `Intl.DateTimeFormat`.

Controls use `action: "edit" | "pause" | "resume" | "complete" | "respond"`. Edit supplies the current `revision` and `brief`; lifecycle actions supply the current `revision`. Revision conflicts return HTTP 409 `revision_conflict` and require rereading. A control may also carry `operationId`: a repeat returns the saved result, which is how a client retries after a lost response even though the revision has moved. Respond supplies a nonempty answer up to 10000 characters and follows the durable HumanRequest → Inbox path. Completing the last independent background goal also stops its Task work; a session goal does not stop unrelated conversation work.

Goal state, reports and notifications are distinct. Repeated concrete results reuse `topicKey`; normal same-priority repeats do not create a second notification, while promotion may. Digests assemble accepted routine records without another model request. Unread state is durable. Goal context is bounded; historical report bodies do not enter every model request.

Cross-conversation model steering uses `manage_goal(action=steer)` with a current revision and queues an instruction without modifying the brief; queue acceptance does not mean completed work and never resumes paused work. See [goal architecture](long-term-goals-architecture.md) and [pause contract](monitoring-pause-contract.md).

## Persistent monitors

The frontend and Pi tools share `WatchManagement`; existing monitor interfaces remain available alongside goals. Task detail includes `monitoring: {monitors,sleep?,scheduler}`. Scheduler health, accepted source status and last probe result are separate facts. Background Tasks remain addressable but are omitted from the ordinary conversation list unless selected or pinned; the goal/monitor page exposes their controls without changing lifecycle state through presentation filters.

| Endpoint                                              | Behavior                                                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `GET /api/monitors`                                   | List sources, owner Tasks, reference templates and scheduler health across registered workspaces. |
| `POST /api/monitors`                                  | Create an independent background monitor.                                                         |
| `GET /api/tasks/:taskId/monitors`                     | Return persisted sources, park record and scheduler health.                                       |
| `POST /api/tasks/:taskId/monitors`                    | Configure/activate a reference template; optional `programId` attaches it to an existing goal.    |
| `GET /api/tasks/:taskId/monitors/:monitorId/events`   | Return up to 30 events from a bounded log tail.                                                   |
| `POST /api/tasks/:taskId/monitors/:monitorId/control` | Apply `pause`, `resume`, `retire` or `configure` controls.                                        |

Creation accepts `task`, `template`, `source`, `config`, `cadenceSeconds`, optional `programId`, `scope`, `eventMode`, daily limits and `expiresAt`. Templates are job-lifecycle, metric-threshold, resource-version, feed-keyword, entity-state and timer; timer may omit its source. Cadence is an integer from 60 seconds to 30 days. Each daily analysis/wake count is an integer 1–1000 and resets on UTC dates. Public HTTP sources cannot contain URL credentials; expiration is a future ISO timestamp. Exact source formats and configuration are in the [template contracts](../.pi/skills/virtual-agent-authoring/templates/README.md).

Creation returns HTTP 201 with `activated=true`, `taskId`, `programId` and `monitorId`; package/probe failure returns 422 with `activated=false`. Failed probes remain draft and never poll. An identical active configuration reuses the accepted instance. Draft/retired sources cannot resume; repair and activate explicitly. A source in a paused managed goal requires explicit goal resume first. Closed Tasks must be reopened before resuming their sources.

Feed-keyword supports `items`, `github-releases`, `github-atom` and `hn-search`. Activation establishes a baseline without reporting old items as new. Responses are bounded to 256 KiB; source windows and outages can limit catch-up. Classification uses captured evidence, one model turn and no business tools. Main performs follow-up actions. Analysis inherits normal Main model/reasoning/turn/token/timeout configuration, with no separate monitoring model budget; daily analysis and wake counts remain independent scheduling limits.

Dashboard owns scheduling over registered workspaces and uses the existing Run service for Main. Analysis keeps separate traces without replacing the active Main Run. Polling, analysis and delivery maintain separate retry state; slow analysis does not block source checks, direct delivery or timed wakes.

The probe atomically saves state/outbox; durable Inbox acceptance precedes outbox acknowledgement. Successful analysis is cached before delivery. Wake reservations avoid charging the same delivery twice. Ordinary background replies park a standing responsibility rather than completing it.

Pause is durable control intent: fully paused background work retains clocks, callbacks, answers and retries without automatic Main startup, source replacement or self-resume. Session goals retain unrelated work. Source acceptance rechecks pause after probing. Explicit resume releases retained work; retirement of a one-shot source is distinct and can still deliver its final event.

Host shutdown/sleep stops checking, and startup resumes accepted state; a macOS source checkout can explicitly install the user-level service described in the [runtime reference](runtime-reference.md#macos-源码监控服务). No OS service is installed by ordinary startup.
