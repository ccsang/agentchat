# Verification records

English | [Chinese translation](zh-CN/verification.md)

Development environment: macOS arm64, Bun 1.3.14. Dates and results below belong to their recorded revision. Synthetic/unit/package checks do not verify delivery to a real model, and a later release never inherits native proof for another session or instance.

## Alpha 10: restore existing Claude sessions (2026-10-31)

The reported configuration retained its named-room member and cursor but SessionEnd had marked that room inactive. SessionStart reactivated only the base session file while autoJoin false skipped the named room and stale socket. An isolated fixture reproduced the same state; no actual user state was changed for that diagnosis.

SessionStart now looks up the selected room's exact existing runtime/UUID independently of new-session enrollment. With autoJoin false it uses an existing room read-only and never calls join or creates a database/member. It reuses native binding checks, preserves explicit opt-outs/uninstall, and reports existing/created membership. Explicit socket-config --apply validates the exact live peer before reactivating an existing ended room; rejected validation leaves it inactive. Targeted checks cover default/named rooms, unchanged identity/cursor, unselected-room inactivity, stale receivers/old proof, preserved budgets/reservations/pauses, unknown UUID/name collisions, wrong-process/version refusal and uninitialized worktrees.

147 local tests, type checking, source build and macOS arm64 standalone checks passed. The compiled executable exercised resume and explicit repair through a synthetic native peer with no external Bun/Node on PATH and no peer connections. All 38 English/Chinese documents passed navigation/anchor/language checks. Four-platform and public-upgrade checks gate and follow release publication. These tests do not establish reception by a new native model instance.

## Alpha 9: missing Claude hook environment files (2026-10-31)

Integrated the user-provided 986b3c3 patch on an isolated release branch. It resolves only the existing parent of an absolute CLAUDE_ENV_FILE and opens the leaf with O_RDWR/O_APPEND/O_CREAT/O_NOFOLLOW/O_NONBLOCK, creates new files at 0600, validates the opened file/owner, preserves content and repeated-call identity idempotency, and closes descriptors in finally. It never creates a missing parent or initializes unrelated projects.

Regression coverage includes startup/resume/compact missing-file inputs, existing content/newlines, repeat calls, live/dangling links, relative paths, directory/FIFO rejection and explicit replacement of an old project bundle/owned hook command while preserving user hooks/settings. Standalone verification uses isolated synthetic compact input; this does not establish real native compaction or model-delivery evidence. The plugin wrapper/skill remain Alpha 8 because the fix ships in the CLI. 141 local tests, type checking, source build and macOS arm64 standalone checks passed. The compiled executable verified both plugin and managed-hook missing-file creation/idempotency, with no external Bun/Node on PATH. All 36 English/Chinese documents passed navigation/anchor/language checks. Four-platform and public-upgrade checks gate and follow release publication.

## Alpha 8: Claude inbound setup and English docs (2026-10-30)

Added user-level inbound inspection/preview/apply outside project/native-identity discovery, with accept/hold/refuse/default, exact prior-byte backups, preserved unrelated settings and modes, idempotency, malformed/link/permission rejection and stale-plan conflict checks. The command reports only the affected policy and file hashes, not unrelated settings. Default install/join still does not change user-level policy or business files.

In initialized workspaces, Claude SessionStart displays the configured user policy and passes it to the model context. Existing hold/refuse is preserved, unrelated projects remain silent, and effective native policy remains explicitly unverified. Doctor reports the user value separately from receiver/model proof. Onboarding describes assisted setup before startup, UI/per-launch alternatives, scope/precedence, reversal and old held messages.

Primary project documents, historical release notes and generated instruction blocks are English. Chinese translations remain under docs/zh-CN. CLI, plugin, project pin and native host retain separate update/verification boundaries.

137 local tests, type checking, source build and macOS arm64 standalone verification passed. The compiled binary ran with no external Bun/Node and verified read-only preview, exact backup, preserved settings, idempotency/reversal, startup policy output and generated English instructions. All 34 English/Chinese documents passed relative-link, anchor and primary-language checks; plugin manifest/skill validation passed. Four-platform and public-install results are recorded by the release workflow and subsequent checks. No real peer notification or model probe is part of this revision's ordinary verification.

## Alpha 7: compact notifications (2026-10-29)

Notifications became three lines: provenance, message IDs and exact Read argv. Removed Base64 routing, duplicate fields, links and repeated full rules. The thin skill accepts new Read argv and legacy Tool argv; full instructions are reused for the same actual executable/version and reloaded only when missing or changed.

129 local tests, type checking, source build and standalone verification passed. Coverage includes a full 20-ID batch, no business body in notifications, exact arguments for paths with spaces/apostrophes/dollar signs, and late review-room reads/replies/contiguous marks from another cwd after switching to default. The compiled executable captured/executed its actual notice through a fake queue with no external Bun/Node on PATH.

For the same sample paths/IDs, one notice fell from 1326 to 242 bytes (about 82%); a 20-message batch fell from 2124 to 1040 bytes (about 51%). These are byte comparisons, not token or throughput measurements. Four native platforms and public upgrade/plugin installs subsequently passed release verification. No new real-model reception claim was made.

## Alpha 6: concurrent SQLite opening (2026-10-29)

Alpha 5's PR/main checks passed, but its tagged Linux arm64 concurrent-writer test had one failed child and publication was skipped. The old test did not print child stderr, so that historical failure's precise exception could not be confirmed. The failed tag was retained rather than retried into publication or replaced.

A deterministic regression reproduced journal removal between existsSync and lstat, and a dangling-sidecar link being skipped. The fix inspects directly and tolerates only ENOENT; permission failures and both live/dangling links remain rejected. Concurrent tests now print child stderr. 127 local tests, type checking, build and standalone checks passed; the release delivered Alpha 5 functionality plus this fix after four-platform checks and public installation verification.

## Alpha 5: plugin hooks and Channel retirement (2026-10-29)

Removed Channel/MCP SDK/startup handshakes/dedicated recovery; join attempts exact supported native socket binding and Codex retains queue. 125 local tests, type checking, source and standalone builds passed. Added cases for no join-time notification/reservation, version refusal with manual access, disablement before/after bind and across rooms, authoritative new-process rebind, no inherited nonce/reset reservations, immediate SessionEnd inactivation, preserved old Channel unknown pauses and owned-launcher retirement.

Plugin tests cover host-private identity only for unrelated projects, autoJoin opt-in/default off/disable/uninstall, native cwd, subagents, --agent named primaries and special-character paths. Standalone sh wrappers work without external Bun/Node and do not load project dotenv/preload. Default joins preserve committed or malformed project files and Git exclude.

Isolated Claude Code 2.1.312 and Codex CLI 0.165.0-alpha.1.2 installed the local marketplace/plugin; cached thin skill matched source. Claude's declared hook/scripts were present and executable; Codex declared none, and no default hooks/hooks.json existed. Strict manifest and skill validation passed; an optional missing icon finding did not block local installation. The [official hook input](https://code.claude.com/docs/en/hooks#common-input-fields) uses agent_id for subagents; agent_type alone may describe a primary launched with --agent.

These package/hook/synthetic-peer results did not notify real sessions or repeat idle tests. The tagged build subsequently failed as recorded above; Alpha 6 published the functionality and fix. Historical real socket proof remains limited to the original combination below.

## Alpha 4: plugin and embedded instructions (2026-10-29)

139 local tests passed. Skills list/get/JSON read the actual compiled executable's protocol without project discovery, native identity or network. Cases include nonexistent project paths, unavailable Git, conflicting identity, exact Markdown/JSON equality, version/content hash, invalid arguments and a private JS bundle with no separate Markdown dependency. Both marketplaces reference the same skill and consistent manifests.

Standalone checks compared moved/pinned entries. Isolated Claude Code 2.1.312 and Codex CLI 0.165.0-alpha.1.2 installed the marketplace/plugin and their cached skill matched source. Manifest/frontmatter validation passed. Four-platform/public checks are release evidence, not model-trigger or automatic-reception proof.

## Alpha 3: runtime-only join (2026-10-29)

135 local tests, type checking, build and standalone verification passed. Committed instructions and malformed hook files remained unchanged/clean across first/repeated join, creation and room switching; Git exclude bytes were preserved. Tests also covered linked instruction files, malformed blocks, separate integration enable/removal, stale plans, preserved old integrations and independent worktree choices.

Synthetic identities/peers and public downloads in two fresh Git projects checked the new default. These did not notify real hosts or redo idle tests. Historical native proof remained scoped to its original default room and process.

## Alpha 2: global program and named rooms (2026-10-29)

126 local tests passed. Coverage included initial/concurrent joins, workspace reuse, per-native-session selection, same message IDs in different rooms, explicit routing without selection changes, no reservations for unselected rooms, path/link rejection, historical Channel hot-switch, old-client upgrade refusal, cross-room unknown pauses and room-specific socket proofs.

Standalone/native-runner checks covered global installation/command protection, first/subsequent joins, no room-time reinstall, messaging and removal. Channel used in-memory MCP and socket used an isolated peer, not new real-model acceptance.

## Alpha 1: standalone distribution (2026-10-29)

108 local tests passed. Added fixed-version HTTPS packages, compressed/extracted SHA-256 checks, cache and four-platform release workflow. Cases included corruption/interruption, invalid manifests, cache reuse, escaping and older metadata. A fresh standalone project with no development runtime verified preview/install/idempotency, hooks/launchers, SQLite messaging/mark and removal with history. Project dotenv/preload were not loaded. Tests used synthetic sessions.

## Native socket experiment: historical dev.2 evidence

The user explicitly chose the experiment after Channel was unavailable, retaining gateway/authentication. At this revision, 100 automated tests, type checking and build passed (bundle about 0.65 MB). Isolated fake peers/keys and real temporary sockets covered exact selection, directed routing, ambiguous UUID claims, project/process-start/inode/permission/link/version checks, pre-submit failure, unknown pauses, proof isolation and removal. Passive idle verification rejected changed receivers; no real client was part of those automated checks.

### Original-session nonce: passed

Original interactive Claude Code 2.1.312 / peerProtocol 1 on macOS arm64. Exact registered UUID, project, process start, socket ownership and instance were verified. Only peer credentials were used: no childToken, sender permission-class assertion or change to crossSessionInbound/tool permissions.

Probe `probe-14206641-20f3-4017-b798-4ef6fb2e8d16`, nonce `350d95bd-08fd-4a97-b521-6e7652e977bb`, request/reply sequences 11/12. Claude read and replied from its own native socket context; the CLI recorded current_socket proof tied to that instance.

Bun's socket realpath limitation was handled by lstat plus canonical parent resolution. The observed 2.1.312 key filename hashes the published original path, not necessarily its /private/tmp alias; a third-party protocol description was not treated as a stable guarantee.

### New bidirectional loop: passed

Nonce `28355c6b-a4ca-48b2-aed1-cf373dc1a60f`, sequences 13–17:

1. Original Codex notified original Claude through the socket; Claude returned claude-ack and a separate reverse request.
2. During its active turn, original Codex read the contiguous shared stream and returned codex-ack using its native identity, notifying Claude through the socket.
3. Claude returned final done without notify.
4. All five passive correlation checks passed; both agents explicitly marked pages actually read.

Claude-to-Codex notices retained queue. Active-turn manual consumption was not counted as another independent queue wakeup. Late queue notices were deduplicated rather than executing the request again.

### Real idle acceptance: 10 minutes and one hour passed

| Check | 10 minutes | One hour, timed after the first test finished |
| --- | --- | --- |
| Nonce | 31554ca1-5b1b-4223-ac72-11ae6082adf5 | 85f0d9f1-ed07-4748-a2d0-6a0ce5961f93 |
| Actual wall-clock idle | 600.060 s | 3600.056 s |
| Request / result sequence | 18 / 19 | 20 / 21 |
| Reply latency | 19.820 s | 16.182 s |

Each publisher continuously checked unchanged native idle state/update timestamp and the same socket instance, with no Claude project message during the wait. It sent one request at the deadline and exited. Claude read/replied in the original session; its result notified original Codex through queue. Codex read/marked through 21 without a further notification.

All five checks passed for both tests: publisher completion, actual duration, unchanged receiver, exact request and exact reply. No human renewal, fake business message, accelerated clock or model heartbeat was used. These results cover only the recorded original host/session/instance and do not enable the retired Channel.

## Historical Channel dev.1: real reception blocked

82 synthetic tests covered default one-way Channel, lifecycle registration, exact launcher handshake, current-instance nonce validation, rolling limits, busy backoff, unknown pauses and host-unavailable diagnosis. Cases included MCP-before-SessionStart, simultaneous exact sessions, duplicate receivers, wrong/copied launch contexts, process death/SIGKILL, old proof isolation, preserved hooks and offline configuration. Accelerated 10-minute/hour clocks tested logic only.

The user restored the original Claude Code 2.1.312 session through the generated launcher. UUID binding, MCP initialization and sustained receiver process were observed with the expected launch flags. One probe was submitted: `probe-776ce768-a1d6-4060-8ae5-0e989a663dd3`, nonce `9eb5c61a-8a1a-44d0-9879-89e59eefbc09`. No native read/reply returned. It was not resent with another ID and reservations were not cleared.

The original /status reported **Channels: Configured but not active (not currently available): server:agentchat**. It also showed a custom local Anthropic endpoint/token and unavailable remote managed/organization settings. This does not establish the gateway as the sole cause or a definite administrator refusal; it does establish that MCP connected was not push reception.

The tool recorded that observed launch as blocked, retained messages and stopped further notifications without changing gateway, authentication, policy or approval. The nonce failed; real Channel idle tests never started. Socket success is separate evidence, and Alpha 5 later retired this path.

## Historical initial hooks and native loop

60 automated tests, type checking and build passed. Isolated fake host executables covered storage constraints, concurrent appends, idempotency, UTF-8, pagination/mark, worktree/clone boundaries, notification budgets/unknowns, hook singleton/timeout and backup/rollback/removal. SDK stdio tests did not validate a real Channel account.

| Host | Historical evidence |
| --- | --- |
| Codex 0.165.0-alpha.1.2, Desktop bundled CLI | Exact host CODEX_THREAD_ID, matching queue receipt, subsequent original-session consumption and native nonce reply; first response timestamp recorded. |
| Claude Code 2.1.312 interactive CLI | Own-context enrollment, Stop asyncRewake queueing, then exact nonce read/reply after leaving the /hooks menu. |
| Claude Channel | Synthetic SDK only at this milestone; actual failure recorded above. |
| Linux / Windows / IDE / remote app-server | No real native-host acceptance; package/OS interfaces are not model-reception proof. |

Claude hook nonce: `a9669a92-b6af-401c-962e-0adb3e8c7442`. Codex nonce: `09fc915b-b2c7-4268-882c-0c5c64e80ab7`. A long implementation turn left the first queued probe waiting more than 30 minutes, exposing an incorrect proof/notification-TTL coupling. The fix retained exact message/session/nonce validation without expiring valid queued proof or refreshing old evidence on repeats.

An Intel Git on the local PATH sometimes timed out under Bun while native system Git worked. Failure no longer silently selected a non-Git room; regression coverage was added and the accidental temporary room archived, preserving the original database.

The original hook-based full loop used nonce `ba6ab49f-24ba-47ca-8713-397fc44636e4`, sequences 4, 5, 6, 8, 9. Original Codex request → Claude hook wake/read/claude-ack and reverse request → Codex queue consumption after ending the turn/codex-ack → Claude done without notify. All five passive correlation checks passed with actual native identities, random value and reply relationships. Later duplicate notices did not repeat work.
