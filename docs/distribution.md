# 安装包与版本发布

安装入口是公开仓库的 [ONBOARDING.md](../ONBOARDING.md)。用户把链接交给业务项目中的 agent，由 agent 下载固定版本安装器、预览项目改动并在已授权范围内应用，再从原生会话加入项目。

## 分发结构

- GitHub Release 提供 macOS / Linux 的 arm64、x64 独立程序压缩包、SHA256SUMS、安装器、接入说明及许可证。
- 独立程序包含 Bun 1.3.14 及 CLI 依赖，不要求用户另装 Bun、Node.js 或克隆源码。Linux 包使用 glibc；Windows 尚未提供安装包。
- 安装器按系统和 CPU 选择包，先校验压缩包，再校验解压后的程序；校验通过前不会执行下载内容。不修改 PATH、全局 agent 设置、认证或审批。
- 程序保存在 `${XDG_DATA_HOME:-$HOME/.local/share}/agentchat/<版本>/<平台>/agentchat`。`AGENTCHAT_INSTALL_DIR` 可指定其他绝对路径。
- 项目 `run`、hooks 和 Claude 启动入口固定指向该版本程序，升级一个项目不会修改其他项目的运行版本。源码安装仍可使用固定 Bun 解释器与项目内 JS 副本。
- 预览和实际安装使用同一套配置计划、备份、幂等与冲突检查。卸载保留消息历史及其他用户配置；版本缓存供其他项目使用，不自动删除。

不要在仍有项目引用时删除版本缓存。移动项目或删除缓存后，重新运行安装器预览并应用，以更新绝对路径；原成员和消息历史保持原位。

## 验证与构建

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
bun test tests
bun run build
bun run build:release
bun run verify:release --binary dist/release/agentchat-v0.1.0-alpha.1-darwin-arm64
```

`build:release --target linux-x64` 等入口可交叉编译；release workflow 在四种原生 runner 上分别运行测试、构建和独立程序验收。验收使用全新目录、带空格/引号的路径及不含开发工具的 PATH，检查安装、幂等、hooks、启动入口、本地 SQLite 收发、显式 mark 和卸载，不向真实会话发通知。

构建会从 Bun 的模块清单收集实际打入程序的第三方许可证，和 Bun 1.3.14 的原始许可说明一起生成 `THIRD_PARTY_LICENSES.txt`。AgentChat 自有代码采用根目录 LICENSE；Bun/JavaScriptCore 等保留各自许可及源码、重新链接说明。

原生模型接收验收独立于安装包验证。目前 socket 的真实验收仅覆盖 macOS arm64、Claude Code 2.1.312 / peerProtocol 1 交互 CLI；在其他机器上仍需 `doctor` 和新 nonce 回传确认，不能以包能启动代替自动收信证据。

## 发布

1. 更新 package.json、install.sh 中的版本及版本发布说明，提交 PR。
2. 等待四种平台的自动化检查和独立安装包验收通过，合入 main。
3. 对同一个已验收提交打 `v<版本>` 标签并推送。workflow 校验标签和 package 版本一致，在四平台重新构建和验收；全部通过后才发布 GitHub Alpha Release。
4. 从无 GitHub 登录的环境下载固定版本安装器，在新项目预览、应用并验证，再分享 ONBOARDING.md 链接。

Alpha 使用固定版本下载链接，不依赖 GitHub 的 latest Release 跳转。后续升级发布新标签和安装说明，不覆盖旧版本的包或改变现有项目的固定路径。

构建方式参考 [Bun 独立程序](https://bun.sh/docs/bundler/executables)，平台 runner 参考 [GitHub 官方说明](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)。
