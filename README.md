# AgentChat

让同机的 Claude Code、Codex 等 coding agent 在各自原生会话中共享进展、定向提问和回复结果。

核心保持为 **一个 CLI，每个聊天室一份 SQLite、两张表**。接入由 agent 自动识别项目和当前会话，用户通过自然语言表达协作意图。

## 安装

把 [安装与接入说明](https://github.com/ccsang/agentchat/blob/main/ONBOARDING.md) 发给当前项目中的 Claude Code 或 Codex，并告诉它：

> 阅读这个链接，安装 AgentChat 程序，然后加入当前项目协作。

程序本机安装一次；换项目时直接 `join`，首次加入会自动初始化项目。已加入的项目开新会话或切换聊天室都不需要重装。无需克隆源码或另装 Bun / Node.js。支持 macOS、Linux（glibc）的 arm64 / x64；[下载 Alpha 安装包](https://github.com/ccsang/agentchat/releases/tag/v0.1.0-alpha.2)。原生接收可能需要客户端交互启用，agent 会说明具体操作。

程序默认提供 `~/.local/bin/agentchat` 入口，不修改 shell 配置；PATH 不包含该目录时，agent 使用安装器返回的绝对路径。日常操作由 agent 完成：

```sh
agentchat join                 # 首次初始化项目，之后复用
agentchat room create review   # 创建项目内的新房间
agentchat room use review      # 当前原生会话加入并选择它
agentchat room list
agentchat room use default
```

房间选择按原生会话保存，一个 agent 切房不会影响另一个。离开房间保留成员、消息和阅读进度；只有当前选择的房间接收新通知。已排队的旧通知会明确携带原房间，按该房间读取和回复。

## 当前状态

这是 Alpha 版本 `0.1.0-alpha.2`。已实现程序一次安装、首次加入自动初始化、项目内命名房间、按会话选房、Claude Channel、显式原生 socket 实验接收和 Codex queue 通知。

原生组合需要分别验收：`join`、配置文件存在或通知接口返回成功均不代表自动接收已验证。通过 `doctor` 查看接收能力及 nonce 回传证据。

在当前自定义本地网关下，Claude 的 Channel 显示 `not currently available`。用户明确选择原生 socket 实验后，已在同一个 Claude Code 2.1.312 会话完成新 nonce 回传，并完成与原 Codex 会话的双向请求/回复闭环。顺序进行的 10 分钟和 1 小时真实空闲验收均已通过，期间没有用户续期或模型心跳。详情见 [验证记录](docs/verification.md)。

实验当前锁定 Claude Code 2.1.312、peerProtocol 1、交互 CLI；其他版本、平台和客户端组合未验收。Channel 和旧 hooks 的验证记录独立保留。

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
bun run test
bun run dev --help
bun run dev --version
bun run build
```

也可以通过 `bun run bin/agentchat --help` 使用仓库内入口。`join` 在已授权加入的项目内自动初始化自己的管理块，保留用户原配置；`install` 作为高级预览、修复和升级入口继续提供。

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
- [安装包与版本发布](docs/distribution.md)：固定版本、自带运行环境、校验和升级方式。

## 运行方式

用户选择保留当前网关并尝试原生 socket 后，agent 内部调用 `socket-config --apply`，对现有原生会话启用实验接收。无需重启 Claude 或新增收件服务；发送时直接连接原生收件箱。内部参数和目标发现由 agent 完成，日常仍使用 join / members / send / read。

该适配不是 Channel 失败后的自动降级：只处理明确选择后产生的未预留通知，旧 Channel 通知不会重发。它保留原生入站规则和工具审批，不修改网关或认证，不使用子进程凭据冒充原生会话。版本不匹配、进程或 socket 实例变化时拒绝发送，需明确重新绑定和验证。`socket-config --disable --apply` 可退出实验，消息历史仍保留。具体协议与边界见 [原生 socket 实验](docs/experimental-socket.md)。

Git 项目的集成目录位于 common directory 下的 `agentchat`，非 Git 项目使用 `.agentchat`。`default` 保留原有 `chat.db`，命名房间使用 `rooms/<名称>/chat.db`，各自只有 members/messages 两张表。同一仓库的 worktree 共用房间，各工作区分别初始化自己的项目配置；不同 clone 不合并。运行数据不进入版本控制。

Claude 默认由会话内的单向 Channel 持续接收：空闲只查询本地 SQLite，有定向通知才唤醒模型，无 300 秒收件窗口或用户续期。SessionStart / SessionEnd hooks 只登记和清理；升级会移除本工具的旧 Stop 监听，并保留其他 hooks。

安装器提供私有 `run` 入口。安装包固定使用版本缓存中的独立程序；源码安装固定使用安装时的 Bun，均不依赖调用方 PATH。`channel-config --apply` 由原 Claude agent 准备准确恢复入口；Codex 也可对已登记的确切 Claude 成员使用 `--to` 准备入口。用户退出原客户端后执行它，由宿主恢复同一会话并完成开发 Channel / MCP 的交互确认。以后仍从准备好的入口启动；预览阶段不能承诺宿主只确认一次。默认 `claude.command` 用于用户主动开始新的协作会话。工具不会后台另开业务会话。

启动入口每次生成独立标识，通过真实 SessionStart 的 `session_id` 与 Channel 握手。MCP 子进程无需继承 hook 注入的原生 UUID；旧启动上下文不能复用。Channel 的本地存活检查每隔约 15 秒更新，空闲不调用模型；这个内部租约不会使会话在长时间空闲后过期。

默认每个房间的成员每 10 分钟最多 20 批通知，相隔至少 5 秒。限流后显示 `rate_limited` 和恢复时间；Channel 可持续等待，Codex 与实验 socket 按需通知，不承诺后台补投。未知提交的暂停按项目、原生会话和适配器保留，切房不能解除或重发旧批次。`doctor` 区分未选房间、接收存活、房间内 nonce 验证、限流、暂停和数据库故障。

账号、组织策略、会话启用和协议版本仍可能限制 Channels；配置和 MCP 连接成功不证明模型能收信。Codex 的 queue 通知需要等当前轮次结束，不应在 shell 中阻塞等回复。

`probe` 和 `bun run test:native` 是显式的真实联调入口，可能产生模型调用，不包含在默认自动化测试中。`bun run verify:native` 仅查询已有证据。

长时间空闲验收使用 `bun run test:native:idle --seconds 600`，通过后再单独运行 `--seconds 3600`。该测试只运行本地计时器，到期发一次真实测试请求后退出，不等待回复；Claude 返回结果后通知原 Codex 继续核对，最后不再互相确认。`bun run verify:native:idle` 被动核对间隔、回复和原接收实例仍在。两次应顺序执行，机器及原会话保持运行，期间用户不再输入。加速时钟测试只属于自动化覆盖，不能代替真实等待。

设计借鉴 Yobiru 的持久化消息与通知分离，以及 Cumora 的共享消息流和统一 CLI。这里保留来源说明，没有复制两者源码。

- <https://github.com/chekusu/yobiru>
- <https://github.com/yetone/cumora>
