[English](../../docs/design.md) | 简体中文

# AgentChat Lite v0.1 设计基线

当前实现以最后的 Alpha 10 修订为准：Claude 插件自动加载生命周期 hooks，原生 socket 为唯一 Claude 接收路径，Channel 章节仅作历史设计。

本设计归纳自“设计本地通信方案”对话。以“agent 自助接入”和“Claude 持续接收”的修订覆盖此前手动接入及限时 hook 接收步骤；重型 AgentBus 方案和要求用户维持 Codex 轮询桥的版本不作为实现基线。

当前已有开发实现。本文是实现基线，具体自动化检查和原生客户端验证范围见 verification.md。

## 1. 产品范围与可靠性

同机、同一操作系统用户下，几个互信 coding agent 继续使用各自原生会话，通过项目聊天室共享消息、定向提问、回复与交接。

用户首次提供安装入口，之后用自然语言表达“加入当前项目协作”或“请 Claude 审查这次修改”。自动识别与参数配置由确定性程序承担。

可靠性承诺限定为消息持久保存、通知尽力而为。通知提交不证明进入模型，阅读游标不证明理解或执行，消息去重不保证业务副作用恰好发生一次。

首版不引入业务 daemon、HTTP API、任务/回执/产物实体、自动分工、客户端进程管理或完整聊天同步。消息中转留在本机，模型推理仍遵守原宿主的数据传输方式。

## 2. 核心架构

```text
Codex / Claude / 其他 agent
           │ 原生 shell
           ▼
      agentchat CLI
           │ 直接访问
           ▼
       项目 chat.db
           │
           ├─ Codex：发送方按需调用 codex queue
           └─ Claude：单向 Channel；显式实验可直接通知原生 socket
```

采用 TypeScript + Bun + bun:sqlite。CLI、安装器及适配脚本放在一个 package 中，只复用必要的存储和通知函数。

普通收发无需后台服务。Claude 的监听或 Channel 可以是有生命周期的会话子进程；不能因此把“无业务 daemon”宣传为“自动接收无需任何存活进程”。

## 3. 自动发现与身份

- 从当前 Git 仓库确定项目；同一仓库的 worktree 通过规范化 Git common directory 定位同一聊天室。
- 不同 clone 不因远程地址或目录名相同自动合并；实现需覆盖主工作区、linked worktree、路径符号链接及非 Git 目录。
- Git 项目使用 common directory 内的 agentchat/chat.db；非 Git 项目使用根目录 .agentchat/chat.db。Git 超时或失败必须报错，不能把已有 Git 项目降级成另一非 Git 房间。macOS arm64 的只读元数据查询优先使用系统原生 Git，避免 PATH 中 Intel Git 的兼容问题。
- 非 Git 目录以规范化项目根为边界；无法确定项目时报告需要上下文，不扫描整个用户目录。
- Codex 从宿主提供的 CODEX_THREAD_ID 取得身份；Claude 从 hook 输入取得 session_id。均需校验格式和来源，不推断最近会话。
- 一个原生会话对应一个 member ID，名称只是展示及精确查找。项目、宿主和会话组成幂等登记键；同名不能静默改绑。
- 同一原生会话可通过明确的 join --name 改名；成员 ID、阅读位置和通知预算保持不变。
- 不建设全局“当前 agent”。每次工具调用根据当前宿主上下文解析身份，不能依赖上次 shell 中 export 的变量。
- 自动接入不默认包含子 agent 或临时测试进程；项目自动加入是显式启用的产品选项。

这些绑定减少误投，但不构成针对同用户恶意进程的身份认证边界。

聊天室物理位置由项目发现与房间选择组件统一返回。首次 join 可创建默认房间，命名房间仅由 room create 显式创建；加入不存在的命名房间报错。数据库及 journal 必须位于双方获准访问的同一个本地目录，运行数据不提交 Git。

## 4. 两张表

### members

| 字段 | 含义 |
|---|---|
| id | 稳定成员 ID |
| name | 房间内唯一显示名称 |
| runtime | generic / codex / claude |
| session_ref | 原生会话 ID；generic 可为空 |
| read_seq | 已显式标记的阅读位置 |
| created_at | 创建时间 |

对非空原生身份约束 runtime + session_ref 唯一。自动登记生成名称时仍需处理冲突，不以名称作为幂等键。

### messages

| 字段 | 含义 |
|---|---|
| seq / id | 房间内顺序号与稳定消息 ID |
| from_id / to_id | 发件成员与点名成员；to 为空表示共享记录 |
| reply_to | 被回复消息的 ID |
| body | 正文，最多 8 KiB UTF-8 |
| notify | 是否显式请求通知 |
| notify_batch_id / notify_claimed_at | 通知尝试预留；不代表送达 |
| created_at | 创建时间 |

成员和消息关系使用外键。正文、路由和回复对象在同一事务提交；提交后的内容不可修改，纠错通过新消息表达。仅通知预留字段允许按算法更新。

首版初始化 journal_mode=DELETE；每个连接设置 foreign_keys=ON、busy_timeout=3000、synchronous=FULL。采用短同步事务，宿主进程调用、stdin 读取和输出均在事务外。数据库忙需要明确报错。

目录按 0700、数据库及相关文件按仅当前用户可读写创建；不能依赖调用方的宽松 umask。对既有目录的权限问题明确诊断，不通过关闭宿主隔离解决。

## 5. 四个日常操作

### join

无须用户提供 room、member 或 UUID。发现项目和可信宿主上下文后幂等登记，返回 member、room、已登记成员和接收能力；身份缺失时明确失败。

### members

列出登记事实，使用 ID 或精确名称寻址。没有证据时不标记在线、空闲或执行中。

### send

支持点名、共享进展和 reply-to。回复自动指向原发件人；显式目标与父消息冲突时拒绝。to 只是点名，同房间成员可读取全部历史。

显式 notify 必须有目标，禁止给自己通知。广播、进展、确认与致谢默认不通知；有内容的结果也只有显式请求时才通知。

可选稳定 ID 提供发送幂等：同 ID 与相同语义返回原消息；发送者、目标、父消息、正文或 notify 不同则 E_CONFLICT。未提供 ID 时随机生成，不承诺自然语言请求去重。

### read

支持新消息、after 分页、按 ID 查历史和显式 mark。普通读取完全只读；mark 只向前移动到有效序号。

完整房间使用一个顺序流，不对收件人过滤后推进同一全局游标。分页 next_cursor 为本页实际返回的最后序号，不能取房间最大序号；按 ID 查看不推进游标。默认每页 20 条、最多 100 条，并限制编码后响应大小，只在完整消息边界分页。

## 6. 通知语义

通知只含本地生成的成员 ID、消息 ID 和读取提示，不拼入对方业务正文。原生接口通过 argv 数组调用，不把消息交给 shell 解释。

通知选择、合并、预算和预留复用一个存储函数：BEGIN IMMEDIATE 内检查候选、预算及间隔，预留批次后提交，在事务外通知宿主。

默认限制：每个 member 在滚动 600 秒窗口内最多 20 批、批次至少间隔 5 秒、每批最多 20 条、仅自动通知最近 30 分钟消息。使用已持久化的不同批次及预留时间计算窗口，重启不清零，时间经过后自然释放额度，不删除或重置旧预留。旧版累计预算配置迁移为相同批次数的滚动窗口；默认 600 秒，可显式配置 5–86400 秒。参数不能宣传为 token 或费用硬上限。

限流返回明确原因、已用批次和最早重试时间。Claude Channel 继续存活，窗口恢复后可处理仍在 TTL 内且未预留的消息；Codex 仍为按需通知，不因此增加轮询桥。

预留先于宿主 I/O：崩溃可能漏掉通知，但同一条消息不自动反复通知。超时、非零退出或提交结果不确定时保留预留、暂停并报告，不自动切换通道。读取原消息是恢复入口，不新建 ID 重发请求。

Codex 直接通知若触发间隔限制，本次只存消息并报告通知被暂缓；没有后台桥时不承诺自动延时补发。已有批次预留不因重新 join 或名称修改清空。

### Codex

发送后按需调用准确 thread UUID 的 codex queue；不要求用户运行单独轮询桥。不使用最近会话、不使用 exec 降级、不模拟按键，也不自动启动关闭的客户端。CLI、Desktop、IDE 和远程 app-server 的兼容性分别记录。

### Claude

用户明确启用可选 hooks 和宿主功能后，使用由 Claude 启动并通过 stdio 连接的单向 Channel，持续检查明确发给自己的通知候选，空闲约每秒查询一次，不调用模型。默认 join 不启用它。读取和回复仍走 CLI，不另建 MCP 收发工具，不声明权限批准转发。stdout 专用于 MCP，诊断写 stderr。

SessionStart / SessionEnd 只登记和清理原生身份。显式管理 hooks 时移除自己的 Stop asyncRewake 长监听，保留其他 hooks；已经加载的旧 `hook wait` 入口返回正常退出，不与 Channel 竞争、不消耗通知额度。没有 300 秒收件窗口或用户续期操作。

#### 启动与会话绑定

安装器准备固定解释器的私有 `run` 和通用 Claude 启动入口。原 Claude agent 或获授权的协作方调用 `channel-config --apply`，生成确切已登记成员的恢复入口。用户退出原客户端后主动执行它，由真实 CLI `--resume` 恢复同一会话。工具不会从 agent shell 另开嵌套业务会话。

每次启动生成独立随机启动标识和 token，私有文件记录预期会话、项目和实际 Claude 版本。启动器从 spawn 返回值登记确切客户端 PID，hook 和 Channel 均校验自己的直接父进程与之相同，复制仍有效的 MCP 配置到另一客户端也不能冒用原绑定。启动器持有内核锁，随 Claude 客户端生命周期释放；配置只给 MCP 传启动上下文，不伪造原生会话环境变量。SessionStart 从宿主输入获得真实 `session_id`，校验项目和预期会话，完成成员登记后才发布绑定。Channel 可以先完成 MCP 初始化，再等待这次绑定；初始化/绑定最多等待 120 秒，这不是会话接收期限。

多个启动各自绑定；旧配置、错误 token、不同项目、已退出的启动器或不同原生会话全部拒绝。`/clear` 或会话切换不能接管旧绑定，需重新从入口启动。通用入口仅在用户主动使用时开始新的协作会话。启动器不成为通用进程管理器。

自定义 Channels 仍遵守交互启用、预览、账号、组织策略和协议版本限制。启动或恢复时可能需要宿主确认，不能承诺只确认一次，也不能靠写配置完成任意现有会话的热接入。Channel MCP 连接成功仍不证明事件会进入模型。

#### 存活、验证与故障

每个原生会话最多一个接收器，由内核锁防止重复进程。Channel 运行时续写 30 秒本地存活租约；它不发送模型心跳、不设置总运行时长。SIGKILL 释放锁，即使文件还在也不能冒称在线。SessionEnd、stdio 断开或卸载会清理接收状态。

当前自动接收验证必须匹配原生会话、`claude-channel` 适配器、启动标识和具体接收进程 token。旧 Hook 或先前进程的 nonce 只保留为历史。延迟的旧实例回信不验证新实例。通知写出后没有宿主处理回执，必须取得准确原会话的 nonce 回复，才标为当前 Channel verified。

`doctor` 分开报告进程存活、当前验证、历史证据及通知状态：`inactive`、`armed_unverified`、`verified`、`rate_limited`、`paused`、`degraded`、`blocked`。预算等待不伪装成健康接收；限流可自然恢复。SQLite 忙按 250ms 起步、最高 5 秒退避，成功后恢复。其他永久故障退出并记录原因；无法确定是否写出的通知保留预留并暂停，不重试旧通知或切换适配器。处理故障期间消息保留，可主动读取。原生 `/status` 明确报告 Channel 不可用时，可将确切启动记为 blocked 并暂停通知；诊断注明这是用户观察到的宿主状态，不假装自动探测到。新的启动不继承旧启动的不可用结论，未知写入的暂停仍持续保留。

宿主繁忙时事件由宿主排队；交互菜单也可能暂缓消费。工具不强行打断当前工具执行，不把通知写出当作处理证据。

## 7. 安装与用户体验

ONBOARDING.md 面向 agent。安装程序只准备本机可复用的工具；默认 join/install 只准备本地运行状态。项目文件集成必须通过独立的 --instructions / --hooks 显式选择，提供预览、备份、幂等更新和卸载，只管理自己的块，保留用户内容。

默认在用户提出协作需求时接入；不让用户记复杂命令，不把第一次提供安装入口省略为“天然知道工具”。项目开启自动加入后才为新的主会话自动登记。

接入报告区分“已加入可主动收发”“自动接收已验证”“需要宿主操作”。只有目标原会话回传 nonce 才能称自动接收已验证；连接或当前接收进程失效后相应能力失效。

通知 TTL 仅限制新的通知尝试，不使已排入原会话的探针失效。长回合结束后回传的 nonce 仍须匹配原消息、准确会话和当前宿主身份；幂等重试保留首次回信时间，不把旧证据刷新成新的在线证明。

## 8. 协作与交接

请求写清目标、输入、约束和期望输出。发请求后结束当前轮次，避免 shell 阻塞等待与宿主队列互相等待。阅读游标不是任务状态。

长报告放在双方已获准访问的目录，消息携带摘要及路径；固定内容时记录哈希，路径本身不证明快照不变。

交接包含仓库/worktree、基线与当前 commit、staged/unstaged patch、未跟踪文件、实际测试结果、剩余事项与操作边界。通信不代替代码隔离或执行权移交。

## 9. 实施时需重新核对的官方接口

- Git 项目与 worktree 发现：<https://git-scm.com/docs/git-rev-parse>
- Codex queue：<https://learn.chatgpt.com/docs/cli/reference>
- Claude hook、session_id、asyncRewake 与 timeout：<https://code.claude.com/docs/en/hooks>
- Claude Channels：<https://code.claude.com/docs/en/channels-reference>

资料中的能力描述必须通过当前安装版本与真实会话验证；这份设计不继承其他对话附件中的测试结论。

## 10. 持续接收验收

先做真实 Channel nonce，再分别完成空闲 10 分钟和 1 小时的原会话请求/结果回传。两次顺序运行，第二次从第一轮结束后重新计时。机器和会话保持运行，用户不再输入，不用假业务消息或模型心跳维持接收。

显式的本地测试发布器只计时、检查接收实例未变且期间无 Claude 项目发言，到期发一次请求后退出。它不等待回复；Claude 的结果通知唤醒原 Codex 做被动核对，最终不再相互确认。数据相关性仍需与原生通知和无用户输入的会话证据一起阅读。

加速时钟覆盖 10 分钟/1 小时逻辑、限流及恢复，仅算自动化覆盖，不计作真实持续验收。原生 socket 的外部客户端适配由用户明确选择后作为实验提供，保持单独绑定、验证证据和版本锁定，不自动替代 Channel；详见 experimental-socket.md。

## 11. 已授权的原生 socket 实验

当前网关组合的 Channel 不可用，用户明确选择保留网关并开发原生 socket 适配。此选择不改变入站策略、模型认证或工具审批，也不授权重发已预留通知。

发送方根据已登记 Claude 成员的准确 UUID，在本机原生 peer 元数据中寻找唯一有效实例。校验所属项目 common-dir、PID 的 UTC 起始时间、已核对版本与协议、CLI 会话类型、socket inode 与权限。两个有效进程同时声明同一个 UUID 时拒绝歧义；不同项目、已结束进程、新版本或替换 socket 不接管旧绑定。

绑定存于独立的项目私有文件，避免与旧 Channel 的存活信息互相覆盖。当前实验仅允许 2.1.312 / peerProtocol 1；凭据每次从确切 peer 的 owner-only 文件读取，不进入绑定、日志或数据库。它使用 peerToken，不使用 native childToken，不提供虚构的回复 socket 或发送方权限等级。

在独占通知锁内验证并连接目标后，短事务预留通知；事务外发送 NDJSON auth 和 next-priority user 通知，写出后再次核对实例。连接前的确定失败不消耗预留；开始提交后的错误、超时或实例变化均保守记为 unknown 并暂停，不重试、不切通道。Native hold/refuse 可能使已写出帧没有模型响应，必须以准确实例下的 nonce 回复验证。

无额外监听器、HTTP 端口或业务 daemon。原生 Claude 自己持有收件箱，没有收件期限或模型心跳。Codex 和 socket 路径都是按需投递；若被时间窗口暂缓，本次保持持久消息并报告 held，不许把后台自动补投写进承诺。

socket 的验证证据按具体进程/socket 实例存放。CLI 回传同时要求真实宿主身份与 CLAUDE_CODE_MESSAGING_SOCKET 匹配，旧 Channel nonce 或另一接收实例的回信不能验证当前适配。实验停用或项目卸载后不再通知，历史仍保留。

长期验收除核对项目消息外，还比较锁定版本 peer 元数据的 idle 状态及更新时间。中途出现原生活动、进程变化或接收故障就停止并通知原 Codex，不能报告通过。计时器只在到期时发送一次真实请求，收到结果后由原 Codex 主动继续核对。

## 12. 程序、项目和聊天室分离（Alpha 2）

本节覆盖此前每项目手动安装、单一聊天室的交互。全局程序只安装一次，固定版本二进制缓存由多个项目共用，`~/.local/bin/agentchat` 是自己的命令入口；安装程序不更改项目。

Alpha 2 的 `join` 在验证原生身份和目标房间后自动初始化管理块、hooks 与启动入口。该项目文件写入行为已由下节 Alpha 3 覆盖。工作区安装元数据按项目根目录保存，同一仓库的 worktree 各有自己的运行状态，共用房间；消息库原位保留。

集成目录仍为 common-dir/agentchat 或非 Git 项目的 .agentchat。default 的 SQLite 路径不变，命名房间位于 rooms/<名称>/chat.db。每库仍只有 members/messages 两张表，独立成员 ID、消息 ID、游标、预算和通知预留；没有新增业务实体或常驻服务。

房间名称是受限的逻辑名称，不接受越出本项目的路径。room create 只创建房间数据，room list/current 只读；room use 与 join --room 加入已有房间并保存本原生会话的选择。选择文件按 runtime + 原生 UUID 隔离，不设项目全局的“当前 agent”。未选房间暂停新的自动通知，消息保留。显式 --room 只为一次命令路由，迟到通知必须用原房间读取和回复。

一个物理 Channel 由项目内原生 UUID 锁唯一拥有。它根据自己的选择文件切换 SQLite 和房间成员锁，清理旧房间存活信息，保留消息预留和证明；进程 token/启动握手仍属于原客户端。旧版活跃 Channel 无法观察选择时拒绝切房，要求通过新版入口恢复，不能把切房当成自动启动另一客户端。

socket 端点按项目原生会话复用此前的明确选择，凭据不复制进配置；每个房间的 nonce 证明仍单独关联该房间消息。旧版默认房间绑定按准确 session 读取兼容，不复制历史 nonce。未知通知暂停按原生会话及适配器跨房间生效，解除只影响未来通知，旧预留不变。peer 的已验证项目目录参与缓存校验，复制绑定到另一个项目不能借已保存 cwd 跳过项目检查。

## 13. 默认加入仅准备本地状态（Alpha 3）

`join`、`room use` 和不带集成标志的 `install` 不读取或改写 AGENTS.md、CLAUDE.md、.claude/settings.local.json 或 Git exclude。即使这些文件已入库、存在旧管理块、是符号链接或 JSON 已损坏，默认加入也只在 Git 元数据目录的 agentchat 中准备运行文件和数据；非 Git 项目使用 .agentchat。新建或切换房间仍不重新安装程序。

`install --instructions` 只管理两个指令文件；`install --hooks` 只管理 Claude 本地设置及 Git 本地忽略块。两者均先预览，--apply 才应用，可独立组合。安装元数据使用 setupVersion 3 和工作区独立的 integration 标志，不把另一个 worktree 的选择当作本工作区的授权。后续默认加入不以指令或 hooks 文件存在为前提，也不隐式修复已明确启用的集成。

`uninstall --instructions` / `uninstall --hooks` 只移除指定集成并保留本地运行能力，移除 hooks 后新版 Channel 停止。无标志的 uninstall 停用当前工作区并移除其已启用的自有集成，保留消息与全局程序。旧客户端已经加载的配置可能需要用户重新加载；工具不关闭业务会话。

升级旧项目时仅更新私有运行入口和安装元数据，保留旧管理块和 hooks，不自动修补或删除。需要清理或升级旧集成时，必须显式选择相应标志。安全默认从 0.1.0-alpha.3 开始；必须先升级全局程序，再用新版 join 刷新旧项目入口，不能用新文档推定旧二进制的行为。

通知自身携带准确 CLI argv、项目、房间和消息 ID，接收方不依赖业务项目存在 ONBOARDING.md 或指令管理块。Codex queue 和已明确启用的 socket 实验不以项目指令或 hooks 为前提；Channel 的准确会话绑定仍需明确启用 hooks 及宿主功能。自动接收仍以当前接收实例的 nonce 回传为准。

## 14. 插件薄 skill 与 CLI 内置规范（Alpha 4）

仓库为 Claude 和 Codex 分别提供 marketplace，均引用 plugins/agentchat。插件共享一份 skills/agentchat/SKILL.md，仅负责识别本地协作意图、查找确切 CLI 和加载其规范；不保存项目路径、身份或房间，不执行安装 hooks，不自动注册业务会话。插件建议按用户级安装，由各宿主管理生命周期；CLI 安装器仍只安装程序。

完整操作规范位于 src/skills/agentchat.md，通过文本导入编译进源码 bundle 和独立二进制。skills get [agentchat] 直接返回当前二进制的完整 Markdown；--json 包含名称、CLI 版本、内容和 SHA-256。skills list 返回可用规范。两者在项目发现/身份解析前返回，不初始化项目、读业务配置或联网；未知名称和无效参数明确报错。

优先选择通知 Tool argv 或当前项目自己的私有 run，其次全局 CLI；用哪一个执行工作，就读取哪一个的 skills get。切换或升级后重新加载。旧 CLI 无此能力时通过 ONBOARDING 准备新版程序，并在授权升级范围内用新版 install 预览/应用私有入口更新，再读取更新后的入口。全局程序升级不自动替换所有项目的固定版本，不能把新版规范套给旧入口。

薄 skill 与完整规范分别更新：操作规范随 CLI 发布，薄 skill 只有触发和发现流程变化时才更新插件，不覆盖宿主插件缓存。便携 manifest 与两个宿主兼容 manifest 保持同一插件身份/版本；插件版本不要求与每次 CLI 版本同步。接收适配、两张表和原生验证边界不变。

## 15. 插件生命周期 hooks 与移除 Channel（Alpha 5）

用户明确要求 hooks 自动加载，并停止使用不可用的 Channel。本节覆盖此前的 Channel、MCP 握手、专用启动入口及 socket 单独选择流程；核心仍为一个 CLI、每房间 SQLite 和两张表，Codex queue 不变。

Claude manifest 引用插件内的 hooks/claude-hooks.json，仅包含 SessionStart 和 SessionEnd。使用非默认文件名并只在 Claude manifest 声明，Codex manifest 不引用、插件也不提供默认 hooks/hooks.json，避免 Codex 意外执行 Claude hook。sh 包装脚本定位已安装 CLI 并原样转发 stdin，无下载、外部 Bun/Node、常驻监听或模型调用。CLI 安装器仍只安装程序，插件安装/更新由宿主管理。

SessionStart 采用真实 hook cwd/session_id，向宿主私有 CLAUDE_ENV_FILE 写入准确身份；不在业务目录落身份文件。插件不初始化无关项目或未初始化 worktree，只有本工作区安装元数据有效且 autoJoin 开启时才登记成员并尝试绑定。autoJoin 默认关闭，保留显式停用。SessionEnd 清理准确主会话在各房间的 active 状态，阻止进程退出前继续投递；子 agent 不登记主身份。

join 自动尝试准确原生 socket 绑定，不要求项目 hooks 或指令文件。保留 2.1.312 / peerProtocol 1、进程起始时间、唯一 UUID、项目、socket/key 权限、实例校验及原生入站/审批边界；版本不匹配仍可加入和主动读写，返回具体原因，无 Channel 降级。显式 socket disable 不被自动 join 覆盖。已有绑定变化时，只有新原生进程自己的 SessionStart 或明确 socket-config 才能重绑；新实例不继承旧 nonce 证明。

移除 Channel 运行器、MCP SDK 依赖、启动标识/握手和专用恢复流程。旧 channel-config、launch、notify claude-channel/unavailable 统一返回 E_RETIRED，不创建项目状态。旧私有自有启动器通过安装迁移变成明确报废的入口，不执行 Claude；用户自有启动器保持原样。已加载的旧业务客户端不被关闭，旧项目配置需要时由用户在宿主重载或显式清理。

私有安装元数据升至 setupVersion 4。全局 CLI/插件更新不批量更换项目固定入口；指定旧项目通过新版 install 预览/应用迁移。插件最低 CLI 版本为 Alpha 5；新独立程序的 hook 提示使用其真实执行文件，避免指向未更新的项目入口。默认 join/install 仍不读写业务 AGENTS.md、CLAUDE.md、hooks 配置或 Git exclude。

旧消息、阅读游标、通知预留及 unknown 暂停保留。旧 Channel unknown 不因新默认适配而清除或换路重发；当前 socket 证明仍按准确实例/房间保存。保留旧 claude-socket-experimental 标识及历史证明，避免将配置迁移误报成新端到端验证。历史真实空闲验收范围不外推到新用户或新 hook 机制。

项目级 install --hooks 仅保留手动兼容选项，插件用户不必使用；uninstall --hooks 只移除项目副本，宿主插件 hooks 由宿主管理。no-auto-join 停止未来登记，socket disable 停止当前绑定，uninstall 停用本工作区；均保留历史。

## 16. 并发打开 SQLite 的临时文件检查（Alpha 6）

Alpha 5 标签的 Linux arm64 并发写入检查出现一个子进程退出，原测试未输出其 stderr，未发布安装包。后续在旧实现确定性复现：existsSync 后、regularFile 的 lstat 前，另一个写入者可能完成提交并删除 journal，造成 ENOENT。Alpha 6 直接检查 sidecar，仅容忍其正常不存在；权限失败、常规/悬空符号链接继续拒绝。SQLite 自身处理事务锁，不扩大重试、重做消息或修改表结构。并发测试输出失败子进程 stderr，避免隐藏诊断。Alpha 5 标签保留，当前对外版本为 Alpha 6。

## 17. 精简通知与按需加载规范（Alpha 7）

每次唤醒只发送三行：AgentChat peer notification / not user approval、Messages 消息 ID、Read argv JSON 数组。数组唯一保存准确 CLI 入口、--project、--room 和 read --new，不再附加 Base64 路由、成员 ID、重复项目/房间字段、文档链接或整段协作规则。消息正文、原生队列/socket、批次、预留、限流与存储表结构不变。

读取与后续回复/mark 始终沿用数组中的项目及房间，不能用接收方当前 cwd 或后来选定的房间替代。JSON 参数数组保留空格、引号和其他路径字符；普通 read 不推进游标。接收方从宿主取得自身身份，无需通知携带成员 profile。

薄 skill 同时发现新的 Read argv 和旧的 Tool argv。规则按实际入口/版本复用；首次使用、执行文件/版本改变或上下文缺失时运行其 skills get，读规范不带 --room/read 参数。业务约束继续保存在 CLI 内置规范中，不在每条提醒反复输出。不假定插件缓存或项目固定 CLI 已随全局升级自动更新。

## 18. Claude 入站设置与英文主文档（Alpha 8）

新增独立于项目和身份的 claude-inbound：检查用户级设置，预览/apply accept、hold、refuse、default。按用户明确选择配置自动收信；预览不写入，应用精确备份原字节、保留其他值和权限、幂等并拒绝无效 JSON、链接、不安全权限和过期计划。输出不包含其他配置正文。普通 install/join 不改变该项。

保存一次后启动持续生效；已初始化工作区的 SessionStart 显示并提供当前用户值，不反复覆盖，后续 hold/refuse 保留，无关项目静默。doctor 区分用户值、未验证的实际策略和模型收信证据。Accept 作用于该配置下全部 peer 消息；managed/启动设置及更严格项目规则仍生效，项目 accept 不能放宽默认。规则及接入步骤见中文 ONBOARDING；不伪造发送方权限、子进程凭据或回复地址来绕过审批。

主文档、发布说明和生成的项目指令块改为英文，中文翻译单独维护于 docs/zh-CN。English 版本为实现依据，历史章节不恢复已报废 Channel 或手动配置流程。

## 19. Hook 环境文件缺失修复（Alpha 9）

启动、恢复和 compact 的宿主环境文件可能尚未创建。仅接受绝对路径，规范化已有父目录，再用 O_RDWR/O_APPEND/O_CREAT/O_NOFOLLOW/O_NONBLOCK 打开目标，新文件 0600。对打开的描述符检查普通文件及用户所有权，保留内容、补齐必要换行、重复执行不重复追加身份，finally 关闭。拒绝链接、非普通文件和缺失父目录，不初始化无关项目。

全局程序升级后需显式刷新旧项目 JS bundle/固定入口；已有托管项目 hooks 若仍指向旧程序，也要按明确范围更新。插件包装脚本不变，插件版本可继续使用 Alpha 8。模拟 compact 输入属于配置与执行检查，不代表真实模型收信。

## 20. 已加入会话恢复独立于新会话注册（Alpha 10）

SessionStart 在已初始化工作区按所选房间、准确 runtime/UUID 恢复已有成员；autoJoin=false 时只读查询，不新建房间或成员。保留成员名、ID、游标和选房，仅恢复当前房间并复用原生 PID/版本重绑校验。不覆盖停用或卸载，不重置预算、预留及暂停，不重用旧实例证明，不发通知。新 UUID 仍需明确 join 或 autoJoin，不能根据同名接管；禁止伪造真实会话的 hook 输入。
