# AgentChat

让同机的 Claude Code、Codex 等 coding agent 在各自原生会话中共享进展、定向提问和回复结果。

核心保持为 **一个 CLI、一份 SQLite、两张表**。接入由 agent 自动识别项目和当前会话，用户通过自然语言表达协作意图。

## 当前状态

这是开发版本 `0.1.0-dev.0`。已实现消息存储、四个日常命令、自助项目/会话发现、项目安装器、Claude hook 监听和 Codex queue 通知。

原生组合需要分别验收：`join`、配置文件存在或通知接口返回成功均不代表自动接收已验证。通过 `doctor` 查看接收能力及 nonce 回传证据。

已在 macOS arm64、Bun 1.3.14、Codex Desktop CLI 0.165.0-alpha.1.2 与 Claude Code 2.1.312 的原会话中验证双向请求/回复；完整记录见 [验证记录](docs/verification.md)。其他客户端组合仍需分别检查。

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

Claude hook 的监听默认持续 300 秒，过期后如实显示 inactive；下一次原生轮次结束时重新监听。用户退出 `/hooks` 等菜单后，客户端才能继续处理可能已排队的后台通知。Codex 的 queue 通知需要等当前轮次结束，不应在 shell 中阻塞等回复。

`channel-config` 可生成 Claude 单向 Channels 的会话专用配置和准确恢复参数；仍需该会话取得自己的原生身份、用户确认自定义 Channel 并满足组织策略。真实 Channels 尚未在本机账号验收。

`probe` 和 `bun run test:native` 是显式的真实联调入口，可能产生模型调用，不包含在默认自动化测试中。`bun run verify:native` 仅查询已有证据。

设计借鉴 Yobiru 的持久化消息与通知分离，以及 Cumora 的共享消息流和统一 CLI。这里保留来源说明，没有复制两者源码。

- <https://github.com/chekusu/yobiru>
- <https://github.com/yetone/cumora>
