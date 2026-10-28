# 验证记录

日期：2026-10-28。开发环境：macOS arm64、Bun 1.3.14。

## 自动化验证范围

运行 `bun run check`、`bun run build`、`bun test tests`。

现有 59 项自动化用例：完整运行通过原 58 项；新增 Channels 配置生成检查及其相关安装/通知回归共 30 项再次通过。类型检查与构建通过。

测试使用隔离的临时目录和伪造宿主可执行文件；不会向用户真实会话发消息。覆盖两张表的约束、并发写入、幂等、UTF-8 限额、分页、显式阅读游标、worktree/clone 项目边界、预算、通知不确定状态、hook 单例/超时、安装备份/回滚/卸载及单向 MCP 初始化。

MCP 协议测试仅证明消息能通过 SDK stdio，并未证明真实 Claude 账号已启用 Channels。

## 真实原生会话

| 组合 | 证据与当前状态 |
|---|---|
| Codex 0.165.0-alpha.1.2，Desktop 自带 CLI | 当前工具环境取得准确 CODEX_THREAD_ID；queue 返回匹配目标 thread 的消息 ID。当前轮次仍在运行，原会话消费队列后才能完成回传。 |
| Claude Code 2.1.312，交互 CLI | 从自身上下文加入，Stop asyncRewake 监听取得通知并放入原会话队列；退出 /hooks 菜单后，原会话读取并回传正确 nonce。 |
| Claude Channels | 仅通过模拟 MCP 客户端验证；真实账号/组织策略和宿主环境继承尚未验收。 |
| Linux / Windows / IDE / 远程 app-server | 本次未进行真实宿主验收。自动接收首版限定 macOS/Linux 系统接口，Windows 不报告已支持。 |

Claude hook 探针 nonce 为 `a9669a92-b6af-401c-962e-0adb3e8c7442`，实际回传关联到原请求；消息、原生会话及通知批次详情保存在本机私有运行目录，不提交完整聊天记录。

真实联调中发现：本机 PATH 中的 Intel Git 在 Bun 子进程中可能超时，系统原生 Git 正常。已修复失败时错误选择非 Git 房间的行为，并加入回归测试；未经初始化的临时错误目录已归档，原消息库保持原位。

## 双向闭环

`bun run test:native` 只在用户明确授权、Claude 已有活动接收器时运行。它不会创建新客户端或业务任务。`bun run verify:native` 只读取现有证据，不发通知。

完整闭环要求：Codex 请求、Claude 回信、Claude 独立请求、Codex 回信、Claude 最终无通知确认，并同时核对原生通知/会话证据。当前待原 Codex 会话结束实现轮次并消费队列；不得仅根据数据库记录将此项标记通过。
