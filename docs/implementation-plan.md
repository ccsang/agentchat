# Implementation and acceptance

English | [Chinese translation](zh-CN/implementation-plan.md)

Use the current self-onboarding design. Historical milestones below record completed work; Channel and timed hooks are retired and must not be restored as setup instructions. Native model tests remain separate from synthetic/unit/package checks.

## Alpha 10: restore joined sessions independently of auto-join

- [x] Restore the selected room's existing exact runtime/UUID membership with autoJoin off; create no room or member in that mode.
- [x] Preserve member/name/cursor/room, explicit disablement, uninstall/worktree/subagent boundaries, uncertain pauses, budgets, reservations and receiver-proof isolation.
- [x] Reuse native process/version checks for rebind; SessionStart sends no notification or replay.
- [x] Distinguish existing/created membership in startup context and document new-session enrollment separately.
- [x] Regress default/named-room resume, changed receiver, same-name new UUID, nonselected rooms, opt-outs/uninstall, wrong process, unsupported versions and uninitialized worktrees.
- [x] Exercise compiled plugin hooks with a synthetic peer, autoJoin off and no external Bun/Node on PATH.

## Alpha 9: missing Claude hook environment files

- [x] Integrate 986b3c3 without modifying unrelated main-workspace changes or the original fix branch.
- [x] Resolve only the existing parent of an absolute host environment path; create/open the leaf without following links and validate its descriptor/owner.
- [x] Preserve content/newline boundaries and repeated-call identity idempotency; always close descriptors and refuse missing parents/non-regular targets.
- [x] Cover startup/resume/compact with missing files, link rejection, nonblocking non-regular targets and explicit old bundle/managed-hook upgrade.
- [x] Extend standalone verification with isolated compact input; keep this separate from real native-host reception.
- [x] Update English documentation and Chinese translations with the per-project upgrade requirement.

## Alpha 8: Claude inbound setup and English documentation

- [x] Add project/identity-independent user-level `claude-inbound` inspection and explicit preview/apply for accept, hold, refuse and default.
- [x] Back up existing settings, preserve unrelated values/modes, reject unsafe/malformed configuration, keep repeated application idempotent and reject stale in-memory plans.
- [x] Display the configured policy at Claude startup in initialized workspaces. Preserve later hold/refuse choices; keep unrelated projects silent.
- [x] Distinguish the configured user value, effective native policy and model-processing evidence in doctor, startup output and onboarding.
- [x] Document assisted setup before startup, per-launch/UI alternatives, setting scope/precedence, reversal and old held messages.
- [x] Make primary documents and generated instruction blocks English; retain Chinese translations under docs/zh-CN.
- [x] Extend standalone verification to inbound setup, startup output and English instruction blocks; require all four native targets before publication.

## Alpha 7: compact notifications

- [x] Share a three-line notice across Codex and Claude: provenance, message IDs and exact read argv.
- [x] Remove Base64 routing, duplicate fields, links and repeated full rules.
- [x] Support new/legacy notification discovery and reuse rules by actual executable/version.
- [x] Cover full batches, no business body in notices, special-character paths and late named-room reads/replies/contiguous marks from another cwd after switching rooms.
- [x] Verify the compiled executable with a fake queue and no external Bun/Node.

## Alpha 6: concurrent SQLite sidecar inspection

- [x] Preserve Alpha 5's failed tag and do not publish its packages.
- [x] Reproduce a journal disappearing between exists/lstat and a dangling sidecar link being skipped.
- [x] Tolerate only normal missing-file races, preserve permission/link rejection and include failed worker stderr.
- [x] Deliver Alpha 5 functionality plus the fix in a new prerelease, with 127 local tests and standalone verification.

## Alpha 5: plugin lifecycle hooks and Channel retirement

- [x] Claude declares short SessionStart/SessionEnd hooks; a sh wrapper locates the CLI and forwards native stdin. Codex does not load these hooks.
- [x] Persist only native identity in the host-private environment. Auto-enroll only initialized workspaces with autoJoin enabled, never unrelated projects/worktrees or subagents.
- [x] Bind the exact supported socket on join, preserve disablement and require authoritative new-process SessionStart or explicit rebind after replacement.
- [x] SessionEnd stops new notifications to the exact session; preserve history.
- [x] Remove Channel/MCP/handshake/launcher runtime. Old commands return E_RETIRED; retire owned private launchers only.
- [x] Migrate setupVersion 4 without resetting cursors, reservations or unknown pauses, or touching default business project files.
- [x] Update thin skill, protocol and docs; project-local hooks remain an explicit compatibility option.
- [x] Validate with isolated peers/wrappers/standalone binaries, without notifying real models or repeating idle tests.

## Earlier release milestones

| Milestone | Completed behavior and acceptance |
| --- | --- |
| Alpha 4 | Shared thin skill, host/portable manifests, compiled skills list/get/JSON, exact executable/version/hash checks, 139 local tests and isolated host plugin installs. |
| Alpha 3 | Runtime-only join/room use/install; separate preview/apply/removal for instruction blocks and project hooks; worktree-specific integration choices; 135 local tests. |
| Alpha 2 | One global program, self-initializing projects and per-session named rooms. Preserve default DB, cross-room pauses and exact-room proofs; 126 local tests. |
| Alpha 1 | Standalone runtime packages, fixed-version HTTPS installer, checksums, cache and four-platform release workflow; 108 local tests. |
| Initial core | Native identity discovery, two SQLite tables, four commands, deterministic install, exact-session hooks/Codex queue evidence and bidirectional loop. |

## Native socket acceptance: completed for the recorded original session

- [x] Inspect 2.1.312 metadata, owner permissions, peer credentials and NDJSON without changing gateway, authentication or inbound policy.
- [x] Require exact UUID/project/process-start/socket instance, ambiguity rejection and version lock.
- [x] Separate submission from processing; no reservation before a connection failure, and no replay/fallback after an unknown write.
- [x] Receive a fresh nonce from the original socket instance and complete a new Codex ↔ Claude round trip.
- [x] Pass a real 10-minute idle test without human renewal.
- [x] After that completes, independently pass a real one-hour idle test in the original session.

See [verification.md](verification.md) for versions, nonces, durations and boundaries. These results do not validate a new instance or the retired Channel path.

## Historical Channel milestone: blocked, then retired

The Channel implementation included exact startup binding, leases, rolling limits, busy backoff and unknown-submission pauses. Its 82 synthetic tests passed, but the actual host reported **Configured but not active (not currently available)**. No correct native nonce returned; real Channel 10-minute/one-hour tests never started. The user chose the separately tested socket path, and Alpha 5 removed Channel runtime.

## Development gates

### Gate 0: native host entry

Discover identity in the actual Codex/Claude tool environment, not only a user terminal. Inspect exact queue/socket support and host inbound policy. Real probes require the user's integration-test scope and fresh correlated replies. Files, registrations, successful writes and synthetic peers do not complete this gate.

### Gate 1: communication core

Verify SQLite constraints, concurrent appends, UTF-8 limits, foreign keys, stable-ID conflicts, pagination, explicit contiguous marks, wrong-directory behavior and worktree/clone boundaries. Keep transactions short and external calls outside them.

### Gate 2: deterministic onboarding

Discover the project/native session without guessing. Default join writes local runtime state only. Explicit integrations and user-level settings have scoped previews, backups, idempotency, preserved content and conflict checks. State accurately when automatic reception is not verified.

### Gate 3: thin notification adapters

Check exact native endpoints, reserve short batches and submit outside transactions. Cover process death, acceptance with lost reply, simultaneous senders, replaced receivers, persistent limits and unknown pauses. Never turn an ambiguous attempt into another send.

### Gate 4: real collaboration

Begin with natural-language joining; avoid user-carried IDs/paths and replacement clients. Test both directions, exact-session/project separation and persistence across restarts. A useful trial has one agent modify a specific commit and another perform a read-only review, with actual test results and correlated replies.

## Checks for code changes

Run `bun run check`, appropriate tests and `bun run build`. Standalone/release changes also require native package verification. Broaden checks when a new failure or unresolved concern warrants it. Real model tests and idle publishers are explicit separate commands, never ordinary unit tests.
