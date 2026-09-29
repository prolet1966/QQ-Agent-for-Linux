# QQ Agent · Linux 部署交接（供 AI 代理自动执行）

> **这份文档的用途**：把它连同 `QQA-Linux_x64.tar.gz` 一起交给一个 AI 代理，
> 让它在一台 Linux x86_64 机器上完成「适配 → 安装 → 验证」。
>
> 阅读顺序即执行顺序。**遇到标 `[需人工]` 的步骤必须停下来找人类**，不要伪造结果。
> 每一节末尾的「检查点」都要真实执行并报告输出，不要凭推断填写。

---

## 0. 先读：你的任务与边界

**目标**：让 QQ Agent 在目标机上跑起来，并能通过 OneBot v11 收发 QQ 消息。

**你可以自动完成的**：装依赖、装包、放开内核注入限制、建目录、配 systemd、验证进程与端口。

**你无法自动完成、必须由人类做的**（见第 6 节）：

| 事项 | 为什么 |
| --- | --- |
| QQ 客户端扫码登录 | 需要人类手机确认 |
| 在 QQ Agent 界面填 OpenAI 兼容 API Key | 属于用户机密，文档里不会有 |
| 首次在 SnowLuma 控制台同意 EULA 并改密码 | 需要人类决定 |

**不要做的事**：

- 不要从非本归档或非下方 GitHub Release 的来源取包。
- 不要跳过第 1 节的哈希校验；校验不通过就停止并报告。
- 不要用「看起来对」来替代实际执行验证；每条检查点都要贴真实命令输出。
- 不要声称聊天功能可用，除非第 7 节的检查点 6、7 真的通过了。

---

## 1. 归档内容与完整性校验

`QQA-Linux_x64.tar.gz` 内为顶层目录 `QQA-Linux_x64/`，含 7 个文件：

| 文件 | 大小（字节） | SHA256 |
| --- | --- | --- |
| `qq-agent-v0.4.4-amd64.deb` | 121,483,924 | `9c9a737f56139bdea51853b4d4b3f999a372bd767558e7f2fcff8165205f5c7d` |
| `qq-agent-v0.4.4-x86_64.rpm` | 108,080,037 | `8a001aeef1809a7b278fd2d16366ccb7b6acec4c574f56f82250bd8d9832f952` |
| `qq-agent-v0.4.4-x86_64.AppImage` | 157,181,636 | `74b00579195dd73954695a9020321ebad3ea699c5563ba5ef726b9e76026888e` |
| `SHA256SUMS.txt` | 283 | （与上三行一致，随包分发） |
| `Linux版本安装与部署指南.md` | 11,942 | 面向人类的完整安装手册 |
| `AI-部署交接.md` | 本文件 | 面向 AI 代理的可执行流程（就是你现在读的这份） |
| `移植与验证报告.md` | 21,685 | 移植过程与验证结果的回顾报告，**给人类看**，AI 执行时不必读 |

**前 6 个是本程序运行所需**；最后一个是项目历史记录，不影响部署。

**三种包的内容相同**（同一份 `app.asar` + 同一份 SnowLuma），只是容器格式不同。
**按目标机的发行版只装其中一种即可**，不要三个都装。

```bash
# 校验点 1：解包并核对哈希
tar -xzf QQA-Linux_x64.tar.gz && cd QQA-Linux_x64
sha256sum -c SHA256SUMS.txt          # 期望三个 OK
```

**检查点 1**：`sha256sum -c` 必须输出三行 `OK`。
任何 `FAILED` → 停止，报告是哪个文件、期望值、实际值。

> 注意：这三个包均超过 GitHub 单文件 100 MB 限制，**不在 git 仓库里**，
> 只作为 Release 附件存在。仓库里只有源码与构建脚本。

---

## 2. 前置条件检查

**逐条执行，把实际输出记下来。** 有任一条不满足，先解决再继续。

```bash
# 1) 架构必须是 x86_64（包不含 arm64 版本）
uname -m                                  # 期望 x86_64

# 2) 发行版与包管理器
cat /etc/os-release | head -3
command -v dpkg rpm dnf apt

# 3) 必须有 sudo（安装、改 sysctl 都要）
sudo -n true 2>/dev/null && echo "sudo 免密" || echo "sudo 需要密码 [需人工]"

# 4) 内核注入策略 —— 最容易漏、漏了必然失败
cat /proc/sys/kernel/yama/ptrace_scope    # 期望 0
```

**关于第 4 条（务必理解，不要机械跳过）**：

SnowLuma 的工作方式是 **ptrace 注入一个正在运行的 QQ 进程**。
Ubuntu / Debian / Mint 默认 `ptrace_scope=1`，只允许父进程注入子进程，
而 SnowLuma 不是 QQ 的父进程 —— 注入会被内核直接拒绝，
表现为 SnowLuma 控制台报 `component loading failed [COMPONENT_LOAD_FAILED]`，
机器人永远连不上。**这不是程序缺陷，是内核安全策略。**

```bash
# 临时放开（重启失效，用于验证）
sudo sysctl -w kernel.yama.ptrace_scope=0

# 确认已生效
cat /proc/sys/kernel/yama/ptrace_scope   # 必须输出 0

# 持久化（确认功能正常后再做）
echo "kernel.yama.ptrace_scope = 0" | sudo tee /etc/sysctl.d/99-ptrace-inject.conf
sudo sysctl -p /etc/sysctl.d/99-ptrace-inject.conf
```

> ⚠️ 这会放宽系统的一项安全限制：此后同一用户的任意进程都能注入彼此，可读取对方内存中的凭据。
> 这是使用本程序的前提，请让人类知情后再持久化。

**检查点 2**：`ptrace_scope` 输出 `0`；`uname -m` 输出 `x86_64`。

---

## 3. 安装 QQ Agent

只选与发行版匹配的一种。

### Debian / Ubuntu / Mint（.deb）

```bash
sudo apt install ./qq-agent-v0.4.4-amd64.deb
```
自动解决依赖：`libnss3 libgtk-3-0 libasound2 libgbm1 libxkbcommon0 libdrm2 libxss1 xdg-utils`

### RHEL / Fedora / Rocky（.rpm）

```bash
sudo dnf install ./qq-agent-v0.4.4-x86_64.rpm
```
依赖名已适配 RPM 系：`nss gtk3 alsa-lib mesa-libgbm libxkbcommon libdrm libXScrnSaver xdg-utils`

> 这些名字不能照抄 Debian 系。写错时 `rpm -qpR` 照样能把名字打印出来，
> 但 `dnf install` 会直接失败 —— 只看元数据看不出来。

### 任意发行版（AppImage）

```bash
chmod +x qq-agent-v0.4.4-x86_64.AppImage
./qq-agent-v0.4.4-x86_64.AppImage
```

> **Ubuntu 24.04+ 需要先装 libfuse2**，否则报 `dlopen(): error loading libfuse.so.2`：
> ```bash
> sudo apt install libfuse2t64        # 或加 --appimage-extract-and-run 参数绕过
> ```
> 这是 AppImage 格式的通用特性，与本项目无关。

三种包安装后布局一致：主程序在 `/opt/QQ Agent/`，`.desktop` 在 `/usr/share/applications/`，
图标在 `/usr/share/icons/hicolor/256x256/apps/qq-agent.png`。

**检查点 3**：
```bash
ls -l "/opt/QQ Agent/qq-agent"                                  # 存在且可执行
ls -l "/opt/QQ Agent/resources/app.asar"                        # Electron 前端
ls -l "/opt/QQ Agent/resources/app.asar.unpacked/snowluma/node" # SnowLuma 自带 node，必须有可执行位
file "/opt/QQ Agent/qq-agent"                                  # ELF 64-bit x86-64
```

> `snowluma/` **必须**被解包到 `app.asar.unpacked/` 而不是留在 asar 内，
> 因为 asar 里的文件无法被 spawn 执行。若该路径不存在，SnowLuma 起不来。

---

## 4. 安装 Linux 版 QQ（**必做，不可跳过**）

**本程序不替代 QQ**，它注入并驱动一个真实的 QQ 客户端。目标机没有 QQ 则整体无法工作。

```bash
# 从腾讯官方下载（地址见 https://im.qq.com/linuxqq/）
sudo apt install ./QQ_*.deb        # Debian 系
# 或从同一页面取 rpm 包

# 确认安装位置（本程序会自动探测这些路径）
ls -l /opt/QQ/qq
```

**检查点 4**：`/opt/QQ/qq` 存在且可执行。

> **版本兼容性**：QQ 版本必须与内置 SnowLuma（v1.14.19）兼容。
> 实测可用：linuxqq `3.2.34-53644`。版本错配会导致注入成功但登录态识别失败。

---

## 5. 启动与接线

三个进程必须都在，顺序有讲究：

```
SnowLuma（协议端，Electron 内置 node 启动）
   ↓ ptrace 注入
QQ 客户端（真实 Linux QQ，需已登录）
   ↑ OneBot v11（HTTP :3000 / 正向 WS :3001）
QQ Agent（Electron 主程序，控制台）
```

```bash
# 启动主程序（GUI 环境）
qq-agent

# 无头 / 服务器环境：用 Xvfb
Xvfb :99 -screen 0 1920x1080x24 &
DISPLAY=:99 qq-agent
```

**默认监听端口**（仅本机）：

| 服务 | 地址 |
| --- | --- |
| SnowLuma 控制台（WebUI） | `http://127.0.0.1:5099` |
| OneBot v11 HTTP | `http://127.0.0.1:3000` |
| OneBot v11 正向 WS | `ws://127.0.0.1:3001` |

**检查点 5**：
```bash
pgrep -af "qq-agent"                                   # 主程序在跑
pgrep -af "snowluma"                                   # 协议端在跑 或 snowluma/node
ss -lntp | grep -E ':(5099|3000|3001)'                 # 三个端口都在监听
```

---

## 6. 需要人类的三个动作

到这里 AI 的自动化部分结束。以下必须人类完成，**不要让 AI 代劳或假装完成**：

1. **登录 QQ**：打开 QQ 客户端，用手机扫码登录一个账号。
   建议这是**专门给机器人用的账号**，不要用主号。

2. **在 SnowLuma 控制台加载 Hook**：浏览器打开 `http://127.0.0.1:5099`
   → 首次需同意 EULA/PRIVACY 并修改初始密码
   → 「进程注入」页会列出检测到的 QQ 进程（显示 PID）
   → 对**那个有窗口、已登录**的 QQ 进程点「加载」
   → 日志出现 `pipe connected` 和 `login detected: UIN=...` 才算成功

   > 若此时报 `component loading failed [COMPONENT_LOAD_FAILED]`，
   > 回到第 2 节检查 `ptrace_scope` 是否为 0。**这是该报错的首要原因。**

   > 若同时存在多个 QQ 进程，选**有窗口的那个**；无窗口的多开残留实例注入必然失败。

3. **填 API Key**：在 QQ Agent 界面填入 OpenAI 兼容的 `base_url` / `api_key` / `model`。

**检查点 6**：SnowLuma 日志出现 `pipe connected: PID=<pid>` 与 `login detected: PID=<pid> UIN=<uin>`。

---

## 7. 端到端验证

```bash
# 1) 三个进程
pgrep -af "qq-agent"; pgrep -af "snowluma/node"

# 2) 端口
ss -lntp | grep -E ':(5099|3000|3001)'

# 3) ptrace 策略
cat /proc/sys/kernel/yama/ptrace_scope        # 0

# 4) SnowLuma 日志：注入与登录
grep -E "pipe connected|login detected|OneBot" \
  "/opt/QQ Agent/resources/app/snowluma/logs/snowluma-$(date +%F).log" | tail

# 5) 数据目录落在 XDG 位置（不在 /opt 安装目录内）
ls -d ~/.local/share/qq-agent && ls ~/.local/share/qq-agent | head

# 6) OneBot 接口可达（需 token，从 QQ Agent 配置里取）
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/

# 7) 在群里 @ 机器人 或私聊发一条消息，观察是否回复
```

**检查点 7**：第 6 步返回 200 且第 7 步机器人有回复，才可判定「部署成功」。
只到第 5 步只能判定「进程起来了」，**不等于能收发消息**。

---

## 8. 故障对照表

| 现象 | 首要原因 | 处置 |
| --- | --- | --- |
| SnowLuma 报 `component loading failed [COMPONENT_LOAD_FAILED]` | `ptrace_scope` 不是 0 | 第 2 节放开并确认输出 0 |
| 同上，且已是 0 | 目标是多开的无窗口 QQ 残留实例 | 关掉多余实例，只留已登录的那个 |
| 同上，且只有一个实例 | QQ 版本与 SnowLuma 不兼容 | 换 QQ 构建版本（实测 3.2.34-53644 可用） |
| QQ 起来了但机器人收不到消息 | Hook 未加载 / 未登录 | 第 6 节第 2 步 |
| `dlopen(): error loading libfuse.so.2` | 缺 libfuse2（仅 AppImage） | `sudo apt install libfuse2t64` |
| `GPU process isn't usable` | WSLg / 无 GPU 转发环境 | 用 `--disable-gpu`，数据目录与后端不受影响 |
| 卸载后数据还在 | 设计如此（XDG 数据目录不随包删除） | 要清干净见第 9 节 |
| 界面报 `ERR_CONNECTION_REFUSED` | 对应的内部端口未起 | 检查 5099/3000/3001 |

---

## 9. 卸载

```bash
# Debian 系
sudo apt remove qq-agent
# RPM 系
sudo dnf remove qq-agent
# AppImage：直接删除文件

# 用户数据**不会**被自动删除，需要时手动清
rm -rf ~/.local/share/qq-agent ~/.config/qq-agent
```

> 卸载后 `/opt/QQ Agent` 可能残留**空目录骨架**，这是 deb/rpm 对共享路径的正常语义，不是残留文件。

---

## 10. 数据与目录约定

| 内容 | 位置 |
| --- | --- |
| 用户数据（配置/会话/记忆/日志/单实例锁） | `~/.local/share/qq-agent/` |
| Electron 本体数据 | `~/.config/qq-agent/` |
| SnowLuma 运行时 | `/opt/QQ Agent/resources/app.asar.unpacked/snowluma/` |
| SnowLuma 日志（按天） | 上者 `logs/snowluma-YYYY-MM-DD.log` |

**数据目录遵循 XDG**，不写在 `/opt` 安装目录内 —— 这样升级/卸载不会吃掉用户数据。

---

## 11. 技术清单（供判断兼容性）

| 项目 | 版本 |
| --- | --- |
| QQ Agent | 0.4.4（上游 Kondius/qq-agent，MIT） |
| Electron 运行时 | 33.2.0（内置，无需另装 Node） |
| SnowLuma 协议端 | v1.14.19 linux-x64（内置，`sha256:f0cbd19809327c3959c64083a008c136d9b7538f34a6763c21415fcf9d75f7a5`） |
| 架构 | x86_64 only |
| 实测目标 | Ubuntu 26.04.1 / Linux Mint 22.3 / Fedora 44 |

内置 SnowLuma 采用**源码可见非商业许可**（非 OSI 开源），商业使用需另行取得其书面授权；
其 `EULA.md` 与 `PRIVACY.md` 随包分发在 `snowluma/` 目录内。

---

## 12. 附：源码与发布地址

| 内容 | 地址 |
| --- | --- |
| 源码仓库 | <https://github.com/prolet1966/QQ-Agent-for-Linux> |
| 发行包 | <https://github.com/prolet1966/QQ-Agent-for-Linux/releases/tag/v0.4.4-linux> |
| 上游原项目 | <https://github.com/Kondius/qq-agent> |
| 协议端上游 | <https://github.com/SnowLuma/SnowLuma> |

> 本归档的包与上述 Release 附件**逐字节相同**，SHA256 见第 1 节。
> 重建流程见仓库 `build-scripts/`，一键构建脚本见交付时附带的 `build-packages.sh`。
