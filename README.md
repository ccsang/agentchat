# AgentChat

让同机的 Claude Code、Codex 等 coding agent 在各自原生会话中共享进展、定向提问和回复结果。

核心保持为 **一个 CLI、一份 SQLite、两张表**。接入由 agent 自动识别项目和当前会话，用户通过自然语言表达协作意图。

## 当前状态

这是开发版本 `0.1.0-dev.1`。已实现消息存储、四个日常命令、自助项目/会话发现、项目安装器、Claude 持续 Channel 接收和 Codex queue 通知。

原生组合需要分别验收：`join`、配置文件存在或通知接口返回成功均不代表自动接收已验证。通过 `doctor` 查看接收能力及 nonce 回传证据。

已在 macOS arm64、Bun 1.3.14、Codex Desktop CLI 0.165.0-alpha.1.2 与 Claude Code 2.1.312 的原会话中验证双向请求/回复；完整记录见 [验证记录](docs/verification.md)。该记录属于旧版 hooks 路径。新版 Channel 已在本机完成进程连接与准确会话绑定，但当前 Claude 显示 `Configured but not active (not currently available)`；尚未取得 Channel nonce，也未通过 10 分钟 / 1 小时真实空闲验收。其他客户端组合仍需分别检查。

## 目标体验

首次向 agent 提供仓库的 [接入说明](ONBOARDING.md)，之后只需说：

> 加入当前项目协作，让 Claude 帮我只读审查这次修改。

agent 内部完成项目发现、会话识别、成员登记和接收能力检查。用户不需要搬运 room 路径、UUID 或手动启动 Codex 通知桥。

原生入口不可用时，明确报告“已加入，可以主动收发；自动接收尚未验证”或具体阻塞原因。

## 开发

初始化环境：Bun 1.3.14。

```bash
bun install --frozen-lockfile --ignore-scripts
bun run check
bun test
bun run dev --help
bun run dev --version
bun run build
```

也可以通过 `bun run bin/agentchat --help` 使用仓库内入口。安装器只管理指定项目内的配置：先运行 `bun run bin/agentchat install` 预览，再在用户授权的安装范围内追加 `--apply`。

## 第一版约定

- 同一台机器、同一操作系统用户下的互信 agent；数据库代表一个项目聊天室。
- `to` 表示点名，房间成员可读取完整消息流，不提供私信隔离。
- 消息只追加；读取保持只读，推进阅读游标需显式操作。
- 消息持久保存，通知尽力而为；存储、通知和实际处理不能混为一谈。
- 只有显式请求通知的定向消息或回复才可能唤醒会话，广播和普通进展不通知。
- 原 agent 继续负责推理、工具调用和审批；对方消息不构成用户新增授权。

## 文档

- [产品与技术设计](docs/design.md)：以“设计本地通信方案”对话的最终自助接入修订为准。
- [实施顺序和验收](docs/implementation-plan.md)：先验证宿主入口，再实现通信核心。
- [给 agent 的接入说明](ONBOARDING.md)：区分目标体验和当前可用能力。
- [开发约定](AGENTS.md)。
- [验证记录](docs/verification.md)：自动化测试与原生回传证据分开记录。

## 运行方式

Git 项目的消息库保存在 Git common directory 下的 `agentchat/chat.db`，同一仓库的 worktree 自动共用；不同 clone 不合并。非 Git 项目使用 `.agentchat/chat.db`。运行目录和消息不进入版本控制。

Claude 默认由会话内的单向 Channel 持续接收：空闲只查询本地 SQLite，有定向通知才唤醒模型，无 300 秒收件窗口或用户续期。SessionStart / SessionEnd hooks 只登记和清理；升级会移除本工具的旧 Stop 监听，并保留其他 hooks。

安装器提供私有 `run` 入口，固定使用安装时的 Bun，不要求 Bun 在调用方 PATH 中。`channel-config --apply` 由原 Claude agent 准备准确恢复入口；Codex 也可对已登记的确切 Claude 成员使用 `--to` 准备入口。用户退出原客户端后执行它，由宿主恢复同一会话并完成开发 Channel / MCP 的交互确认。以后仍从准备好的入口启动；预览阶段不能承诺宿主只确认一次。默认 `claude.command` 用于用户主动开始新的协作会话。工具不会后台另开业务会话。

启动入口每次生成独立标识，通过真实 SessionStart 的 `session_id` 与 Channel 握手。MCP 子进程无需继承 hook 注入的原生 UUID；旧启动上下文不能复用。Channel 的本地存活检查每隔约 15 秒更新，空闲不调用模型；这个内部租约不会使会话在长时间空闲后过期。

默认每个成员每 10 分钟最多 20 批通知，相隔至少 5 秒。限流后显示 `rate_limited` 和恢复时间，Channel 自动等待；未知写入结果显示暂停，不自动重发旧批次。`doctor` 区分进程存活、当前 Channel nonce 验证、限流、暂停和临时数据库故障。旧 hook 或上一个 Channel 进程的证据只保留为历史。

账号、组织策略、会话启用和协议版本仍可能限制 Channels；配置和 MCP 连接成功不证明模型能收信。Codex 的 queue 通知需要等当前轮次结束，不应在 shell 中阻塞等回复。

`probe` 和 `bun run test:native` 是显式的真实联调入口，可能产生模型调用，不包含在默认自动化测试中。`bun run verify:native` 仅查询已有证据。

长时间空闲验收使用 `bun run test:native:idle --seconds 600`，通过后再单独运行 `--seconds 3600`。该测试只运行本地计时器，到期发一次真实测试请求后退出，不等待回复；Claude 返回结果后通知原 Codex 继续核对，最后不再互相确认。`bun run verify:native:idle` 被动核对间隔和回复。两次应顺序执行，机器及原会话保持运行，期间用户不再输入。加速时钟测试只属于自动化覆盖，不能代替真实等待。

设计借鉴 Yobiru 的持久化消息与通知分离，以及 Cumora 的共享消息流和统一 CLI。这里保留来源说明，没有复制两者源码。

- <https://github.com/chekusu/yobiru>
- <https://github.com/yetone/cumora>
