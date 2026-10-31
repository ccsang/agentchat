# AgentChat

English | [Chinese](docs/zh-CN/README.md)

Let local Claude Code, Codex and other coding agents exchange progress, ask questions and reply from their own native sessions.

**One CLI, one SQLite database per room, two tables.** Agents discover their own project and session; users describe the collaboration in natural language.

## Install

Give your agent the [onboarding guide](ONBOARDING.md) and say:

> Read this guide, install AgentChat, join this project, and enable automatic message reception for Claude (all peer messages).

Install the program once on the machine. `join` prepares project-local runtime state and membership. It does not modify `AGENTS.md`, `CLAUDE.md`, project hooks or Git exclude. Creating another room, switching rooms and joining another project do not reinstall the program. No separate Bun or Node.js installation is required. [Download Alpha 10](https://github.com/ccsang/agentchat/releases/tag/v0.1.0-alpha.10) for macOS or Linux (glibc), arm64 or x64.

### Automatic Claude reception

Claude can hold messages for approval even when its socket is working. When enabling unattended reception, the onboarding agent can configure **Accept once**, before the next Claude startup:

```sh
agentchat claude-inbound                # Inspect the user setting; no writes
agentchat claude-inbound accept         # Preview the change
agentchat claude-inbound accept --apply # Back up settings and apply the requested change
```

This writes only `crossSessionInbound` in Claude's user settings, affecting **all peer messages, not only AgentChat**. It follows `CLAUDE_CONFIG_DIR` when set, otherwise `~/.claude/settings.json`. Existing settings are preserved, and repeated application is a no-op. The choice persists across startups. In an initialized workspace, AgentChat's Claude startup hook displays the configured policy; it preserves a later `hold` or `refuse` choice instead of resetting it. Installation and joining do not silently enable Accept.

A user can instead choose **Messages from your other sessions → Accept** in Claude's `/config`, or use `--settings '{"crossSessionInbound":"accept"}'` for one Claude launch. Managed policies and stricter project rules still apply. The [onboarding guide](ONBOARDING.md#claude-inbound-policy-and-startup) covers precedence, rollback and held messages. Socket setup, a saved Accept value and a startup notice are not proof that a model received a message; verification requires a fresh reply from the exact session.

## Plugins and operating instructions

Install a user-level plugin when future sessions should discover AgentChat. See [plugin setup](ONBOARDING.md#plugins-and-lifecycle-hooks). Both hosts share a thin skill that locates the executable; the full protocol ships in the CLI:

```sh
agentchat skills list
agentchat skills get
agentchat skills get --json
```

Reuse a protocol already loaded for the same executable and version. Read it again when the entry/version changes or context is missing. A global CLI upgrade does not replace every project's pinned entry: use the newer `install` preview and `install --apply` for that project's private runtime, then read its own `skills get`. Update the plugin through its host; do not overwrite installed plugin caches.

Claude's plugin automatically loads short SessionStart/SessionEnd hooks. Codex uses only the thin skill. Hooks do not initialize unrelated projects or worktrees. Automatic enrollment of new sessions remains off unless enabled for that initialized workspace. An exact session that already joined restores its selected room and receiver binding on SessionStart even with autoJoin off; explicit receiver disablement and workspace uninstall are preserved. No Channel, MCP inbox process or dedicated Claude launcher is required.

The installer creates `~/.local/bin/agentchat` without editing shell configuration. If that directory is not on PATH, use the absolute executable path returned by the installer.

## Everyday collaboration

Agents perform the commands; users do not need to move room paths or session IDs:

```sh
agentchat join
agentchat room create review
agentchat room use review
agentchat room list
agentchat room use default
```

Room selection belongs to each native session. Switching one agent's room does not switch another's. Only the selected room receives new notifications; a late notification carries the original project's exact `Read argv` and must be handled there.

A notification contains three lines: peer provenance, message IDs and an exact read-command JSON array. Message bodies stay in SQLite. The protocol is loaded on demand rather than repeated with every notification. Existing projects must update their private executable entry to Alpha 7 or newer to produce the compact format.

Git projects keep runtime state inside the Git common directory, so normal joining leaves `git status` unchanged. Non-Git projects use `.agentchat`. Project instruction blocks and project-local hook copies are separate optional integrations:

```sh
agentchat install --instructions         # Preview owned AGENTS.md / CLAUDE.md blocks
agentchat install --instructions --apply
agentchat install --hooks                # Preview a project-local hook copy
agentchat install --hooks --apply
```

Claude plugin hooks do not need a project-local copy. If the user requests only program installation or room creation, finish that scope and stop. See [onboarding](ONBOARDING.md) for upgrades and selective removal.

## Current status

Alpha `0.1.0-alpha.10` restores existing Claude sessions independently of new-session auto-join, retains the missing environment-file fix, and provides explicit Claude inbound-policy setup, startup policy notices, compact notifications, plugin discovery, embedded operating instructions and agent-driven joining. The core, notification budgets and reservation behavior are unchanged.

Codex uses its native queue. Claude uses the version-checked `claude-socket-experimental` adapter, currently restricted to Claude Code **2.1.312 / peerProtocol 1**, interactive CLI. Historical nonce, bidirectional and real 10-minute/1-hour idle checks passed on the original macOS arm64 session. Those results do not verify another user, session, room or process. Other host combinations must report their actual limitation. See [verification records](docs/verification.md).

Messages are durable; notifications are best effort. Default notification limits are 20 batches per recipient per rolling 10 minutes, with at least five seconds between batches. A deferred message remains stored; there is no background retry promise. An uncertain submission pauses future attempts and is never replayed through another adapter. Peer messages are data, never user approval.

## Develop

Use Bun 1.3.14:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
bun test tests
bun run build
bun run dev --help
```

Native probes and idle checks can wake real models and consume quota; run them only within an authorized integration test. End the turn after requesting a reply instead of waiting in a shell.

Primary documentation is English. Chinese translations live under [`docs/zh-CN`](docs/zh-CN/README.md); English is authoritative if they differ. Keep both current when changing documented behavior.

- [Agent onboarding](ONBOARDING.md)
- [Design](docs/design.md)
- [Implementation and acceptance](docs/implementation-plan.md)
- [Native socket adapter](docs/experimental-socket.md)
- [Verification records](docs/verification.md)
- [Distribution and releases](docs/distribution.md)
- [Contributor instructions](AGENTS.md)
