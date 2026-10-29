# Claude 原生 socket 实验

用户在当前 Channel 不可用后，明确选择保留网关并开发此适配。本实验直接使用已打开的原生收件箱，默认 Channel 路径仍单独保留，不做失败后的自动切换。

## 范围

当前锁定 Claude Code 2.1.312、peerProtocol 1、交互 CLI。本机 macOS arm64 已完成原会话 nonce、双向闭环，以及顺序进行的真实 10 分钟和 1 小时空闲验收，详见 verification.md。其他版本、Linux、Windows、Desktop Code tab 等组合未验收。协议并非完整稳定的官方外部客户端 API，升级时需复核并重新验证。

无独立收件服务、HTTP 端口、假原生会话或模型轮询。日常 CLI 和两张业务表保持不变。

## 使用

由 agent 对准确已登记的 Claude 执行 `socket-config --apply`；协作方可用 `--to` 指定确切成员。无 apply 只预览，且不发送通知。目标按已登记原生 UUID 匹配唯一有效 peer，用户无需搬运 UUID 或 socket 路径。

在用户授权的真实联调范围执行 `probe`，nonce 必须通过该实例自己的工具上下文回传。`doctor` 的 mode 为 claude-socket-experimental，验证为 current_socket 时才证明当前实例通过探针。将来若恢复了原会话而进程已变，应再次显式绑定并验证；不猜最近会话，也不靠同名接管。

可用 `socket-config --disable --apply` 退出实验，不删除历史或重置预留，不启动替代客户端。原 Channel 的未知尝试需要单独核对，不因实验选择而被重发。

## 实际协议与校验

- 仅读取本用户 Claude sessions 目录下的 PID 元数据；按目标 UUID 筛选，不读取其他聊天正文。发现数量有上限。
- 项目按现有 common-dir 规则检查；PID 起始时间使用 LC_ALL=C、TZ=UTC 查询以匹配 2.1.312 元数据。进程重用、多个同时存活的相同会话、错误项目或协议版本均拒绝。
- 元数据可为宿主实际创建的 0644 文件，但必须是本用户所有的常规文件；socket 及其目录分别要求 owner-only，key 必须是本用户 owner-only 常规文件。拒绝最终路径的符号链接。
- Bun 1.3.14 无法对 socket inode 调用 realpathSync：先 lstat 最终节点，再规范化父目录，兼容 macOS 的 /tmp → /private/tmp 系统别名。实例指纹包含进程身份、版本、规范化 socket 路径、设备及 inode。
- 此版本的 key 文件名使用已发布 socket 路径的 SHA-256；在本机观测中，该路径与规范化的 /private/tmp 路径不同。读取并核对 peerToken 与 procStart，凭据不落入消息、绑定文件或命令行。
- 发送两个 NDJSON 帧：peer auth，然后 type=user、message.role=user、priority=next、msgV=1、cc-msg-UUID 的通知帧。正文只含 AgentChat 消息编号和本地读取提示，不夹带业务正文。
- 不使用 CLAUDE_CODE_MESSAGING_TOKEN 子进程凭据，不伪造 Claude reply address，不声明 from-mode，不修改 native crossSessionInbound。原生 hold/refuse 及工具审批继续生效。
- 本适配不建回复收件箱，因此不接收原生 held/denied 等控制回执。socket 写出仅为 submitted、processed=false；没有 nonce 或业务回复就不能声称模型处理成功。

## 故障与限流

先验证并连接，再短事务预留，最后事务外写出。连接前失败不消费预留；提交开始后不确定则保留预留并暂停 socket 未来通知。暂停与旧 Channel 的诊断分开存放，解除暂停不会重复旧批次。

共享现有滚动限流、批次合并、30 分钟通知 TTL 和显式阅读游标。按需投递被限流时只报告 held，不引入常驻补投桥。消息仍可主动读取。更换适配器不能把旧通知重新变成待发。

## 验收

默认自动化使用隔离的假 peer、短临时 socket 和模拟 key，覆盖路由、权限、实例替换、PID 变化、提交失败、暂停、证明隔离等；不接触真实客户端。

真实验收先完成原会话 nonce 和双向闭环，再顺序运行 `test:native:idle --seconds 600` 与 `--seconds 3600`。计时期间不输入，不发送假业务消息；发布器核对原生 idle 状态未变，到期发送一次真实请求后退出。Claude 返回测试结果并通知原 Codex，被动核对脚本读取本地证据和接收元数据，核对原接收实例仍在，不向客户端发通知。

## 资料

官方文档说明原生收件箱、身份来源、生命周期、入站控制与供应商支持；外部 NDJSON 帧及 key 细节结合独立协议说明和本机版本观察核对。未导入或复制第三方实现。

- [Claude Code cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging)
- [cc-peer 协议说明（非官方、逆向）](https://github.com/mikekelly/cc-peer/blob/main/docs/PROTOCOL.md)
