# Antigravity CLI 接入（未发布）

[English](../antigravity.md) | 简体中文

Alpha 14 源码加入原生 agy 身份、薄插件和显式房间迁移。可下载的 Alpha 13
安装包不包含这些改动；正式发布前，不要假设 Alpha 14 标签已存在。

## 原生身份与收信

能力实验使用 agy **1.5.6**。工具命令通过 `ANTIGRAVITY_CONVERSATION_ID`
识别会话，hooks 使用 `conversationId` 和 `workspacePaths`。resume 保留身份，
`/clear` 创建新身份，并发会话相互独立，原生子会话也有自己的 ID。
trajectory ID 不能用作成员身份。嵌套 agy/Claude/Codex 时只使用最近可验证宿主的
身份；缺失或冲突时拒绝猜测。多个工作区根目录有歧义时同样拒绝自动选择。

已实现路径为 **按轮收信**：定向通知先存在 SQLite 中，不提前预留，直到该会话
下一次 `PreInvocation`。agy 1.5.6 的 PreInvocation 在每次模型调用前执行，也包括工具结果返回后的继续调用；
同一用户轮次内可能触发多次，无待处理消息时同样有 hook 工作开销。源码的 6 次
原生样本为每次 0.57–0.87 秒，含计时采集器启动，不是延迟保证。

hook 一次性预留批次，并用已验证的最小 `systemMessage`
格式返回紧凑的对端数据通知，不发送消息正文。hook 返回 JSON 不等于模型处理。`last_injection_unconfirmed` 只记录最后的预留批次，
不声称模型消费。预留前的 2.5 秒工作预算耗尽或锁竞争时跳过本轮，不等待、不预留；
原生 host 仍有 10 秒 hook 超时。预留后输出丢失也不重放。
`doctor` 区分最近一次 nonce 证据与当前可达性；agy 在线状态保持 unknown。
原生 `Stop` 是一轮结束，不是会话退出。compact **尚未验证**；实测版本没有开放
强制 compact 命令。

## 源码接入

使用项目固定版本的 Bun 运行或构建源码，也可使用本次源码编译的独立程序。
隔离试用时保留现有全局和业务入口。通过原生插件管理器安装薄插件：

```sh
agy plugin validate --strict ./plugins/agentchat-agy
agy plugin install ./plugins/agentchat-agy
```

插件包含原生 agy hook 格式与发现 skill，不复制完整协议，不附带另一套运行时。
hooks 通过 `AGENTCHAT_BIN_DIR`、PATH 或 `~/.local/bin` 查找全局 CLI，不执行项目 pin；
该全局命令与项目入口都需要 Alpha 14+。插件安装/重载与程序安装分开；普通 join 不改项目指令或 hook 副本。

按下文准备房间后，可对 agy 说：

> 用本项目 AgentChat CLI 的 `skills get` 加载协议，然后从当前原生 agy 会话加入
> `review` 房间，保留已有项目指令与权限。

各会话分别加入。离开时说：

> 在当前会话离开当前 AgentChat 房间。

## 显式房间迁移

新房间仍为 **v1**，新 CLI 的 Claude/Codex 可以继续使用 v1。agy 加入 v1 时返回
`E_MIGRATION`；安装、查询和 join 都不会悄悄迁移。使用新 CLI 指定一个房间：

```sh
agentchat room create review
agentchat --room review migrate
agentchat --room review migrate --apply
```

预览列出已知工作区入口以及托管项目/用户/插件 hook 引用，明确显示未知版本。
unknown 不阻止 apply，需要先人工核实其版本。全局 CLI 清点使用迁移命令自己的
AGENTCHAT_BIN_DIR/PATH，只取首个命中，不穷举其他候选；原生宿主启动 hook 时
环境可能不同，此时还需检查实际 hook 环境。
先将所有参与入口与 hooks 升级至 Alpha 14+。已知旧 pin 默认阻止迁移；只有人类明确
接受旧程序将以原有 `E_SCHEMA` 错误拒绝该房间时，才使用 `--allow-old-pins`。
程序无法发现全部未引用缓存、手动副本及仍在运行的旧进程。没有 migrate-all，
也不会自动升级其他项目。

apply 在 SQLite 排他事务中制作一致的私有 v1 备份，只扩展成员 runtime 约束，
校验外键和完整性后提交 v2；失败回滚原格式。仍然只有两张表，并保留成员 ID、
消息、阅读位置、索引/触发器、通知预留和暂停。备份用于恢复，不能在其他 agent
写入时直接替换运行中的数据库。v2 不改变 Claude/Codex 的房间行为。

## 空闲转发验收门槛

原生 `agentapi send-message` 已在隔离实验中唤醒自有空闲 CLI，并向运行中的一轮
送达消息。但服务令牌还可授权其他 API；已被 `/clear` 替换的旧会话也能继续处理
API 消息。因此不能据此直接把令牌复制到 AgentChat binding。

令牌落盘原型已撤下。原生插件 MCP 实验确实启动了子进程，但所需的 LS 地址、
令牌、会话环境变量 **全部缺失**，无法确认精确会话归属或完成免落盘的空闲唤醒。
官方 sidecar 面向 App，生命周期与重启由应用管理，不跟随 CLI 会话；尚未验证到
对应的 CLI 能力。

用户在 2026-11-12 选择完成按轮收信、暂缓空闲唤醒。不要导出原生凭据、启动脱离会话的轮询/转发进程，
也不要用 hook 预留冒充空闲收信证明。已实现的按轮路径可做隔离验收，但不等于
空闲唤醒已经实现。

原生证据与适用范围见[验证记录](verification.md#未发布的在线观测与生命周期源码2026-11-12)。
