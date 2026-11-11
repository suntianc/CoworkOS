# Monitoring pause contract

A pause is durable control-plane intent. It is not a missing source, a provider failure, or permission for Main to repair monitoring. Silence or a timed-out human question does not grant permission to resume.

[Monitoring control](../src/runtime/monitoring-control.ts) now defines the shared interpretation used by scheduling, Main Inbox delivery, Main startup/abort, registration and the Dashboard. Existing legacy data is recognized without requiring a migration: a legacy program whose remaining sources are paused is effectively paused. Pausing its last active source also persists program pause intent. A draft source cannot cancel that intent.

The enforced boundaries are:

- A fully paused background task neither fires its saved clock nor delivers automatic callbacks, old human-answer events, monitoring results or retry messages to Main. These messages and the saved clock remain durable for explicit resume.
- Session tasks continue unrelated work. A clock explicitly tied to paused monitoring sources is held; an unrelated job callback or session clock still works.
- Main source registration refuses a paused program and refuses creating another background task from fully paused background work. Retrying a paused source identity or package does not create a replacement or claim it is active. Creating a replacement Goal from that background task is blocked as well.
- Source acceptance and pause/resume share a short per-program control lock. Acceptance rechecks current intent after the network probe, including for legacy packages. Pausing during a probe wins; the draft is never accepted as active.
- Guidance messages do not resume monitors. They stay queued until explicit resume. Model cancellation and frontend pause call the same management service.
- A running background Main observes pause through its existing Inbox control poll and aborts; source registration remains protected even before that abort is observed. Model goal-management tools in paused background work cannot resume themselves. A user can resume through the control plane or ask an active ordinary conversation to manage the goal.
- Explicit source resume restores a legacy program and releases retained work without replacing the source or resetting its cursor. A source under a paused managed Goal requires resuming the Goal first.

The final event of a retired one-shot timer remains deliverable: retirement is distinct from intentional pause. One paused source does not suspend another active source in the same program.

Verification covers the original saved-clock incident, pre-fix persisted data, repeated host restarts with zero provider calls while paused, already queued wake/retry/callback events, model tool entrypoints, duplicate registration, concurrent activation probes, session isolation and HTTP resume that launches real Main against a local model fixture. Regression entrypoints are [pause recovery](../test/monitoring-pause.test.js) and the watch-supervisor tests in `test/`; P4.5 removed the goal/monitoring interface and its browser cases. This describes required coverage, not an assertion that the current merge has passed those tests.
