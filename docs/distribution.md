# 安装包与版本发布

安装入口是公开仓库的 [ONBOARDING.md](../ONBOARDING.md)。程序本机安装一次；随后在任意业务项目中 join，首次加入自动初始化；创建或选择聊天室不重复安装。

## 分发结构

- GitHub Release 提供 macOS / Linux 的 arm64、x64 独立程序压缩包、SHA256SUMS、安装器、接入说明及许可证。
- 独立程序包含 Bun 1.3.14 及 CLI 依赖，不要求用户另装 Bun、Node.js 或克隆源码。Linux 包使用 glibc；Windows 尚未提供安装包。
- 安装器按系统和 CPU 选择包，先校验压缩包，再校验解压后的程序；校验通过前不会执行下载内容。不修改 PATH、全局 agent 设置、认证或审批。
- 程序保存在 `${XDG_DATA_HOME:-$HOME/.local/share}/agentchat/<版本>/<平台>/agentchat`。`AGENTCHAT_INSTALL_DIR` 可指定其他绝对路径。
- 程序安装器默认只提供 `~/.local/bin/agentchat` 命令，不更改业务项目或 shell 配置。`AGENTCHAT_BIN_DIR` 可指定命令目录；不覆盖同名的无关用户程序。PATH 未包含该目录时使用返回的 cli 绝对路径。
- 首次 join 验证身份与目标房间后初始化项目配置，已有项目的后续 join、room create/use 不重写配置。项目 `run`、hooks 和新生成的 Claude 入口固定引用该版本缓存；源码方式使用固定 Bun 与项目内 JS。已有项目需要显式升级时，可用新程序的 install 预览并 --apply；程序缓存只下载一次。
- 命名房间数据位于项目集成目录的 rooms/<名称>，default 保留原 chat.db。每房间仍只有两张表；项目配置与房间数据分离，同仓库 worktree 共用房间、各自初始化管理块。
- 自动初始化复用配置计划、备份、幂等和冲突检查；install 作为高级预览/修复入口保留。uninstall --apply 只移除当前工作区的集成配置，保留所有房间、消息和全局程序，不自动删除仍可能被其他项目引用的缓存。

不要删除仍被项目引用的版本缓存。移动项目后，用已安装程序的 install 预览并应用以修复绝对路径；无需重新下载安装程序。旧活跃 Channel 升级后，需要通过新入口恢复原会话才能切房；新版本 Channel 的日常切房无需重启。

## 验证与构建

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
bun test tests
bun run build
bun run build:release
bun run verify:release --binary dist/release/agentchat-v0.1.0-alpha.2-darwin-arm64
```

`build:release --target linux-x64` 等入口可交叉编译；release workflow 在四种原生 runner 上分别运行测试、构建和独立程序验收。验收使用全新目录、带空格/引号的路径及不含开发工具的 PATH，检查程序安装与同名命令保护、首次加入初始化、后续加入、房间切换、hooks、SQLite 收发/mark 和卸载，不向真实会话发通知。

构建会从 Bun 的模块清单收集实际打入程序的第三方许可证，和 Bun 1.3.14 的原始许可说明一起生成 `THIRD_PARTY_LICENSES.txt`。AgentChat 自有代码采用根目录 LICENSE；Bun/JavaScriptCore 等保留各自许可及源码、重新链接说明。

原生模型接收验收独立于安装包验证。目前 socket 的真实验收仅覆盖 macOS arm64、Claude Code 2.1.312 / peerProtocol 1 交互 CLI；在其他机器上仍需 `doctor` 和新 nonce 回传确认，不能以包能启动代替自动收信证据。

## 发布

1. 更新 package.json、install.sh 中的版本及版本发布说明，提交 PR。
2. 等待四种平台的自动化检查和独立安装包验收通过，合入 main。
3. 对同一个已验收提交打 `v<版本>` 标签并推送。workflow 校验标签和 package 版本一致，在四平台重新构建和验收；全部通过后才发布 GitHub Alpha Release。
4. 从无 GitHub 登录的环境安装全局程序，在两个新项目 join，并验证建房、切房及消息隔离，再分享 ONBOARDING.md 链接。

Alpha 使用固定版本下载链接，不依赖 GitHub 的 latest Release 跳转。后续升级发布新标签和安装说明，不覆盖旧版本的包或改变现有项目的固定路径。

构建方式参考 [Bun 独立程序](https://bun.sh/docs/bundler/executables)，平台 runner 参考 [GitHub 官方说明](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)。
