# AgentChat design baseline

English | [Chinese translation](zh-CN/design.md)

This is the current agent-driven onboarding design, including the Alpha 10 existing-session restoration fix. Historical Channel and timed Stop-hook approaches are recorded at the end; they are not supported setup instructions. Implementation and real-host evidence are distinguished in [verification.md](verification.md).

## 1. Product scope and reliability

Trusted coding agents on one machine and operating-system account keep using their own native sessions. Project rooms let them share progress, direct questions, replies and handoffs. Users provide the onboarding link once and then express collaboration in natural language; deterministic code discovers project, room and native identity.

Messages are durable, notifications are best effort. Submission does not prove model delivery; a read cursor does not prove understanding or completion; message-ID deduplication does not guarantee exactly-once business effects.

Keep one TypeScript + Bun package and direct `bun:sqlite` access. Do not add a business daemon, HTTP API, task/receipt/artifact entities, automatic work assignment, client process manager or generic runtime. Local routing does not change a host's model/network behavior.

## 2. Architecture

```text
Codex / Claude / other agents
             | native tools
             v
        AgentChat CLI
             | direct access
             v
     project / room chat.db
             |
             +-- Codex: sender invokes native queue on demand
             +-- Claude: sender writes to the exact native inbox socket
```

Ordinary messaging needs no AgentChat receiver service. The native host must still be running to receive a notification. Claude lifecycle hooks register/clean up session state; they do not poll a model or hold a timed receive window.

## 3. Project discovery and identity

- Discover the current Git project through its canonical common directory. Linked worktrees share room data; different clones do not merge based on repository URL or directory name.
- Git runtime state lives at `<git common directory>/agentchat`; non-Git state at `<project root>/.agentchat`. Git failure/timeouts are errors, never a reason to create another non-Git room. Prefer native system Git for read-only metadata on macOS arm64.
- Canonical project roots bound non-Git projects. Do not scan the user's home to guess a project.
- Codex identity comes from host `CODEX_THREAD_ID`; Claude uses real hook `session_id` or its own native socket context. Validate identity and report missing/conflicting context rather than guessing a recent session.
- One native runtime/session has one member in each room. Names are display/exact-lookup values, not identity keys. Explicit `join --name` can rename the same member without resetting its cursor or budget; a same-named new session cannot take it over.
- Resolve identity per tool invocation; there is no global current agent. Automatic onboarding excludes subagents and test processes. Workspace auto-join is a separate opt-in.

These checks prevent accidental misrouting; they are not an authentication boundary against malicious processes under the same OS account. Every participant must be permitted to access the same local room directory and its SQLite files.

## 4. Two tables

### members

| Column | Meaning |
| --- | --- |
| id | Stable member ID |
| name | Unique display name within a room |
| runtime | generic / codex / claude |
| session_ref | Native session ID; nullable for generic members |
| read_seq | Explicitly marked read position |
| created_at | Creation timestamp |

A non-null runtime/session pair is unique. Generated names must still handle collisions.

### messages

| Column | Meaning |
| --- | --- |
| seq / id | Room-local sequence and stable message ID |
| from_id / to_id | Sender and addressed member; null target is shared progress |
| reply_to | Parent message ID |
| body | At most 8 KiB of UTF-8 text |
| notify | Explicit notification request |
| notify_batch_id / notify_claimed_at | Notification-attempt reservation, not delivery |
| created_at | Creation timestamp |

Use foreign keys. Commit body, routing and reply relationship atomically; appended content is immutable. Corrections are new messages. Only notification reservation fields are subsequently updated by their algorithm.

Initialize `journal_mode=DELETE`; connections use `foreign_keys=ON`, `busy_timeout=3000` and `synchronous=FULL`. Keep synchronous transactions short; host subprocesses, stdin and output stay outside them. Busy errors must remain visible. Runtime directories use 0700 and files owner-only modes regardless of umask. Reject unsafe existing files rather than weakening host isolation.

## 5. Daily commands

`join` discovers the project/native identity, prepares local runtime state if needed and idempotently registers/selects an existing room. It returns the member, registered peers and actual reception capability. A missing named room is an error; only `room create` creates it.

`members` reports registration facts. Address by stable ID or exact unique name; do not label a host online/idle without evidence.

`send` supports shared progress, addressed messages and `--reply-to`. Replies target the parent sender; a conflicting explicit target is rejected. Targeting is not privacy: room members can read the entire stream. Explicit `--notify` requires another target and is never allowed to notify oneself. Broadcasts, routine progress, thanks and acknowledgments do not notify by default.

An optional stable ID provides message idempotency. The same ID/semantics returns the original message; different sender, target, parent, body or notify choice yields `E_CONFLICT`. A reused ID never repeats a notification attempt. Generated IDs do not deduplicate natural-language requests.

`read` supports new messages, sequence pagination, historical ID lookup and explicit `--mark`. Ordinary reads are read-only. Mark only a contiguous range actually read; never skip unread gaps. Default page size is 20, maximum 100, with a 256 KiB byte limit. Other rows may provide context, but a notification's listed IDs define the requested work. Check existing replies before acting.

## 6. Notifications and evidence

Each attempt is on demand. After exact-receiver checks, use a short transaction to reserve a batch, then call the host outside the transaction. Batch at most 20 eligible unread notifications per recipient. Defaults are 20 batches in a rolling 600 seconds, at least five seconds apart. Only unreserved notification candidates from the last 30 minutes are eligible; stored messages do not expire.

Deferred/rate-limited messages remain stored. There is no background sweep or guaranteed delayed redelivery. An eligible later send may create another attempt; resending the same stable ID does not. Unknown submission keeps reservations and pauses future sends. Migration, room changes and `notify resume` never replay uncertain attempts or switch adapters to resend them.

The three-line notification contains peer provenance, message IDs and a `Read argv` JSON array with exact executable/project/room/read arguments. It contains no business body, Base64 routing, duplicate directory/member fields or repeated protocol. Receivers preserve argument boundaries and original routing even after changing cwd/room, and use their own native identity.

The thin skill discovers this command, also accepting legacy `Tool argv`. Full rules are compiled into the executable's `skills get`. Reuse the same entry/version's rules; reload when missing or changed, never once per message by default.

### Codex

Invoke a compatible `codex queue --thread ... --message ...` for the exact registered thread. Require one matching queue receipt to report submission. Busy hosts may consume their queue only after the active turn ends. A queue receipt is not model-processing evidence.

### Claude

Use only the bound native socket, with current experimental checks described in [experimental-socket.md](experimental-socket.md). Do not create a replacement Claude client, receiver service, reply inbox or synthetic native sender identity. Successful writes remain `submitted`, `processed: false`; native hold/refuse can prevent delivery. This adapter has no native delivery-control receipt listener.

Verification requires a fresh correlated nonce returned by the exact native session, adapter, room and receiver instance. Old Hook/Channel proofs, another process and another room are historical evidence only. Notification TTL does not invalidate a late valid reply to an already queued probe. Preserve the first reply timestamp on idempotent repeats rather than refreshing old evidence.

## 7. Program, workspace and rooms

Install the global program once, sharing a versioned executable cache. Each initialized project's private run entry pins a version. A global upgrade does not rewrite all projects; use the newer `install` preview/apply for the requested project, then load that entry's protocol. Keep caches referenced elsewhere.

Default join/room use/install never reads or changes business instruction files, project hook JSON or Git exclude, even if malformed or linked. `install --instructions` and `install --hooks` are separate explicit integrations with preview, backup, idempotency, conflict checks and selective uninstall. Preserve existing user content and worktree-specific integration choices.

The default room keeps its original `chat.db`; named rooms use `rooms/<name>/chat.db`. Every room still has only members/messages, with independent IDs, cursors, budgets and reservations. Names are 1–64 lowercase letters/digits/underscore/hyphen, never arbitrary paths.

Selection is stored per project/runtime/native session. `room create` only creates, list/current are read-only, use/join selects an existing room. An explicit `--room` on a message command routes only that operation. Only a selected room receives new notifications. Worktrees share rooms but initialize and opt into automatic joining independently.

Native socket endpoints can be reused across a session's rooms; credentials are not copied. Nonce proof remains room-specific; unknown pauses remain session/adapter-wide across rooms. A copied binding cannot bypass project validation using a cached cwd.

## 8. Plugin and lifecycle

Both repository marketplaces point to `plugins/agentchat`. One thin skill discovers the selected executable and loads its protocol; it stores no project, session or room. The portable and compatible manifests preserve one plugin identity/version. CLI and plugin upgrades have separate lifecycles; never rewrite installed caches.

Claude's manifest alone names `hooks/claude-hooks.json`, containing SessionStart/SessionEnd. Avoid a default `hooks/hooks.json` that Codex could discover. The sh wrapper locates an installed program and forwards stdin without downloads, external Bun/Node, polling or model calls.

SessionStart uses real `cwd`/`session_id`, persists the UUID only in the host-provided private `CLAUDE_ENV_FILE`, and restores an existing exact member in its selected room independently of autoJoin. It enrolls a new UUID only in a valid initialized workspace with autoJoin enabled. Unrelated projects, uninitialized worktrees and subagents never enroll. `agent_type` alone may be a named primary agent; `agent_id` identifies a child. SessionEnd marks the exact session inactive across rooms before process exit.

The host may supply a not-yet-created CLAUDE_ENV_FILE on startup, resume or compaction. Require an absolute path, resolve only its existing parent, and open the leaf with O_RDWR/O_APPEND/O_CREAT/O_NOFOLLOW/O_NONBLOCK and mode 0600 for a new file. Validate the opened descriptor as a regular file owned by the current user, preserve content/newline boundaries, append an identical identity at most once on repeated invocations, and always close the descriptor. Reject linked/non-regular leaves and missing parents; do not create parent directories or initialize unrelated projects. This is host-private identity persistence, not model-delivery evidence.

Explicit socket disablement survives joining. A changed instance requires its new native process's own SessionStart or an explicit rebind; it never inherits old nonce proof. Version mismatch preserves manual messaging with a concrete reason and starts no fallback adapter. Owned legacy Channel launchers become retired stubs during migration; user launchers and running clients remain untouched.

## 9. Claude inbound policy and startup (Alpha 8)

An independent AgentChat CLI process attests neither a Claude sender identity nor permission class. A receiving Claude that bypasses prompts may therefore hold notifications for approval. Binding the socket cannot fix that policy.

When the human explicitly requests unattended reception with the explained scope, an agent can preview/apply `claude-inbound accept` before startup. The command operates outside project/identity discovery, honors `CLAUDE_CONFIG_DIR` and edits only user `settings.json`. Preview writes nothing. Apply backs up exact prior bytes, preserves other settings and modes, is idempotent and rejects invalid JSON, links, unsafe ownership/modes and stale in-memory plans. Output does not expose unrelated configuration. `hold`, `refuse` and `default` allow an explicit reversal; default removes the user key.

The saved choice persists across launches. SessionStart shows the configured user policy in initialized workspaces and provides it to the agent. It does not rewrite it, so a later hold/refuse is preserved. Unset/unreadable settings produce a setup notice; unrelated projects stay silent. Ordinary installation/join and peer messages never authorize a user-level policy change.

Accept affects all peer messages in that Claude configuration, not an AgentChat-only allowlist. Managed settings, launch settings and stricter project/local policies may override it. A project/local accept cannot loosen the native default. `doctor` labels the inspected user setting separately from effective policy and verified model reception. See [onboarding](../ONBOARDING.md#claude-inbound-policy-and-startup) and the linked official rules for user UI, per-launch scope and held-message behavior. No sender permission class or child credential is forged to avoid native approval.

## 10. Handoffs and native acceptance

A request states goal, inputs, constraints and expected output. End the turn after sending it; shell waiting/polling can prevent queue consumption. Put long reports in a mutually accessible authorized directory and send a summary/path, optionally a hash when content must be fixed.

A handoff identifies repository/worktree, base/current commits, staged/unstaged patches, untracked files, actual tests, remaining work and authority boundaries. Messaging does not transfer execution rights or provide code isolation.

Real acceptance first verifies a fresh nonce and bidirectional loop, then separately waits 10 minutes and one hour, timing the second after the first finishes. Keep machine/session alive without human renewal, fake business messages or model heartbeats. A local publisher checks the same receiver and native idle state, sends one request at the deadline and exits. A result wakes the original Codex for passive verification, without an acknowledgment loop. Accelerated clocks cover logic only and are not real idle evidence.

## 11. Design history

- Initial implementation used timed Stop/asyncRewake hooks. A later Channel design used stdio MCP, startup handshakes, receiver locks/leases and exact-session launchers. Real Channel nonce failed because the tested host reported configured but inactive; successful MCP initialization did not validate reception.
- The user then chose a separately verified native socket experiment while retaining the gateway. Historical native nonce, bidirectional and real idle results apply only to that original host/version/session/instance.
- Alpha 2 separated program, workspace and rooms. Its first-join project-file writes were superseded by Alpha 3's runtime-only defaults and separate instruction/hooks integrations.
- Alpha 4 added the thin plugin skill and compiled `skills get` protocol. Alpha 5 removed Channel/MCP/launchers, added plugin lifecycle hooks and made exact native socket binding the Claude path; setupVersion is 4. Existing messages/cursors/reservations/unknown pauses were retained.
- Alpha 5's tag build failed a Linux arm64 concurrency test and was not published. Alpha 6 deterministically fixed a SQLite journal exists/lstat race and dangling-link bypass: tolerate only ENOENT, preserve permission/link rejection and show child stderr. Do not overwrite the failed tag.
- Alpha 7 introduced the compact three-line notification and per-entry/version protocol reuse without changing storage or notification semantics.
- Alpha 8 adds explicit user-level inbound-policy setup and startup notices, with English primary documents and Chinese translations. It does not convert historical native proof into new-session acceptance.

## References

- [Git project/worktree discovery](https://git-scm.com/docs/git-rev-parse)
- [Claude hooks](https://code.claude.com/docs/en/hooks)
- [Claude cross-session messaging and native inbox](https://code.claude.com/docs/en/cross-session-messaging)
- [Claude setting precedence](https://code.claude.com/docs/en/settings-reference#crosssessioninbound)

Validate interfaces against the installed host and exact session. A design or another conversation's evidence cannot establish current reception.

Alpha 9 fixes a missing host environment file after startup/resume/compaction using the validated descriptor path above. Upgrade the global CLI and explicitly refresh old project bundles/pins; existing owned project hooks also need an explicitly scoped refresh if they still invoke an old executable. The plugin wrapper is unchanged and does not need a new plugin version for this CLI-only fix.

Alpha 10 separates existing-session restoration from new-session auto-join. SessionStart looks up the selected room's exact runtime/UUID read-only when autoJoin is false and reactivates/rebinds that member without changing membership, selection or cursors. It never creates a missing room/member in that mode, resumes other rooms, overrides socket opt-outs/uninstall, weakens native-process/version checks, resets pauses/budgets/reservations or reuses old receiver proof. Setup identifies existing versus created membership. A native event is required; a synthetic hook must never be used to impersonate a real resumed session.
