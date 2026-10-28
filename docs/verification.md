# 验证记录

日期：2026-10-28。开发环境：macOS arm64、Bun 1.3.14。

## 自动化验证范围

运行 `bun run check`、`bun run build`、`bun test tests`。

完整自动化测试套件共 60 项，通过类型检查与构建。包含真实联调发现的长回合探针回传边界及其回归检查。

测试使用隔离的临时目录和伪造宿主可执行文件；不会向用户真实会话发消息。覆盖两张表的约束、并发写入、幂等、UTF-8 限额、分页、显式阅读游标、worktree/clone 项目边界、预算、通知不确定状态、hook 单例/超时、安装备份/回滚/卸载及单向 MCP 初始化。

MCP 协议测试仅证明消息能通过 SDK stdio，并未证明真实 Claude 账号已启用 Channels。

## 真实原生会话

| 组合 | 证据与当前状态 |
|---|---|
| Codex 0.165.0-alpha.1.2，Desktop 自带 CLI | 工具环境取得准确 CODEX_THREAD_ID；queue 返回匹配目标 thread 的消息 ID。实现轮次结束后，通知确实进入同一原会话，并在该宿主身份下回传 nonce；doctor 记录 verified 及首次回信时间。 |
| Claude Code 2.1.312，交互 CLI | 从自身上下文加入，Stop asyncRewake 监听取得通知并放入原会话队列；退出 /hooks 菜单后，原会话读取并回传正确 nonce。 |
| Claude Channels | 仅通过模拟 MCP 客户端验证；真实账号/组织策略和宿主环境继承尚未验收。 |
| Linux / Windows / IDE / 远程 app-server | 本次未进行真实宿主验收。自动接收首版限定 macOS/Linux 系统接口，Windows 不报告已支持。 |

Claude hook 探针 nonce 为 `a9669a92-b6af-401c-962e-0adb3e8c7442`，实际回传关联到原请求；消息、原生会话及通知批次详情保存在本机私有运行目录，不提交完整聊天记录。

Codex nonce 为 `09fc915b-b2c7-4268-882c-0c5c64e80ab7`。长实现轮次让最早探针在原生队列中等待超过 30 分钟，暴露了把探针校验误绑到通知 TTL 的问题。修复后仍校验原消息、原生会话和 nonce，并保留首次回信时间；重复发送不新建消息、不再次通知、不刷新证据时间。

真实联调中发现：本机 PATH 中的 Intel Git 在 Bun 子进程中可能超时，系统原生 Git 正常。已修复失败时错误选择非 Git 房间的行为，并加入回归测试；未经初始化的临时错误目录已归档，原消息库保持原位。

## 双向闭环

`bun run test:native` 只在用户明确授权、Claude 已有活动接收器时运行。它不会创建新客户端或业务任务。`bun run verify:native` 只读取现有证据，不发通知。

已完成完整闭环，关联 nonce 为 `ba6ab49f-24ba-47ca-8713-397fc44636e4`：

1. Codex 原会话发送定向请求，Claude Stop asyncRewake 监听触发。
2. Claude 原会话读取请求，返回 `claude-ack`，并单独发送反向请求。
3. Codex 结束实现轮次，原生队列通知进入本会话；读取完整连续消息后，在同一宿主身份下回复 `codex-ack`。
4. Claude 再次通过活动监听接收回信，返回 `done`，最终确认不带 notify。
5. 被动验证器五个步骤全部为 true；Codex 读取并显式标记连续页面。后续重复通知不重复执行。

关联消息序号为 4、5、6、8、9。核对了原生通知、精确会话身份、随机值和消息回复关系，未仅以数据库有记录判断自动接收。
