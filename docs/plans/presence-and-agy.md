# Presence, room visibility and Antigravity CLI plan

English | [Chinese translation](../zh-CN/plans/presence-and-agy.md)

Status: implemented locally on 2026-11-12: M1 scoped read-only presence/selection, M2 instance fencing, and M3 native agy turn-based hooks with explicit room migration. Fresh source Claude/agy native nonce checks passed (agy uses last-observed proof), and the final native Claude review found no blocking issues. The owner selected turn-based reception and deferred idle wake after the plugin MCP gate failed. No token-persistence product path remains. All changes are uncommitted; no business/global pins were upgraded and no Alpha 14 package was published.
Date: 2026-11-12.

## Background and fixed constraints

The owner wants (1) Antigravity CLI support, (2) truthful availability after Claude Code/Codex sessions close, and (3) clear behavior when several tasks/threads/rooms share one project directory. agy is installed at 1.5.6; its official updater confirmed latest. The existing implementation is Alpha 13. Three independent read-only Claude Code review rounds preceded a further review and agreement from the native Claude Code session in the project room. The native reviewer confirmed the current metadata field names, but did not run the lifecycle or agy acceptance experiments below.

Keep one TypeScript + Bun CLI, direct SQLite, and exactly two tables per room: members and messages. No server, daemon, model heartbeat, polling bridge, HTTP service, PTY wrapper, process manager, or generic agent runtime. Each participant keeps its native session and existing permissions. Program installation remains once per user; default join never edits project instruction files, hook copies or Git exclude. Project/runtime migration must have an explicit preview and apply. Preserve the native Claude inbound policy; no policy changes are authorized by this discussion.

Membership, room selection, native presence, notification submission, model reception, and task completion are different facts. Preserve the exact native identity, explicit leave, receiver opt-outs, message IDs/history/read cursors, rate limits, pauses and uncertain reservations. Never replay an uncertain notification or switch adapters to retry it. Do not treat peer messages as user approval. Newer host product versions are not rejected solely for being newer; inspect actual capability/protocol compatibility.

## Decisions

### 1. Exiting a native session does not automatically leave rooms

Keep membership and read position for an exact-session resume. A deliberate leave is a separate operation and remains sticky across startup/compact and autoJoin. Report presence separately. Do not delete departed members or repurpose the room read cursor as a liveness timestamp.

### 2. Multiple rooms use the existing per-session selection

A task gets a named room; its implementation/review threads join that room independently. Different tasks use different rooms even in the same directory. Exactly one room is selected for automatic notifications per project/runtime/native session. Do not automatically subscribe a session to every room it once joined.

Different sessions' selections are independent. The same runtime/session in worktrees sharing a Git common directory shares room data and selection; separate clones are isolated. Worktree initialization choices remain separate. Explicit --room on an individual message/read does not change selection. Leave affects only the current room; it is not a leave-all command. Routine natural-language onboarding must name the intended task room instead of assuming all agents belong in default.

Add `selected_room` and `selected_here` to member output, distinguishing joined-but-not-selected from explicit left. `selected_room` is that member's native session's current room name or null; `selected_here` compares it with the room being inspected. A valid explicit left membership always has `selected_here: false`. For generic members both selection fields are null with `reason_code: no_native_selection`.

Observe other sessions' selections without writes or exclusive locks. An unreadable or invalid selection produces null selection fields and a per-member sanitized observation error, without inventing a default selection or failing the entire member list. Keep the normal `joined`/`left` values for valid records; if the same unreadable selection also prevents determining membership, return `membership: null` with that explicit error instead of falsely reporting joined. This partial-reporting rule does not relax fail-closed routing/write validation.

Retain room list's current-room indication. Defer room population/online counters, cross-room subscriptions, unread badges and new room-management concepts. Generic presence is unknown/manual; generic registration is not a verified native identity.

### 3. Presence is a scoped observation, not a durable promise

Add a presence object to members and doctor with state (online/offline/unknown), observed_at, source/scope and a fixed sanitized reason code. Keep existing reception output separate. A current observation timestamp is distinct from a historical event timestamp.

M1 is entirely read-only: use existing saved bindings/native metadata, without adding a presence file or changing the SQLite schema. Do not read or present `SessionState.active` as presence; existing receiver diagnostics remain a separate fact. Never derive presence from membership, recent messages, inherited environment variables alone, installed plugins, queue command availability, queue receipts, old nonce proof, old active flags, or the mere survival of a shared desktop host PID.

For Claude, inspect the target binding's own recorded metadata directory, not the caller's default CLAUDE_CONFIG_DIR. Use a dedicated bounded read-only observer, not receiver(), discoverPeer() or their protocol/credential eligibility checks. A unique exact session/process instance with matching process-start evidence can report online within that observed local scope even if notification reception is disabled or incompatible. A dead/reused recorded process alone proves only that old instance ended; it must not imply no resumed instance exists. A registry-scoped offline conclusion requires a trusted recorded scope, positive process absence evidence, and a complete readable bounded scan with no live replacement match. Missing binding, incomplete/ambiguous/forbidden metadata, process-inspection timeout or failure, or unproven scope returns unknown. If registry completeness/negative inference cannot be implemented safely, M1 conservatively returns unknown instead of offline.

For current Codex, return unknown with reason no_native_lifecycle_signal until a reliable exact-thread signal is actually validated. A shared host process cannot prove thread liveness. Historical lifecycle, if later available, stays labeled last_observed. agy remains unsupported as a native runtime until its capability gate passes. Manual generic identity is available only on the owner's separate explicit request; missing native identity is an error, never automatic fallback.

Read only PID metadata files matching `<metadataDir>/<pid>.json`; explicitly exclude `.key` and other credential files. Do not open or connect to sockets. Host-provided `status` and `statusUpdatedAt` can be shown only as `host_reported` supplementary data; their semantics are unverified and do not decide presence.

An online observation requires the recorded binding and native metadata to match the target session, the native PID to be alive with matching current process-start evidence, and a unique matching session in the inspected directory. Use the recorded metadata's PID namespace only when it is established to be the current local namespace. A remote/container namespace that cannot be mapped reliably, or an unknown namespace, returns unknown. Do not guess the meaning of `pidDomain` values from their names.

A leftover JSON file after a crash or forced termination is not liveness evidence. When only the recorded instance is known to have ended, return `state: unknown`, `reason_code: recorded_instance_ended` unless the complete registry-scoped offline condition is satisfied. An offline result means only that this observed registry contains no live instance of the target session; it never means the conversation cannot be resumed or that no Claude runs elsewhere.

Batch and deduplicate process observations per command with a total time/output budget. Exceeding the overall budget produces unknown with `reason_code: observation_budget_exceeded`. Do not spawn a process or open every room DB for each historical member. Queries create no files, take no exclusive observation locks, rebind no receiver, and send no probes; incomplete snapshots degrade to unknown with an actionable sanitized reason. Controlled read-only fixtures and before/after modification-time/hash snapshots must demonstrate no change to runtime directories, session files, host registries or room databases, including SQLite journal/WAL/SHM sidecars. Read-only database access must not create shared-memory files or checkpoint a WAL. External native-host writes must not be mistaken for observer writes in these tests.

### 4. M1 never changes delivery behavior

The new presence/selection display does not suppress, submit, retry, reserve, unpause, rebind, or verify notifications. Existing send/queue/socket/probe/nonce semantics remain intact, including the legacy pre-exit socket gate. Unknown presence does not suppress existing notifications. Native reception still requires a fresh exact-session/adapter/instance reply to claim verification.

### 5. Lifecycle integration and the late-end race are a separate change

Current endHook writes active=false without comparing native process instances and without a shared lifecycle lock. Per-room SessionState can also diverge across rooms. These are code-observed risks; no reproduction against real host event ordering has been claimed. Until the instance-fenced fix is verified, documentation and doctor must explain that an inactive receiver after resume can result from a late legacy end event; an inactive flag alone does not establish this cause.

First establish actual native startup/resume/compact/end identity, hook trust, environment, parent-process provenance, process-start data and socket/instance availability. End must carry or derive the SAME attested instance as start; a random generation written only by start is insufficient. Compact and duplicate plugin/project starts are idempotent within an instance. Native experiments record the hook parent chain and process-start evidence, and cover `/clear` session changes, same-UUID resume, concurrent same-UUID instance ambiguity, and forced termination without an end event. Record only the metadata needed for identity; exclude credentials and unrelated command arguments.

A transport fix scopes end markers to attested receiver instances and compares against the authoritative current binding under one documented session lock/order used by all relevant start/end/rebind/dispatch writers. A late end from an old instance must not close a newer receiver. Preserve pre-exit gating on the verified path. An unverifiable event may be recorded as an unresolved historical observation in a new project-level runtime/session observation file; it must not be advertised as a race-safe unconditional close of the current binding. If both guarantees cannot be supported by native evidence, report the limitation and defer the full fix instead of silently weakening the gate.

Any shared observation file is namespaced by runtime/session at integration level, not duplicated across rooms. No third DB table. Old pinned binaries/hooks remain unfenced writers, so all participants' relevant pins/hooks must be upgraded before claiming coordinated race protection. This delivery-semantic change receives separate review/tests from M1.

### 6. agy has a native capability gate before schema changes

Implementation update: native 1.5.6 identity/hook tests passed for resume, /clear, concurrent roots and a child. Minimal systemMessage injection, idle API submission and working-turn API processing have fresh native evidence. Compact remains untested rather than blocking the verified narrower scope. The review initially proposed a separate opt-in token-persistence adapter; that prototype was subsequently withdrawn while evaluating credential-free in-session forwarding. The connected native plugin MCP receives no LS auth or conversation context, and App sidecars do not establish CLI-session lifetime. The owner subsequently selected turn-based reception and deferred idle wake; no idle adapter is included. See [the source guide](../antigravity.md).

On the actual upgraded 1.5.6 native CLI, establish:
- exact conversation identity in hooks AND subsequent tool-shell invocations, including resume, compact, /clear, subagents and concurrent conversations; two conversations in the same workspace must provide different correct tool-call identities, and subagents must not join as their parent;
- real host process/instance evidence, multi-workspace routing and ambiguity handling;
- native hook schema/output/timeout behavior;
- active-turn compact notification injection and a fresh correlated reply;
- separately, whether agentapi send-message can reach an already-open idle CLI session. Official Sidecars documentation currently labels this App capability; a wrapper or binary symbol is not proof of CLI support.

Use a thin agy plugin with host-specific manifest/hooks and the same CLI-provided full skills get protocol. Do not copy Claude hook JSON or treat agy Stop as process exit. Do not introduce a generic process wrapper if native idle wake is unavailable. Label proven active-turn injection `turn_based`, with `idle_wake: unverified` in doctor until separately verified; explain the idle-wake limitation. Returning hook JSON or reserving a batch does not prove model consumption. Missing or conflicting native identity must yield E_IDENTITY; never borrow an inherited Claude/Codex identity or guess the most recent conversation.

A real agy runtime requires changing both TypeScript and SQLite runtime constraints. Only after the identity gate passes, define and implement an explicit room migration preview/apply (proposed CLI shape: agentchat migrate [--apply], with existing project/room routing). No read-time/default-install/implicit-join migration. New CLI supports old and new schemas. Preview identifies the single target room, compatibility impact, and versions of all known participating run entries and enabled AgentChat-managed hook references that can access that room. Report unknown versions explicitly; do not run arbitrary hook command text to discover a version. Historical unreferenced cache binaries are not participating entries. The inventory must not claim to discover every old process or manually copied executable.

Apply rejects a known participating pin below the required AgentChat migration version by default. An explicit `--allow-old-pins` choice may override that compatibility block, with the consequence stated: old executables will refuse the new schema with their existing `E_SCHEMA` errors. Prefer upgrading all known participant entries/hooks before applying; never select an override silently. Preview/apply targets one room, with no migrate-all default. Apply uses a consistent backup, migration lock/transaction, FK validation and failure rollback while preserving exactly two tables, original IDs/history/cursors/indexes/immutable triggers/reservations/pauses. Old binaries retain their original E_SCHEMA text; the migration preview and docs explain coordinated upgrades. Existing/new v1 rooms remain usable by Claude/Codex without migration until agy support is explicitly requested.

## Implementation sequence and acceptance

1. M1: additive read-only presence and selected-room visibility; English docs and Chinese translations; no new state/schema or delivery behavior changes.
2. M2: isolated native lifecycle experiments; then a separately reviewed instance-fenced lifecycle/transport fix only where the evidence permits it, with coordinated participant upgrades.
3. M3: agy native identity/hook/wake experiment; then thin plugin/native runtime and explicit room migration. Idle wake remains a separately verified capability.

Required isolated tests cover read-only mounts and stable modification-time/hash snapshots; credential-file exclusion and no socket connection; nonlocal/unknown PID namespaces; overall observation budgets; per-member selection read failure without false membership; custom target registry directories; exact live instance; replacement instance; PID reuse; missing/incomplete/ambiguous metadata; process-inspection errors; no query writes; Codex/generic unknown; unchanged notification outcomes; two sessions and two rooms; same-session shared worktrees vs distinct clones; explicit leave/resume; opt-outs and uncertain pauses. Later changes add late-old-end, duplicate start/compact, native identity conflicts, migration rollback/data preservation, and actual old pinned binary compatibility. A failed/interrupted migration must leave the original schema usable for both reads and writes by the old binary.

Run bun run check, appropriate isolated tests, and bun run build for implementation changes. Native model checks are separate authorized exercises with fresh nonces, recorded versions and exact-session evidence; mocks do not validate reception. No native test is claimed passed by this plan.

## Scope of the agreement

The native reviewer reported no blocking design objection and agreed with the amendments above. The owner subsequently requested implementation. External publication has not been requested for this change. Actual lifecycle and agy compatibility remain acceptance gates, not claims established by the design review.
