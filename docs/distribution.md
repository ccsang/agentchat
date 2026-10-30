# Distribution and releases

English | [Chinese translation](zh-CN/distribution.md)

The public entry point is [ONBOARDING.md](../ONBOARDING.md). Install the program once; first join prepares local project state, and rooms are created/selected separately. Installation or room creation alone does not authorize further setup.

## Package layout

- Claude `.claude-plugin/marketplace.json` and Codex `.agents/plugins/marketplace.json` point to the same `plugins/agentchat`. A shared thin skill discovers the actual CLI; plugin and CLI can version independently.
- The portable/compatible manifests keep the same identity/version. Claude alone declares short lifecycle hooks; Codex does not load them. Plugins contain no business project/session/room paths or MCP service. The program installer does not register plugins.
- The full protocol is compiled into the executable. `skills get --json` includes version/content/hash and works without project initialization, native identity, external Markdown or network.
- GitHub Releases provide standalone macOS/Linux arm64/x64 gzip packages, SHA256SUMS, installer, English onboarding and licenses. Chinese onboarding is available in the repository.
- Executables include Bun 1.3.14 and the CLI dependencies. Users need neither Bun/Node.js nor a source clone. Linux uses glibc; native Windows packages are not provided.
- The installer chooses OS/CPU and verifies both compressed and extracted bytes before execution. It does not change PATH, projects, agent authentication/gateways or permission settings.
- Cache executables under `${XDG_DATA_HOME:-$HOME/.local/share}/agentchat/<version>/<platform>/agentchat`; `AGENTCHAT_INSTALL_DIR` can select another absolute directory.
- Provide `~/.local/bin/agentchat` by default; `AGENTCHAT_BIN_DIR` overrides the command directory. Preserve an unrelated existing command and return the absolute CLI path for use when PATH lacks that directory.

## Workspace state and upgrades

First join validates identity/room, then prepares private entry/config/data. Default join/room use/install does not read or change AGENTS.md, CLAUDE.md, project settings or Git exclude. A compiled private run pins its version cache; source development pins Bun and a private JS bundle. No Channel launcher is generated.

`install --instructions` and `install --hooks` explicitly preview their own integrations; `--apply` applies the selected scope. Worktrees share rooms but keep independent workspace installation/integration choices. Default keeps the original chat.db; named rooms use rooms/<name>/chat.db. Each database has only members/messages.

Reuse preview/backup/idempotency/conflict checks. Selective uninstall keeps runtime/history; unqualified `uninstall --apply` disables the workspace and removes its enabled owned integrations, preserving rooms, messages, the global program and caches referenced by other projects. It does not revert a separate Claude user-setting choice.

Run a newer installer first, then explicitly repair the requested project's pinned entry using the new global install preview/apply. Repeating join does not update an existing pin. Load that actual entry's skills get after upgrading. Old project blocks/hooks remain unchanged unless separately requested. Owned private Channel launchers are retired during migration; old loaded host settings may require reload, but business clients are never killed and old notifications never replayed.

Alpha 3 introduced runtime-only defaults, Alpha 4 embedded instructions, Alpha 5/6 plugin lifecycle hooks/native socket reception, Alpha 7 compact Read argv notices and Alpha 8 explicit inbound-policy setup/startup display. Update the host plugin through its manager when its thin skill/hooks change. CLI updates never overwrite caches; no project hook copy is needed for a plugin user.

## Claude startup policy

For requested unattended reception, Alpha 8's `claude-inbound accept` preview/apply saves user-level crossSessionInbound before startup, with an exact backup and preserved unrelated values. It honors CLAUDE_CONFIG_DIR, requires no project/identity and exposes no unrelated setting contents. Accept covers all peer messages in that configuration; it is separate from ordinary install/join and workspace autoJoin.

The choice persists; the startup hook displays it in initialized workspaces and preserves later hold/refuse. Managed/launch/stricter project rules still apply. `doctor` and the hook report a configured user value, never an inferred effective policy or model-processing proof. See [onboarding](../ONBOARDING.md#claude-inbound-policy-and-startup).

Primary docs and release notes are English. Chinese translations live in docs/zh-CN with corresponding links. Keep the current onboarding translation synchronized; preserve historical release notes as historical behavior, not instructions to follow today.

## Build and verify

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
bun test tests
bun run build
bun run build:release
bun run verify:release --binary dist/release/agentchat-v0.1.0-alpha.8-darwin-arm64
```

`build:release --target linux-x64` supports cross-compilation. The release workflow uses four native runners for tests, builds and standalone verification. Fresh directories, special-character paths and PATH without developer runtimes cover installation/command protection, runtime-only defaults, explicit integrations, rooms, hooks/startup notices, inbound-policy preview/backup/reversal, SQLite messaging/mark and removal. Fake clients never notify real sessions.

Builds derive THIRD_PARTY_LICENSES.txt from bundled modules and Bun 1.3.14's original license notice. AgentChat uses the root MIT LICENSE; Bun/JavaScriptCore retain their respective licenses and source/relinking information.

Native model acceptance is separate. Historical evidence covers only the original macOS arm64 Claude Code 2.1.312 / peerProtocol 1 interactive session. A new user/instance needs doctor and a fresh correlated nonce; a working package is not that evidence.

## Publish

1. Update package/installer version and English release notes; synchronize Chinese translations and submit a PR.
2. Wait for all four native checks/package verification, then merge main.
3. Tag the same verified commit `v<version>`. The workflow validates the version and rebuilds/rechecks all platforms before publishing a prerelease.
4. From an unsigned-in environment, install the public program in isolated user configuration, join two fresh projects and check room/message separation, upgrades and policy setup. Verify public marketplace installs separately. Share the onboarding link after those checks.

Alpha installers use fixed release URLs instead of latest redirects. Publish a new tag and packages for upgrades; never replace old release bytes or rewrite project pins globally.

References: [Bun standalone executables](https://bun.sh/docs/bundler/executables), [GitHub hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
