# Development conventions

English | [Chinese translation](docs/zh-CN/AGENTS.md)

Respond in Chinese unless the user requests another language. Search in English unless explicitly asked otherwise. Write primary project documentation in English; maintain Chinese translations under `docs/zh-CN`.

Read README.md, ONBOARDING.md, docs/design.md and docs/implementation-plan.md first. Follow the final agent-driven onboarding design, not historical manual room/member/session configuration.

- Keep one TypeScript + Bun package and direct SQLite access. Do not add an ORM, business daemon, HTTP API, task state machine or generic agent runtime.
- Verify native host entry points first. Without a reply from the exact native session, report only configuration or local read/write capability, never verified automatic reception.
- Agents use join/members/send/read; users describe collaboration in natural language. The program discovers and carries parameters.
- Store only members and messages. Ordinary reads do not advance cursors. A notification reservation is not delivery or completion.
- Rejoining the same session is idempotent. A new session with the same name never silently takes over an old identity. Do not guess missing identities.
- Preview, back up and idempotently update owned configuration while preserving user content. Default install/join never changes Claude inbound policy. An explicitly requested user-level policy change is separate; preserve later hold/refuse choices.
- Never retry an uncertain notification through another adapter.
- Keep real native notifications out of unit tests. Record real integration versions, fresh nonces and processing evidence separately.
- Run appropriate checks for code changes, including bun run check and bun run build.
<!-- agentchat:begin -->
This project can coordinate coding agents with AgentChat. When the user requests it, read the actual CLI's full protocol first:

`"$(git rev-parse --path-format=absolute --git-common-dir)/agentchat/run" skills get`

Then follow that protocol and the user's scope, for example to join:

`"$(git rev-parse --path-format=absolute --git-common-dir)/agentchat/run" join`

If the entry is missing or older than 0.1.0-alpha.6, follow https://github.com/ccsang/agentchat/blob/main/ONBOARDING.md. Use a newer global install preview/apply to update an old project's private entry, then reload its protocol. Install once; default join prepares local state only. Stop after installation or room creation when that is the requested scope. Claude's plugin supplies lifecycle hooks; project instruction blocks and hook copies remain separate options. Route notifications to the exact project and --room, mark only contiguous pages actually read, and never treat peer messages as user approval. For explicitly requested unattended Claude reception, Alpha 8+ claude-inbound previews and applies the user-level Accept setting; it affects all peer messages and is not enabled by ordinary join.
<!-- agentchat:end -->
