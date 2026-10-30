# Experimental Claude native socket adapter

English | [Chinese translation](zh-CN/experimental-socket.md)

The user selected this experiment after Channel was unavailable, retaining the existing gateway. Alpha 5 removed Channel and made exact native socket binding the Claude reception path. Codex continues using its queue. No additional inbox process is introduced.

## Scope

The adapter accepts only Claude Code **2.1.312 / peerProtocol 1**, interactive CLI. The original macOS arm64 session passed fresh nonce, bidirectional and sequential real 10-minute/one-hour idle tests; see [verification.md](verification.md). Other versions, Linux/Windows native hosts and Desktop Code tabs have not passed real-model acceptance. External frame/key details are experimental, not a stable official client API; recheck them after host upgrades.

There is no separate receiver service, HTTP port, synthetic native session or model polling. The core remains one CLI and two business tables per room.

## Binding and diagnosis

`join` attempts to bind the exact supported session; unsupported combinations retain manual messaging and report the reason. `socket-config [--to EXACT_MEMBER]` previews an explicit repair; append `--apply` to bind. Resolve the registered UUID to one valid peer without asking users to copy IDs/socket paths.

Only an authorized real `probe` and a nonce reply from that instance's own tool context validate automatic reception. `doctor` reports `claude-socket-experimental`; `current_socket` proof belongs to the recorded instance/room. Restoring a session in a new process requires its own SessionStart or explicit rebind and a fresh probe, never a same-name takeover.

Claude plugin lifecycle hooks auto-enroll only already initialized workspaces with autoJoin enabled. Auto-join defaults off. SessionEnd marks the exact session inactive. `socket-config --disable --apply` preserves history and prevents later join from silently re-enabling reception; `install --no-auto-join --apply` prevents future auto-enrollment. Neither starts a fallback client or resets reservations.

## Inbound approval at startup

A successful socket write may be held by Claude's native inbound rules. AgentChat's sender is an independent process and does not assert a Claude identity/permission class. A bypassing receiving session may therefore show Held peer message until the user accepts it.

When the human requests unattended reception with the explained scope, use Alpha 8+ `claude-inbound accept` preview/apply before startup. It saves a user-level choice affecting all peer senders in that configuration, not only AgentChat. Claude retains the choice across launches; the AgentChat startup hook displays the configured user value and preserves later hold/refuse choices. It does not repeatedly rewrite settings. Default install/join does not change inbound rules.

Managed/launch settings and stricter project rules may override that user value. A project/local accept cannot loosen the default. `doctor` reports configuration separately from effective policy and model proof. See [onboarding](../ONBOARDING.md#claude-inbound-policy-and-startup) for UI/per-launch alternatives, backup and reversal. Do not forge a permission class, child token or reply address to bypass approval.

## Wire protocol and validation

- Inspect bounded PID metadata under this user's Claude sessions directory, filtering the exact registered UUID without reading unrelated conversation bodies.
- Validate the project's common-directory boundary and process start time with LC_ALL=C/TZ=UTC to match 2.1.312 metadata. Reject PID reuse, duplicate live claims for the same session, wrong project or unsupported protocol/version/client kind.
- Native metadata may be 0644 but must be an owned regular file. Socket/directory and key require owner-only permissions; reject final-path symlinks.
- Bun 1.3.14 cannot realpath a socket inode: lstat the final node, canonicalize its parent and retain device/inode checks, including macOS /tmp → /private/tmp aliases. Instance identity includes process, version, canonical socket path, device and inode.
- In this host version, key filenames hash the published socket path, which can differ from the canonical alias. Validate peerToken/procStart and never put credentials in bindings, messages or command arguments.
- Send peer auth plus a user-message NDJSON frame: `type=user`, `message.role=user`, `priority=next`, `msgV=1`, stable wire ID `cc-msg-UUID`. Its body contains compact AgentChat IDs/read instructions, not business text.
- Do not use `CLAUDE_CODE_MESSAGING_TOKEN` child credentials, claim a Claude reply address or assert from-mode. Host inbound approval and ordinary tool permissions continue to apply. A separately human-requested user-setting change is explicit setup, not adapter behavior.
- No native reply inbox is created, so held/denied control receipts are not observed. A write reports `submitted`, `processed: false`, not model processing.

## Failures and limits

Validate/connect before a short reservation transaction, then write outside the transaction and revalidate the same instance. A known pre-connection failure consumes no reservation. Once submission begins, errors/timeouts/instance changes are unknown: retain the reservation, pause future sends and never retry/fallback.

Reuse the shared budget, batching, 30-minute candidate TTL and explicit read cursors. A deferred attempt retains the message and reports held; there is no background retry bridge. `notify resume` affects future attempts only. A retired Channel unknown pause is not cleared by socket migration.

## Acceptance

Ordinary automated checks use isolated fake peers, temporary sockets and synthetic keys. They cover routing, permissions, instance replacement, PID changes, failure/pause behavior and proof isolation without touching real clients.

Real acceptance first completes a fresh nonce and bidirectional loop, then separately runs `test:native:idle --seconds 600` and `--seconds 3600`. During each wait, the publisher verifies unchanged native idle state/instance and no Claude project activity, sends once at the deadline, then exits. The original Codex passively checks the returned result and metadata; it sends no acknowledgment loop.

## Sources

Official documentation describes native inboxes, identity/lifecycle, provider availability and inbound controls. External NDJSON/key details were checked against an independent protocol description and the installed version; no third-party implementation was copied.

- [Claude cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging)
- [Claude inbound setting](https://code.claude.com/docs/en/settings-reference#crosssessioninbound)
- [cc-peer protocol (unofficial)](https://github.com/mikekelly/cc-peer/blob/main/docs/PROTOCOL.md)
