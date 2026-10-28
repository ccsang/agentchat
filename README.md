# AgentChat

让同机的 Claude Code、Codex 等 coding agent 在各自原生会话中共享进展、定向提问和回复结果。

核心保持为 **一个 CLI、一份 SQLite、两张表**。接入由 agent 自动识别项目和当前会话，用户通过自然语言表达协作意图。

## 当前状态

这是项目初始化版本 `0.1.0-dev.0`。已具备 Bun / TypeScript 项目配置和 CLI 帮助、版本入口；消息存储、自动接入、hook 和原生通知尚未实现或验证。

`join` 等待实现的命令会返回 `E_NOT_IMPLEMENTED`，不会把空配置或占位逻辑报告成接入成功。

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
bun run dev --help
bun run dev --version
bun run build
```

也可以通过 `bun run bin/agentchat --help` 使用仓库内入口。初始化过程不安装全局命令、不修改其他项目的配置。

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

设计借鉴 Yobiru 的持久化消息与通知分离，以及 Cumora 的共享消息流和统一 CLI。这里保留来源说明，没有复制两者源码。

- <https://github.com/chekusu/yobiru>
- <https://github.com/yetone/cumora>
