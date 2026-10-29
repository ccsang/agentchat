# AgentChat

让同机的 Claude Code、Codex 等 coding agent 在各自原生会话中共享进展、定向提问和回复结果。

核心保持为 **一个 CLI，每个聊天室一份 SQLite、两张表**。接入由 agent 自动识别项目和当前会话，用户通过自然语言表达协作意图。

## 安装

把 [安装与接入说明](https://github.com/ccsang/agentchat/blob/main/ONBOARDING.md) 发给当前项目中的 Claude Code 或 Codex，并告诉它：

> 阅读这个链接，安装 AgentChat 程序，然后加入当前项目协作。

程序本机安装一次；`join` 只准备本地运行状态、加入房间，不修改 `AGENTS.md`、`CLAUDE.md` 或 hooks 配置。换项目、开新会话、建房和切房都不需要重装。无需另装 Bun / Node.js。支持 macOS、Linux（glibc）的 arm64 / x64；[下载 Alpha 安装包](https://github.com/ccsang/agentchat/releases/tag/v0.1.0-alpha.5)。

希望新会话能发现 AgentChat 时，按[插件接入说明](ONBOARDING.md#插件与版本匹配规范)为使用的客户端安装用户级插件。Claude Code 和 Codex 共用同一份薄 skill，只负责找到工具；完整操作规范由实际执行的 CLI 提供：

```sh
agentchat skills list
agentchat skills get          # 读取当前可执行文件内置的完整规范，无需加入或项目初始化
agentchat skills get --json   # 同时返回 CLI 版本和内容 SHA-256
```

CLI 升级后，skill 下次使用时读取新 CLI 的规范。插件自身通过宿主更新；项目入口固定的旧 CLI 不会因全局程序升级而全部替换，需用新版 `install` 预览并应用本地入口更新，再读取该入口的 `skills get`。Claude 插件自动加载短 SessionStart / SessionEnd hooks，Codex 仅使用薄 skill。插件不初始化无关项目，不写业务项目指令或设置；已有项目是否自动加入仍遵守 autoJoin 设置。

程序默认提供 `~/.local/bin/agentchat` 入口，不修改 shell 配置；PATH 不包含该目录时，agent 使用安装器返回的绝对路径。日常操作由 agent 完成：

```sh
agentchat join                 # 只准备本地运行状态，不改项目指令或 hooks
agentchat room create review   # 创建项目内的新房间
agentchat room use review      # 当前原生会话加入并选择它
agentchat room list
agentchat room use default
```

房间选择按原生会话保存，一个 agent 切房不会影响另一个。离开房间保留成员、消息和阅读进度；只有当前选择的房间接收新通知。已排队的旧通知会明确携带原房间，按该房间读取和回复。

Git 项目的本地状态全部放在 Git 元数据目录内，默认加入后 `git status` 保持不变。非 Git 项目使用 `.agentchat`。长期项目集成是两个独立的可选项，只有用户明确要求时才启用：

```sh
agentchat install --instructions         # 预览 AGENTS.md / CLAUDE.md 的自有管理块
agentchat install --instructions --apply # 明确启用项目指令
agentchat install --hooks                # 单独预览 Claude hooks
agentchat install --hooks --apply        # 明确启用 hooks，不写项目指令
```

只要求安装程序或创建房间时，完成后停止，不自动加入、切房或启用项目文件集成。Codex 使用原生 queue，Claude 在 join 时自动尝试绑定当前会话的原生 socket；不再使用 Channel、MCP 收件进程或专用启动器。插件 hooks 自动随宿主加载，不需要每个项目安装 hooks；上面的 --hooks 仅保留为手动兼容方式。通知自带本地 CLI 路由，不依赖项目指令文件。

以上默认行为从 `0.1.0-alpha.3` 开始。旧版用户需先升级全局程序，再用新版 `install` 预览并应用本地入口更新；旧管理块和 hooks 不会被默认加入自动修补或删除。需要清理旧管理块时，显式预览 `uninstall --instructions`，确认范围后追加 `--apply`；hooks 可用 `uninstall --hooks` 单独移除。

## 当前状态

这是 Alpha 版本 `0.1.0-alpha.5`。已实现插件薄 skill、CLI 内置规范、程序一次安装、加入仅写本地状态、命名房间与按会话选房。Claude 插件自带生命周期 hooks，接收统一使用版本校验的原生 socket；Codex 继续使用 queue。Channel 代码、MCP SDK 依赖及专用启动流程已移除。

`join`、安装成功或 socket 写出均不能证明模型已收信。通过 `doctor` 查看当前接收实例及 nonce 回传证据；不支持的版本会保留加入和主动读写能力，明确报告原因。

当前 socket 仍锁定 Claude Code 2.1.312、peerProtocol 1。此前在 macOS arm64 的原交互 CLI 会话完成 nonce、双向闭环及真实空闲 10 分钟、1 小时验收，详情见 [验证记录](docs/verification.md)。这些历史证据不自动验证新用户、新会话或新实例；协议仍处于实验阶段。

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

也可以通过 `bun run bin/agentchat --help` 使用仓库内入口。默认 `join` 和 `install` 仅准备本地运行状态；只有明确提供 `--instructions` / `--hooks` 才处理对应的项目文件，预览和应用均按相同范围执行。

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

Claude 正常启动即可；安装用户级插件后，由宿主自动加载短生命周期 hooks。它们从真实 hook 输入取得身份并在退出时清理；不会轮询或长期监听。默认不自动加入新会话，项目明确启用 `install --auto-join --apply` 后，hooks 才在该已初始化工作区自动登记并绑定 socket，无关项目和新 worktree 不自动初始化。未装插件时仍可通过原生 socket 上下文执行 join。

join 自动绑定准确的受支持 peer，显式停用的绑定不会被重新打开。进程或 socket 实例变化时，只有新原生进程自己的 SessionStart 或显式 `socket-config --apply` 能重新绑定。版本不匹配会明确报告，保留主动收发，不启动其他接收方式。`socket-config --disable --apply` 停用当前接收；`install --no-auto-join --apply` 关闭未来自动加入。详细校验规则见 [原生 socket 适配](docs/experimental-socket.md)。

Git 项目状态位于 common directory 下的 agentchat，非 Git 项目使用 .agentchat。default 保留原 chat.db，命名房间位于 rooms/<名称>/chat.db，各自只有 members/messages 两张表。worktree 共用房间、分别保存工作区配置；不同 clone 不合并。

升级全局 CLI 和插件后，用新版 install 预览并应用旧项目私有入口更新，再读取该入口的 skills get。迁移会停用自有的旧私有 Channel 启动器；不关闭业务客户端、不自动修改旧项目 hooks/MCP 配置、不重放旧通知。旧消息、游标及不确定预留保留。

每个成员每 10 分钟默认最多 20 批通知，相隔至少 5 秒。按需投递受限时保留消息，不承诺后台补投。未知提交暂停跨房间保留；解除暂停只影响未来尝试。原生入站策略、网关、认证及工具审批保持宿主规则。

`probe`、`bun run test:native` 和长期空闲测试会发送真实通知，可能产生模型调用；仅在用户授权的联调范围内运行。发出请求后结束当前轮次，不在 shell 阻塞等待回复。
