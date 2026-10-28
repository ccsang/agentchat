# 验证记录

日期：2026-10-28。开发环境：macOS arm64、Bun 1.3.14。

## 当前版本：持续 Channel 接收

版本 `0.1.0-dev.1`。已实现默认单向 Channel、短生命周期登记 hooks、独立启动握手、准确原会话恢复入口、当前接收实例的 nonce 验证、滚动窗口限流、数据库忙退避、未知写入暂停和宿主不可用诊断。

当前自动化套件为 82 项，运行类型检查、完整测试及构建。覆盖初版存储与 Codex 通知行为，并新增：

- MCP 先于 SessionStart 初始化时等待准确绑定，不预留未绑定消息。
- 两个同时在线的 Claude 会话各收自己的定向通知，重复接收器拒绝接管。
- 错误会话、不同项目、复制到另一原生进程的有效配置、复制的启动上下文、已结束启动、SessionEnd、卸载及 SIGKILL。
- 旧 Hook 证据、前一 Channel 实例证据和当前验证相互隔离。
- 滚动窗口恢复、重启后保留预留、临时 SQLite 忙和提交结果不确定。
- 移除自己的旧 Stop hooks，保留用户 hooks；Bun 不在 PATH 时入口仍可运行。
- 原生宿主报告不可用后明确显示 blocked，不把连接或迟到的 nonce 当作接通。

加速时钟模拟空闲 10 分钟和 1 小时，只证明逻辑无总接收期限，不等同于真实长期验收。显式墙钟发布器和被动核对入口已准备；默认测试不向真实客户端发送通知。

### 本机真实 Channel 结果：未接通

用户已退出并通过生成的入口恢复原 Claude Code 2.1.312 会话。已观察到：准确 session_id 绑定成功，MCP 初始化完成，接收进程持续运行；宿主实际启动参数包含开发 Channel 标志和准确恢复参数。

仅发出一次真实探针：`probe-776ce768-a1d6-4060-8ae5-0e989a663dd3`，nonce 为 `9eb5c61a-8a1a-44d0-9879-89e59eefbc09`。Channel 已预留并写出通知，但原会话没有读取或回传该 nonce。没有换 ID 重发或清空预留。

用户从原生 `/status` 提供了明确结果：

> Channels: Configured but not active (not currently available): server:agentchat

同一状态页面显示使用自定义本地 Anthropic API 地址与 `ANTHROPIC_AUTH_TOKEN`，远程 managed settings 和组织策略未获取。仅凭这些事实不能断言网关就是唯一原因，也不能把它归类为管理员明确拒绝；可以确定当前宿主组合未启用 Channels，MCP connected 不代表可推送。

工具据这次用户观察登记当前启动为 blocked，停止后续通知并保留消息。没有修改用户的网关、认证、组织策略、审批设置或宿主功能开关，也没有切回限时 hooks。

因此当前 Channel nonce **未通过**，10 分钟和 1 小时的真实空闲测试 **未启动**。原生 socket 外部适配不在本轮实现范围。需要先取得支持 Channels 的原生启用条件，或另行选择接收适配方案，才能继续真实验收。

以下是旧版已完成的 hooks 验证，保留作历史记录，不能用于证明新版 Channel 接通。

## 初版 hooks 路径的自动化验证（历史）

运行 `bun run check`、`bun run build`、`bun test tests`。

完整自动化测试套件共 60 项，通过类型检查与构建。包含真实联调发现的长回合探针回传边界及其回归检查。

测试使用隔离的临时目录和伪造宿主可执行文件；不会向用户真实会话发消息。覆盖两张表的约束、并发写入、幂等、UTF-8 限额、分页、显式阅读游标、worktree/clone 项目边界、预算、通知不确定状态、hook 单例/超时、安装备份/回滚/卸载及单向 MCP 初始化。

MCP 协议测试仅证明消息能通过 SDK stdio，并未证明真实 Claude 账号已启用 Channels。

## 初版原生会话验证（历史）

| 组合 | 证据与当前状态 |
|---|---|
| Codex 0.165.0-alpha.1.2，Desktop 自带 CLI | 工具环境取得准确 CODEX_THREAD_ID；queue 返回匹配目标 thread 的消息 ID。实现轮次结束后，通知确实进入同一原会话，并在该宿主身份下回传 nonce；doctor 记录 verified 及首次回信时间。 |
| Claude Code 2.1.312，交互 CLI | 从自身上下文加入，Stop asyncRewake 监听取得通知并放入原会话队列；退出 /hooks 菜单后，原会话读取并回传正确 nonce。 |
| Claude Channels | 仅通过模拟 MCP 客户端验证；真实账号/组织策略和宿主环境继承尚未验收。 |
| Linux / Windows / IDE / 远程 app-server | 本次未进行真实宿主验收。自动接收首版限定 macOS/Linux 系统接口，Windows 不报告已支持。 |

Claude hook 探针 nonce 为 `a9669a92-b6af-401c-962e-0adb3e8c7442`，实际回传关联到原请求；消息、原生会话及通知批次详情保存在本机私有运行目录，不提交完整聊天记录。

Codex nonce 为 `09fc915b-b2c7-4268-882c-0c5c64e80ab7`。长实现轮次让最早探针在原生队列中等待超过 30 分钟，暴露了把探针校验误绑到通知 TTL 的问题。修复后仍校验原消息、原生会话和 nonce，并保留首次回信时间；重复发送不新建消息、不再次通知、不刷新证据时间。

真实联调中发现：本机 PATH 中的 Intel Git 在 Bun 子进程中可能超时，系统原生 Git 正常。已修复失败时错误选择非 Git 房间的行为，并加入回归测试；未经初始化的临时错误目录已归档，原消息库保持原位。

## 初版 hooks 路径双向闭环（历史）

`bun run test:native` 只在用户明确授权、Claude 已有活动接收器时运行。它不会创建新客户端或业务任务。`bun run verify:native` 只读取现有证据，不发通知。

已完成完整闭环，关联 nonce 为 `ba6ab49f-24ba-47ca-8713-397fc44636e4`：

1. Codex 原会话发送定向请求，Claude Stop asyncRewake 监听触发。
2. Claude 原会话读取请求，返回 `claude-ack`，并单独发送反向请求。
3. Codex 结束实现轮次，原生队列通知进入本会话；读取完整连续消息后，在同一宿主身份下回复 `codex-ack`。
4. Claude 再次通过活动监听接收回信，返回 `done`，最终确认不带 notify。
5. 被动验证器五个步骤全部为 true；Codex 读取并显式标记连续页面。后续重复通知不重复执行。

关联消息序号为 4、5、6、8、9。核对了原生通知、精确会话身份、随机值和消息回复关系，未仅以数据库有记录判断自动接收。
