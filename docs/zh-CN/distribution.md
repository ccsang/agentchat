[English](../../docs/distribution.md) | 简体中文

# 安装包与版本发布

安装入口是公开仓库的 [ONBOARDING.md](ONBOARDING.md)。程序本机安装一次；随后在业务项目中 join，首次加入只准备本地运行状态，不改项目指令或 hooks；创建或选择聊天室不重复安装。只要求安装或建房时按范围完成后停止。

## 分发结构

- GitHub 仓库同时提供 Claude 的 .claude-plugin/marketplace.json 和 Codex 的 .agents/plugins/marketplace.json，指向同一个 plugins/agentchat。薄 skill 只有一份；插件本身独立版本化，CLI 后续更新不强制重发未改变的插件。
- 插件包含便携 plugin.json 与宿主兼容描述，默认推荐用户级安装，不内置业务项目路径、会话或房间，Claude manifest 另声明短 SessionStart/SessionEnd hooks，Codex 不加载它们；无 MCP 服务。程序安装器不会顺带注册插件。
- 详细协作规范编译进 CLI，由 skills get 提供；--json 额外返回版本和内容哈希，skills list 提供发现。命令不需要项目、身份、外部 Markdown 或网络；读取不会初始化房间或写配置。

- GitHub Release 提供 macOS / Linux 的 arm64、x64 独立程序压缩包、SHA256SUMS、安装器、接入说明及许可证。
- 独立程序包含 Bun 1.3.14 及 CLI 依赖，不要求用户另装 Bun、Node.js 或克隆源码。Linux 包使用 glibc；Windows 尚未提供安装包。
- 安装器按系统和 CPU 选择包，先校验压缩包，再校验解压后的程序；校验通过前不会执行下载内容。不修改 PATH、全局 agent 设置、认证或审批。
- 程序保存在 `${XDG_DATA_HOME:-$HOME/.local/share}/agentchat/<版本>/<平台>/agentchat`。`AGENTCHAT_INSTALL_DIR` 可指定其他绝对路径。
- 程序安装器默认只提供 `~/.local/bin/agentchat` 命令，不更改业务项目或 shell 配置。`AGENTCHAT_BIN_DIR` 可指定命令目录；不覆盖同名的无关用户程序。PATH 未包含该目录时使用返回的 cli 绝对路径。
- 首次 join 验证身份与目标房间后只准备私有入口、配置和数据。默认 join / room use / install 不读取或改写 AGENTS.md、CLAUDE.md、.claude/settings.local.json 或 Git exclude。项目 `run` 固定引用该版本缓存；不再生成 Claude Channel 入口；源码方式使用固定 Bun 与私有 JS。程序缓存只下载一次。
- install --instructions 与 install --hooks 分别预览项目指令、Claude hooks 集成，--apply 才应用。集成选择按工作区记录；同仓库 worktree 共用房间，各自准备本地状态，不继承别的工作区启用的 hooks。
- 命名房间数据位于项目集成目录的 rooms/<名称>，default 保留原 chat.db。每房间仍只有两张表；本地运行状态与房间数据分离。
- 本地初始化与显式集成复用计划、备份、幂等和冲突检查。uninstall --instructions / --hooks 可分别移除；uninstall --apply 停用当前工作区并清理已启用的自有集成，保留所有房间、消息和全局程序，不删除仍可能被其他项目引用的缓存。

不要删除仍被项目引用的版本缓存。移动项目后，用已安装程序的 install 预览并应用以修复私有入口；已启用的 hooks 需要单独显式更新，无需重新下载程序。Alpha 6 不再使用 Channel。升级会停用自有私有 Channel 入口；已加载的旧宿主配置可能需重载，不关闭业务会话，不重放旧通知。

默认不改项目文件从 Alpha 3 开始，内置规范从 Alpha 4 开始。升级时先运行新版安装器；已初始化的项目入口用全局新版 install 预览并 --apply 更新本地运行文件，再读取该入口的 skills get。重复 join 不替换已固定的旧程序。升级不自动修补或删除旧管理块、hooks；明确需要时分别预览 install/uninstall --instructions 或 --hooks，再应用所选范围。通知自带本地 CLI 路由，普通通信不需要这两类项目文件。Alpha 7 通知改用三行 Read argv，升级到实际 Alpha 7 项目入口才会生成该格式；薄 skill 应通过宿主更新以识别新旧提醒，已加载的同版本规范无需每次重读。Claude 插件 hooks 通过宿主管理，不需要 --hooks 项目副本；开启 --auto-join 后仅在已初始化工作区自动加入。全局程序与插件都需更新到 Alpha 6，插件最低版本检查会拒绝继续旧 Channel 流程。

## 验证与构建

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
bun test tests
bun run build
bun run build:release
bun run verify:release --binary dist/release/agentchat-v0.1.0-alpha.9-darwin-arm64
```

`build:release --target linux-x64` 等入口可交叉编译；release workflow 在四种原生 runner 上分别运行测试、构建和独立程序验收。验收使用全新目录、带空格/引号的路径及不含开发工具的 PATH，检查程序安装与同名命令保护、默认加入不改项目文件、显式可选集成、后续加入、房间切换、hooks、SQLite 收发/mark 和卸载，不向真实会话发通知。

构建会从 Bun 的模块清单收集实际打入程序的第三方许可证，和 Bun 1.3.14 的原始许可说明一起生成 `THIRD_PARTY_LICENSES.txt`。AgentChat 自有代码采用根目录 LICENSE；Bun/JavaScriptCore 等保留各自许可及源码、重新链接说明。

原生模型接收验收独立于安装包验证。目前 socket 的真实验收仅覆盖 macOS arm64、Claude Code 2.1.312 / peerProtocol 1 交互 CLI；在其他机器上仍需 `doctor` 和新 nonce 回传确认，不能以包能启动代替自动收信证据。

## 发布

1. 更新 package.json、install.sh 中的版本及版本发布说明，提交 PR。
2. 等待四种平台的自动化检查和独立安装包验收通过，合入 main。
3. 对同一个已验收提交打 `v<版本>` 标签并推送。workflow 校验标签和 package 版本一致，在四平台重新构建和验收；全部通过后才发布 GitHub Alpha Release。
4. 从无 GitHub 登录的环境安装全局程序，在两个新项目 join，并验证建房、切房及消息隔离，再分享 ONBOARDING.md 链接。

Alpha 使用固定版本下载链接，不依赖 GitHub 的 latest Release 跳转。后续升级发布新标签和安装说明，不覆盖旧版本的包或改变现有项目的固定路径。

构建方式参考 [Bun 独立程序](https://bun.sh/docs/bundler/executables)，平台 runner 参考 [GitHub 官方说明](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)。

## Alpha 8：入站选择与语言

新增 claude-inbound 用户级检查和预览/apply，Accept 需用户明确选择，影响该配置下所有 peer 消息。程序安装和默认 join 不启用；设置一次后启动沿用，已初始化工作区 hook 显示状态并保留后续 hold/refuse。预览无写入，应用备份并保留其他值。详见 [接入说明](ONBOARDING.md#claude-入站策略与启动提示)。

主文档、历史发布说明及生成指令块为英文；中文位于 docs/zh-CN。发布附件提供英文 ONBOARDING，中文译文通过仓库链接访问。
