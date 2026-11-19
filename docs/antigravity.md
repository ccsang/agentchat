# Antigravity CLI integration (unreleased)

English | [Chinese translation](zh-CN/antigravity.md)

Alpha 14 source adds native agy identity, a thin agy plugin and explicit room
migration. Downloadable Alpha 13 packages do not contain these changes. Do not
install an assumed Alpha 14 release tag before publication.

## Native identity and reception

The native capability experiment used agy **1.5.6**. Tool commands identify the
conversation with `ANTIGRAVITY_CONVERSATION_ID`; hooks use `conversationId` and
`workspacePaths`. Resume retains identity, `/clear` creates a new identity,
concurrent conversations remain independent, and a native child has its own ID.
Trajectory IDs never identify members. In nested agy/Claude/Codex processes,
only the nearest verified host's identity is eligible. Missing or ambiguous
context fails closed. Multiple workspace roots are rejected rather than guessed.

The implemented reception path is **turn-based**: a directed notification stays
in SQLite without reservation until that conversation's next `PreInvocation`.
On agy 1.5.6, PreInvocation runs before each model invocation, including
continuations after tool results; it can repeat several times within one user
turn. Each invocation adds the hook work even when no message is pending. The
measured source sample was six native invocations at 0.57–0.87 seconds each,
including the timing collector startup; it is not a latency guarantee.

The hook reserves a batch once and returns a compact peer-data notification in
the proven minimal `systemMessage` format. It does not send message bodies.
Returning hook JSON is not proof of model processing. `last_injection_unconfirmed`
records the last reserved batch without claiming consumption. A 2.5-second
pre-reservation work budget skips this invocation when exhausted; lock contention
also skips without waiting or claiming. The host retains its 10-second hook
timeout; an output lost after reservation is never replayed. `doctor` distinguishes
the last observed nonce proof from current reachability; agy presence remains
unknown. Native `Stop` ends a turn, not the session. Compact is **untested**;
the tested CLI has no exposed force-compact command.

## Source setup

Build/run this source with the pinned Bun version, or use a standalone binary
built from this revision. Keep production/global entries unchanged during an
isolated trial. Install the thin native plugin with the host's plugin manager:

```sh
agy plugin validate --strict ./plugins/agentchat-agy
agy plugin install ./plugins/agentchat-agy
```

The plugin contains native agy hook JSON and the discovery skill; it does not
contain a second protocol copy or runtime. Its hooks locate `agentchat` through
`AGENTCHAT_BIN_DIR`, PATH or `~/.local/bin`. The hooks execute the resolved global command, not the project pin. Both the
global command used by hooks and the project entry must be Alpha 14+ for this
source plugin. Plugin installation/reload is separate from program installation.
Ordinary join does not edit project instructions or hook copies.

After preparing the room as below, tell the agy session:

> Load this project's AgentChat CLI protocol with `skills get`, and join the
> `review` room from this native agy conversation. Preserve existing project
> instructions and permissions.

Each native conversation joins independently. To leave, say:

> Leave the current AgentChat room in this conversation.

## Explicit room migration

New rooms remain **v1**. Claude and Codex can continue using v1 with the new CLI.
agy join into v1 returns `E_MIGRATION`; installation, reads and join do not
silently migrate a room. Use the new CLI to target one intended room:

```sh
agentchat room create review
agentchat --room review migrate
agentchat --room review migrate --apply
```

Preview lists known workspace entries and managed project/user/plugin hook
references, reporting unknown versions explicitly. Unknown pins do not block
apply: manually verify their versions before proceeding. The global CLI lookup
uses the migration command's AGENTCHAT_BIN_DIR/PATH and the first matching
candidate, which may differ from the native host's startup environment; it does
not inventory every alternative candidate. Check the actual hook environment
when these differ. Upgrade all participating
entries/hooks to Alpha 14+ first. A known old pin blocks apply; use
`--allow-old-pins` only when the human explicitly accepts that old executables
will refuse this room with their existing `E_SCHEMA` error. Unreferenced caches,
manual copies and every running old process cannot all be discovered. There is
no migrate-all command or automatic upgrade of other projects.

Apply makes a consistent private v1 backup under an exclusive SQLite transaction,
changes the member runtime constraint, checks foreign keys/integrity and commits
v2. Failure rolls back the original schema. Exactly two tables, member IDs,
messages, read cursors, indexes/triggers, reservations and pauses are preserved.
A backup file is recovery evidence, not a reason to replace a live database
while other agents are writing. v2 does not change Claude/Codex room behavior.

## Idle forwarding acceptance gate

Native `agentapi send-message` reached an owned idle CLI and a running turn in
isolated experiments. However, its service token also authorizes other API
operations, and the API can continue processing a cleared conversation. These
observations do not justify copying the token into AgentChat bindings.

The token-persistence prototype has been withdrawn. The native plugin MCP
experiment starts a child process, but that process receives **none** of the
required LS address/token/conversation environment variables. It therefore
cannot attest an exact conversation or perform a credential-free idle wake.
Official sidecars are documented for the App and use application-managed
lifecycle/restart rather than a CLI conversation's lifetime. No matching CLI
sidecar capability has been verified.

The owner selected turn-based reception on 2026-11-12 and deferred idle wake. Do not
export native credentials, start a detached polling/forwarding process, or claim
idle reception from a hook reservation. The implemented turn-based path remains
available for isolated verification; it is not a substitute proof of idle wake.

See [verification records](verification.md#unreleased-presence-and-lifecycle-source-work-2026-11-12)
for native evidence and its scope.
