# 服务器版安装、升级与回滚

服务器包只运行 QQA Node 核心。它不包含 Electron、SnowLuma、Linux QQ、内置 Skill/插件、用户数据或登录态。安装前准备 Linux x64/arm64 和 Node.js 22.16+；已验证 Node 22.17.1。可以使用 `scripts/server/download-node.sh` 下载带 SHA256 校验的专用核心 Node。

先在源码 checkout 执行 `npm ci --omit=dev --ignore-scripts` 和 `npm run build:server`。产物会写入 `dist/server/`，其中 tar.gz、`.sha256` 和 `server-manifest.json` 记录源提交、脏工作树状态、文件哈希和运行时基线。发布前审查 manifest 的 `dirty` 字段，带本地修改的包不能当作正式发布包。

本地交付目录已整理：当前源码在 `源码/`，已部署的原始构建包、校验文件和 manifest 在相邻的 [构建产物/QQA服务器](../../构建产物/QQA服务器/)。完整目录和配套安装包说明见 [目录说明](../../构建产物/目录说明.md)。以下 `dist/server/` 路径用于从源码重新构建后的安装；使用现有交付包时，替换为其实际路径。

以 root 安装：

```sh
sudo scripts/server/install-server.sh dist/server/qq-agent-server-v0.4.7-node22.tar.gz \
  /opt/qq-agent-server /var/lib/qq-agent qqa /opt/qq-agent-server/runtime/node-v22.17.1-linux-x64/bin/node
```

安装器切换 `/opt/qq-agent-server/current`，旧版本仍在 `releases/`，对应 unit 快照在 `unit-state/`。用户数据保留，Linux QQ 和 SnowLuma 继续由各自服务管理。安装器创建权限为 `0600` 的 `/etc/qq-agent/server.env`。在该文件加入 `QQ_AGENT_PUBLIC_HOST=47.109.97.184:3210` 后执行 `sudo systemctl restart qq-agent-server.service`，浏览器访问 `http://47.109.97.184:3210`。首次启动生成 `DATA_DIR/console-initial-password.txt`，本例为 `/var/lib/qq-agent/console-initial-password.txt`（权限 `0600`），登录后修改密码。

核心升级：使用相同数据目录参数重复运行安装器即可。切换前校验已有 current/previous 链接在 `releases/` 内、`server.env` 的数据目录与参数一致、端口为 1–65535 的整数；带单双引号的数字端口也支持。安装器保存受管核心的 current/previous 链接、unit 内容和 active/enabled 状态，再启动新版本并请求本机 `/api/auth/session`。健康检查最多 40 次，间隔 0.5 秒，单请求超时 800 ms。启动或检查失败时自动恢复旧链接、unit 和服务状态；此前没有受管核心 unit 时不会启动旧 Electron。健康检查通过后才清理临时备份。手动回滚：

```sh
sudo scripts/server/rollback-server.sh /opt/qq-agent-server
```

该命令恢复上一 release 的 unit 快照和 Node 可执行路径，同时交换 current/previous。原先停止的核心保持停止；原先运行的核心会执行相同健康检查，失败则恢复操作前版本和 unit。缺少快照、旧 Node 已不存在或端口非法时保留当前核心并拒绝切换。代码回滚保留数据，消息数据库回滚需使用下面的独立工具。

SQLite/JSON 数据迁移是离线步骤。先停止 QQA，再完整备份 DATA_DIR；以服务用户执行维护工具，避免生成 root 属主的数据库和锁文件。以下三个维护命令按需要单独执行，不是必须依次执行的操作：

```sh
sudo systemctl stop qq-agent-server.service
sudo -u qqa /opt/qq-agent-server/runtime/node-v22.17.1-linux-x64/bin/node \
  /opt/qq-agent-server/current/scripts/message-storage.mjs migrate --data-dir /var/lib/qq-agent
sudo -u qqa /opt/qq-agent-server/runtime/node-v22.17.1-linux-x64/bin/node \
  /opt/qq-agent-server/current/scripts/message-storage.mjs export --data-dir /var/lib/qq-agent \
  --output /var/lib/qq-agent/message-export-20261012
sudo -u qqa /opt/qq-agent-server/runtime/node-v22.17.1-linux-x64/bin/node \
  /opt/qq-agent-server/current/scripts/message-storage.mjs rollback --data-dir /var/lib/qq-agent
```

迁移与回滚要求 `store.backend=auto` 且没有 `QQ_AGENT_STORE_BACKEND` 覆盖。原始 JSON 保留，迁移校验完成前不激活 SQLite。回滚先把当前 SQLite（包括迁移后新增消息）导出为 JSON，再切换后端。export 目标目录必须不存在、父目录可由服务用户写入，且与 DATA_DIR 同一文件系统；导出完成后可复制到其他磁盘。核心和工具共享进程锁，核心未停止时维护操作会拒绝运行。维护完成后启动 `qq-agent-server.service`。

备份完整 DATA_DIR，而非只复制 `messages.sqlite`：包括聊天库及 `-wal`/`-shm`、`event-inbox.sqlite` 及其侧文件和队列 UUID、storage-state、配置和认证、会话、扩展及其他用户数据。停核心后复制，恢复时保留服务用户属主和权限。QQ/SnowLuma 的配置与登录数据在各自目录，另行备份。服务器模式下在线 `/api/reset-data` 返回 409；清理历史或失败事件前停止核心、备份目录，再执行离线维护。

## SnowLuma 与 Linux QQ

两者是可选的独立 systemd 服务：`scripts/server/qq-agent-snowluma.service` 和 `qq-agent-qq.service` 是模板，必须先把 `@USER@`、`@GROUP@`、已有可写配置/登录目录、核心安装根目录、自带 Node 22.13.0 及 QQ 启动参数替换为实际路径，再安装到 `/etc/systemd/system/`。SnowLuma unit 通过核心包中的 `snowluma-launcher.mjs` 启动 WorkingDirectory 下官方 `index.mjs`；启动器过滤日志凭据，将初始密码保存到 SnowLuma 的 `config/qqa-initial-password.txt`（0600）。模板不会自动杀掉现有进程、不会修改全局 `ptrace_scope`；SnowLuma unit 仅在原生 Hook 明确需要时授予该 unit 的 `CAP_SYS_PTRACE`。保持 QQ、SnowLuma 和核心使用同一个普通用户，并保留已有 HOME、显示 `:99` 和登录数据。真实 QQ Hook、WebUI 登录/扫码和收发仍需在 ECS 验收。

如果允许控制面板管理组件，可安装 `deploy/polkit/50-qq-agent-components.rules.example`。规则仅放行 `qq-agent-qq.service`、`qq-agent-snowluma.service` 和 `qq-agent-desktop.service` 三个固定 unit 的 start/stop/restart；没有 polkit 时面板保持只读，由管理员使用 systemctl。桌面服务按需启动、15 分钟自动结束，不设置开机 enable。

Ubuntu 22.04 的 polkit 0.105 使用旧授权后端，不执行 JavaScript `.rules`。该环境可使用随包提供的 `qq-agent-components.socket` 与 `qq-agent-components@.service`：替换模板中的用户、组和安装根目录，安装到 `/etc/systemd/system/` 后执行 `systemctl enable --now qq-agent-components.socket`，并在 `server.env` 加入 `QQ_AGENT_COMPONENT_SOCKET=/run/qq-agent-components/control.sock` 后重启核心。此方式需要 `/usr/bin/python3`，不需要 sudo 或关闭核心的 `NoNewPrivileges`。Unix socket 仅服务用户可连接（0600），最多4个并行请求，单请求30秒；root处理器拒绝256字节以上的请求、额外字段、未知组件和未知动作，只能通过固定绝对路径管理上述3个unit的start/stop/restart，不能执行任意命令或启用其他服务。

SnowLuma启动器按真实文件路径识别CLI入口，支持安装器的`current`版本软链接。不要把测试目录里的Node或旧Electron包中的SnowLuma软链接用于最终生产服务；独立运行时和协议代码必须保存在稳定安装目录。
