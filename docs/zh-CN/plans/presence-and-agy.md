# 在线状态、房间归属与 Antigravity CLI 方案

[English](../../plans/presence-and-agy.md) | 简体中文

状态：2026-11-12 已完成本地源码实现：M1 有作用域的只读在线/选房观测，M2 实例门控，M3 原生 agy 按轮 hooks 与显式房间迁移。Claude/agy 源码新 nonce 验收通过（agy 记录为 last_observed），最终原生 Claude 复审无阻塞问题。用户在插件 MCP 门槛失败后选择按轮收信、暂缓空闲唤醒；没有令牌落盘产品路径。改动未提交，未升级业务/全局入口，未发布 Alpha 14。见 [agy 源码指南](../antigravity.md)。

## 背景与约束

用户希望接入 Antigravity CLI，明确 Claude Code / Codex 关闭会话后的状态，并避免同目录多个任务、会话、聊天室相互混淆。agy 已安装为 1.5.6，官方更新器确认是最新版；现有 AgentChat 为 Alpha 13。三轮独立只读 Claude Code 评审之后，当前项目房间的原生 Claude Code 会话再次评审并同意了本方案。原生评审方确认了当前元数据字段名，没有执行生命周期或 agy 验收实验。

保持一个 TypeScript + Bun CLI，直接访问 SQLite，每个房间只有 members、messages 两张表。不增加服务端、daemon、模型心跳、轮询桥、HTTP 服务、PTY 包装、进程管理器或通用 agent runtime。参与者继续使用各自的原生会话和权限。程序按用户安装一次；默认 join 不修改项目指令、项目 hooks 副本或 Git exclude。项目运行入口与数据迁移明确预览、应用。保持原生 Claude 入站策略；本次讨论不授权更改该策略。

成员身份、房间选择、原生在线状态、通知提交、模型收信、任务完成是不同事实。保留准确原生身份、明确退出、接收停用、消息 ID / 历史 / 游标、限流、暂停和不确定预留。不重放不确定通知，也不切换适配器重试。peer 消息不是用户授权。新版宿主不能仅因版本更高而被拒绝，须检查实际能力与协议兼容性。

## 决策

### 1. 关闭原生会话不自动退出房间

保留成员与阅读位置，便于准确原会话恢复。明确 leave 是独立操作，启动、compact 和 autoJoin 不能撤销它。在线状态单独报告，不删除离线成员，也不把阅读游标当成存活时间。

### 2. 多房间沿用按原生会话选择的机制

一个任务使用一个命名房间，实现与评审会话分别加入；同目录不同任务使用不同房间。每个项目 / runtime / 原生会话只选择一个自动通知房间，不自动订阅曾经加入过的全部房间。

不同原生会话的选择独立。同一 Git common directory 下的 worktree 共享房间；相同 runtime / 会话在这些 worktree 中共享选择，不同 clone 相互隔离。worktree 的初始化选择仍独立。单次 read / send 的显式 --room 不改变所选房间。leave 只作用于当前房间，不是 leave-all。多任务接入应根据用户意图选择任务房间，不假设所有 agent 都应进入 default。

members 增加 `selected_room`、`selected_here`。前者是该成员所属原生会话当前选中的房间名或 null；后者表示是否选中正在查看的房间。有效的 left 成员必须为 `selected_here: false`。generic 成员没有原生选择，两字段均为 null，原因 `no_native_selection`。

读取其他会话的选择必须只读，不取排他锁。选择文件损坏或不可读时，该成员的选择字段为 null，并附脱敏错误，不猜 default，也不让整个成员列表失败。有效记录仍使用原有 joined / left 值；若同一损坏选择也导致成员身份无法判断，返回 `membership: null` 与明确错误，不伪报 joined。该局部展示降级不改变路由、写入时的严格校验。

保留 room list 已有的当前房间标记。暂缓房间人数 / 在线人数统计、跨房间订阅、未读角标和新的房间管理概念。generic 的 presence 为未知 / 手动状态，不把手动登记当成验证过的原生身份。

### 3. presence 是有作用域的观测，不是长期保证

members、doctor 增加 presence 对象，包含 `state: online/offline/unknown`、`observed_at`、来源 / 作用域、固定脱敏原因码。已有 reception 输出独立保留。当前观测时间不能替代历史事件时间。

M1 完全只读，使用已有绑定和原生元数据，不新增 presence 文件，不迁移 SQLite。观测器不读取或展示 `SessionState.active` 作为 presence；已有接收诊断仍是另一类事实。不能从 joined、最近消息、可继承环境变量、插件安装、queue 命令可用、queue 回执、旧 nonce、旧 active 标志或共享桌面进程仍活着推导在线。

Claude 使用目标 binding 所记录的元数据目录，不扫描调用者默认 CLAUDE_CONFIG_DIR 来下离线结论。新增专用、有界、只读的观测器，不复用 receiver / discoverPeer 及其协议、凭据资格检查。准确会话 / 进程实例唯一匹配且进程启动证据一致时，即使接收被停用或协议不兼容，也可以在限定本机作用域报告 online。

旧 PID 已死或被重用，只证明记录实例结束，不证明没有恢复的新实例。只有记录的作用域可信、进程明确不存在，且该 registry 完整可读、有界扫描后没有存活的替代匹配时，才允许 registry 作用域内的 offline。无 binding、扫描不完整 / 有歧义 / 无权限、进程检查超时或失败、作用域不明，均为 unknown。若无法安全完成这种负向推断，M1 保守报告 unknown。

当前 Codex 在准确 thread 信号通过验证前，报告 unknown，原因 `no_native_lifecycle_signal`；共享宿主 PID 不能证明某个 thread 在线。今后获得的历史生命周期也只能标注 last_observed。agy 在原生能力门槛通过前，不作为受支持的原生 runtime。generic 仅在用户另行明确要求手动模式时使用；缺少原生身份应报错，不自动回落。

只读取 `<metadataDir>/<pid>.json` 形式的 PID 元数据，显式排除 `.key` 等凭据文件，不打开或连接 socket。宿主提供的 status / statusUpdatedAt 仅可标为 `host_reported` 附加展示；语义尚未验证，不能单独决定在线状态。

online 要求 binding 与原生元数据的会话身份一致、PID 存活、实时进程启动证据一致，且检查目录中的目标会话匹配唯一。只有确认 PID 命名空间是当前本机空间时才比较；远程 / 容器空间无法可靠映射，或命名空间未知时，返回 unknown，不凭 pidDomain 名称猜测语义。

崩溃、强制退出后残留 JSON 不是存活证据。只知道记录实例结束时，返回 unknown，原因 `recorded_instance_ended`；只有同时满足完整 registry 条件才报告 offline。offline 的含义仅是所观测 registry 中没有该会话的存活实例，不代表会话不能恢复或其他配置中没有 Claude。

每次命令批量、去重进程观测，限制总耗时与输出量；总预算耗尽时为 unknown，原因 `observation_budget_exceeded`。不为每个历史成员单独启动进程，也不为每个成员遍历全部房间 DB。查询不创建文件、不取排他观测锁、不重绑接收器、不发送探针；不完整快照返回带可操作脱敏原因的 unknown。

使用受控只读目录、执行前后 mtime / 哈希快照，证明 runtime 目录、session 文件、宿主 registry、房间 DB 及 SQLite journal / WAL / SHM 均未变化。只读数据库访问也不能创建共享内存文件或触发 WAL 检查点。测试中须排除原生宿主自身并发更新造成的干扰。

### 4. M1 不改变投递行为

新增展示不抑制、提交、重试、预留、解除暂停、重绑或验证通知。保留现有 send、queue、socket、probe、nonce 语义，包括旧的退出前 socket 关闸逻辑。unknown 不抑制已有通知。验证原生收信仍要求准确会话 / adapter / 实例的新鲜回传，不能由新字段替代。

### 5. 生命周期接入与迟到 end 竞态单独处理

当前 endHook 没有比较进程实例或使用共享生命周期锁，就按房间写 active=false；不同房间的 SessionState 也可能分裂。这是代码阅读发现的风险，不代表已复现真实宿主事件顺序。实例隔离修复通过验证前，文档和 doctor 要解释：恢复后 inactive 可能来自迟到的旧 end；仅凭 inactive 标志不能断言原因。

先实测真实 startup / resume / compact / end 的身份、hook 信任、环境、父进程来源、启动时间与 socket 实例证据。end 必须携带或推导出与 start 相同的可信实例；只在 start 文件中生成随机 generation 不足以证明 end 归属。compact、插件 / 项目重复 start 对同一实例必须幂等。

原生实验记录 hook 的 ppid 链和启动证据，覆盖 /clear 是否换会话 ID、同 UUID resume、同 UUID 并发实例歧义、kill -9 无 end。只记录身份所需元数据，不记录凭据或无关命令参数。

投递修复将结束标记限定到可信接收实例，在所有相关 start / end / rebind / dispatch 写者共同遵守的 session 锁和锁顺序下，对权威当前 binding 比较更新。旧实例迟到 end 不能关闭新实例。保留已验证路径的退出前门控；无法证明归属的事件可在新的项目级 runtime / session 观测文件中标为 unresolved，不得被称为安全关闭当前绑定的依据。原生证据无法同时支持两项保证时，明确限制并推迟完整修复，不静默削弱门控。

若需共享观测文件，放在 integration 级，按 runtime / session 命名，不按房间复制，也不新增第三张表。旧 pinned 可执行文件 / hooks 仍是不遵守新锁的写者；宣称竞态受到保护前，必须协调升级所有相关入口。该投递语义改动与 M1 分开评审、测试。

### 6. agy 在迁移前先过原生能力门槛

在升级后的真实 1.5.6 CLI 中确认：

- hook 与后续工具 shell 均有准确会话身份，覆盖 resume、compact、/clear、子代理和并发对话；同一工作区两个 conversation 的工具调用必须获得不同且正确的身份，子代理不得按父身份 join。
- 原生进程 / 实例证据、多工作区路由与歧义处理。
- 原生 hook 的 JSON、输出和超时行为。
- 执行回合内注入简短通知，并取得新鲜关联回复。
- 单独验证 agentapi send-message 能否触达已打开、空闲的 CLI。官方 Sidecars 文档目前标为 App 能力，脚本或二进制符号不证明 CLI 可用。

提供 agy 薄插件，使用宿主自己的 manifest / hooks，完整规范仍由实际 CLI 的 skills get 提供。不照搬 Claude hook JSON，不把 agy Stop 当成进程退出。原生空闲唤醒不可用时，明确限制，不增加通用进程包装器。已验证的回合内注入标为 `turn_based`；doctor 在独立验证前给出 `idle_wake: unverified`。hook 返回 JSON、预留批次均不证明模型消费。身份缺失或冲突报 E_IDENTITY，不借用继承的 Claude / Codex 身份，也不猜最近会话。

真正接入 agy runtime 必须同时修改 TypeScript 和 SQLite 的 runtime 约束。身份门槛通过后，再实现显式的单房间迁移预览 / 应用；计划命令为 `agentchat migrate [--apply]`，沿用 project / room 路由参数。读取、默认安装、隐式 join 均不迁移。新 CLI 同时支持旧、新 schema。

preview 列出目标单房间、兼容影响，以及所有已知会参与该房间的 run 入口和已启用 AgentChat 托管 hook 引用的版本。未知版本明确标注，不执行任意 hook 命令来查版本。无引用的历史缓存不是参与入口；不能承诺发现所有旧进程或手动复制的工具。

发现已知参与入口低于所需 AgentChat 迁移版本时，apply 默认拒绝。只有显式 `--allow-old-pins` 选择才可覆盖兼容阻断，并说明旧工具会按其原有 E_SCHEMA 文本拒绝新 schema。优先升级已知参与入口和 hooks，不能静默选择覆盖。迁移只针对一个房间，不默认 migrate-all。

apply 使用一致备份、迁移锁 / 事务、外键验证和失败回滚，保持两表、原始 ID / 历史 / 游标 / 索引 / 不可变触发器 / 预留 / 暂停。旧二进制的错误文本不会因新版本而改善，升级要求由新工具的预览和文档说明。未明确请求 agy 支持时，现有与新建 v1 房间仍可供 Claude / Codex 使用，无需迁移。

## 实施顺序与验收

1. M1：只读在线观测与房间归属展示；英文主文档及中文翻译；不加状态 / schema，不改变投递。
2. M2：隔离验证原生生命周期，再在证据支持时单独评审并修复实例隔离 / 投递竞态，协调升级参与者入口。
3. M3：agy 原生身份、hook、唤醒实验，再接入薄插件 / runtime 和显式单房间迁移；空闲唤醒独立验收。

隔离测试须覆盖只读挂载及稳定 mtime / 哈希、排除凭据文件和 socket 连接、非本机 / 未知 PID 空间、命令总预算、逐成员选择读取失败且不伪报 membership、自定义目标 registry、准确存活实例、替代实例、PID 复用、元数据缺失 / 不完整 / 歧义、进程检查错误、查询零写入、Codex / generic unknown、通知结果不变、双会话双房间、相同会话共享 worktree 与独立 clone、明确 leave / resume、停用与不确定暂停。

后续阶段增加迟到旧 end、重复 start / compact、原生身份冲突、迁移回滚与数据保留，以及真实旧 pinned 二进制的兼容验收。迁移失败 / 中断后，旧工具必须仍能读写原库。

实现更改运行 bun run check、适当隔离测试和 bun run build。原生模型验收另行在授权测试范围内执行，记录新鲜 nonce、版本、准确会话证据；模拟宿主不能证明原生收信。本文不宣称任何原生测试已经通过。

## 一致意见的范围

原生 Claude 评审方明确表示无阻塞性反对，并同意上述修订。随后用户要求开始实现，本次改动尚未要求对外发布。真实生命周期与 agy 兼容性仍是后续验收门槛，不是设计评审已经证明的能力。
