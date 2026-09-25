# QQ Agent · Linux 安装与部署指南

> 面向 QQ Agent v0.4.4 的 Linux 移植版（`.deb` / `.rpm` / AppImage）。
> 本文档基于**源码级移植改造**编写，改造点见 `docs/linux-port-findings.md`，
> 交付与验证结果见 `docs/linux-delivery-report.md`。
>
> **已实测验证**：
> `.deb` 在真实 Ubuntu 26.04.1 虚拟机上 **19/19**（另在 WSL2 上 25/25）；
> **`.rpm` 在真实 Fedora 44 上 41 项 0 失败**
> （依赖解析 23/23 + GUI/XDG 11/11 + 卸载保留数据 7/7）；
> AppImage 在真实 Ubuntu 上 18/18（另在 WSL 上 7/7）。
> 文件名与大小见下方「安装」一节。

---

## 一、系统要求

| 项目 | 要求 | 说明 |
| --- | --- | --- |
| 架构 | **x86_64** | 安装包只提供 x64 |
| C 库 | **glibc ≥ 2.28** | Debian 11+ / Ubuntu 20.04+ / RHEL 8+。**Alpine（musl）不可用** |
| 内存 | ≥ 2 GB | Electron + SnowLuma + Linux QQ 三套运行时并存 |
| 磁盘 | ≥ 4 GB 可用 | 程序约 300 MB，加上 QQ 与运行数据 |
| 桌面 | 需要图形环境 | 扫码登录 QQ 必须有可见窗口；无头机器请见第五节 |
| 系统 QQ | **需要自行安装** | Linux 上没有「便携 QQ」，见第三节 |

> ⚠️ **不要用 `sudo` 运行本程序。** 数据目录已按 XDG 规范落到你的用户主目录，
> 用 sudo 跑会让数据属主变成 root，之后以普通用户启动会读写失败。

---

## 二、安装

包文件名以实际构建为准（本次交付的三个包）：

```
qq-agent-v0.4.4-amd64.deb          117 MB
qq-agent-v0.4.4-x86_64.rpm         103 MB
qq-agent-v0.4.4-x86_64.AppImage    150 MB
```

### Debian / Ubuntu（.deb）

```bash
sudo apt install ./qq-agent-v0.4.4-amd64.deb
```

`apt` 会自动装上运行所需的系统库。若报缺依赖，手动补齐：

```bash
sudo apt install -y libnss3 libgtk-3-0 libasound2t64 libgbm1 \
                    libxkbcommon0 libdrm2 libxss1 xdg-utils
```

> 注意：Ubuntu 24.04 起 `libasound2` 已改名为 `libasound2t64`。
> 老版本（20.04/22.04）用 `libasound2`。
> 装完可用 `qq-agent` 直接启动（包内已通过 update-alternatives 注册到 `/usr/bin/`）。

### RHEL / Fedora / Rocky（.rpm）

```bash
sudo dnf install ./qq-agent-v0.4.4-x86_64.rpm
```

依赖会被自动装好，**不需要手动补**。本包声明的 8 个依赖
（`alsa-lib`、`gtk3`、`libXScrnSaver`、`libdrm`、`libxkbcommon`、
`mesa-libgbm`、`nss`、`xdg-utils`）已在**真实 Fedora 44** 上实测全部解析成功，
`dnf` 会自动拉入 121 个依赖包。

> 这一条值得强调：electron-builder 默认照抄 Debian 系依赖名，而 RPM 系叫法不同。
> 依赖名写错时 `rpm -qpR` 照样能把名字打印出来，但 `dnf install` 会直接失败 ——
> **只看元数据看不出来，必须真机跑一次 dnf**。本包已通过。

### 任意发行版（AppImage）

```bash
chmod +x qq-agent-v0.4.4-x86_64.AppImage
./qq-agent-v0.4.4-x86_64.AppImage
```

AppImage **不安装系统依赖**，需自行确保第二节列出的库都存在，
并且系统里要有 `xdg-utils`（否则「打开数据目录」等按钮无效）。

> ⚠️ **Ubuntu 24.04+ 常见问题：需要 libfuse2。**
> 新版 Ubuntu 默认只装 libfuse3，而 AppImage 格式仍依赖 libfuse2，直接双击会报：
> ```
> dlopen(): error loading libfuse.so.2
> AppImages require FUSE to run.
> ```
> **这是 AppImage 格式的通用特性，与本程序无关**（任何 AppImage 都如此）。两种解法：
>
> ```bash
> # 解法一：补上兼容库（一次装好，之后可双击运行）
> sudo apt install libfuse2t64        # 22.04 及更早用 libfuse2
>
> # 解法二：不依赖 FUSE 运行（无需安装任何东西）
> ./qq-agent-v0.4.4-x86_64.AppImage --appimage-extract-and-run
> ```
>
> 解法二会把内部 squashfs 解到一个临时目录再执行，首次启动慢约 1-2 秒。
> 实测两种方式都能正常启动。

---

## 三、安装 Linux 版 QQ（必做，不可跳过）

SnowLuma 的工作方式是**注入一个正在运行的 QQ 客户端**。所以本程序**不替代 QQ**，
你必须另外装好 Linux 版 QQ。

```bash
# 从腾讯官方下载 Linux 版 deb（最新版地址见 https://im.qq.com/linuxqq/）
sudo apt install ./QQ_*.deb

# 确认安装位置（本程序会自动探测这些路径）
ls -l /opt/QQ/qq
```

程序会在以下路径自动查找 QQ：

```
/opt/QQ/qq            ← 官方 deb 的默认位置
/usr/bin/qq
/usr/local/bin/qq
/usr/lib/qq/qq
/opt/tencent-qq/qq
```

> ⚠️ **QQ 版本必须与 SnowLuma 兼容。** 版本错配会导致 SnowLuma 注入失败
> （表现为 QQ 能登录但机器人收不到消息）。若遇到这种情况，
> 换一个 SnowLuma 明确支持的 QQ 构建版本再试。

---

## 四、首次运行与配置

### 1. 启动

```bash
qq-agent                 # 命令行启动
```

或在应用菜单里找 **QQ Agent**。

### 2. 数据目录在哪

按 XDG 规范，数据落在用户主目录：

```bash
echo $XDG_DATA_HOME          # 若为空，实际是 ~/.local/share
ls ~/.local/share/qq-agent
```

多实例（`QQ_AGENT_PROFILE=2`）会使用 `~/.local/share/qq-agent-2`，
HTTP 与 OneBot 端口整体 +100，互不冲突。

可用环境变量覆盖（优先级最高，测试与便携场景用）：

```bash
QQ_AGENT_DATA_DIR=/mnt/data/qq-agent qq-agent
```

### 3. 在界面里依次做三件事

1. **启动 SnowLuma** —— 内置模式，日志会显示在内置控制台里
2. **启动 QQ** —— 会拉起系统 QQ（`/opt/QQ/qq`），弹出**扫码登录**窗口，用手机 QQ 扫码
3. **配置 OneBot** —— 在 SnowLuma 的 WebUI（默认 `http://127.0.0.1:5099`）里
   完成 OneBot 连接配置

### 4. 填 API

在「设置」里填 OpenAI 兼容 API 的 Base URL 与 Key，例如
`https://api.deepseek.com/v1`。

---

## 五、无头 / 服务器环境

扫码登录必须有图形界面。三种可行方案：

**方案 A：用 VNC / 远程桌面**
在带桌面的会话里启动，完成扫码后再让它在后台常驻。

**方案 B：X11 转发**
```bash
ssh -X user@host
qq-agent
```

**方案 C：虚拟屏 + 首次扫码用真实桌面**
```bash
xvfb-run -a qq-agent
```
但**二维码画在虚拟屏上，你看不到**。首次登录务必在真实桌面完成；
登录态会被保存，之后无头运行通常可复用（前提是 SnowLuma 的数据目录保持不变）。

无头环境还需要中文字体，否则卡片渲染出来是方块：

```bash
sudo apt install fonts-noto-cjk
```

---

## 六、⚠️ 必读：Linux 特有的坑

### 1. `kernel.yama.ptrace_scope` 必须为 0（最容易漏）

Ubuntu 默认 `ptrace_scope=1`，**禁止注入非子进程**。
SnowLuma 通过注入 QQ 进程来工作，会被内核直接拒绝，
报错形如 `COMPONENT_LOAD_FAILED`。

```bash
# 查看当前值
cat /proc/sys/kernel/yama/ptrace_scope

# 若为 1，临时放开（重启失效）
sudo sysctl -w kernel.yama.ptrace_scope=0

# 永久生效
echo "kernel.yama.ptrace_scope = 0" | sudo tee /etc/sysctl.d/99-ptrace-inject.conf
sudo sysctl -p /etc/sysctl.d/99-ptrace-inject.conf
```

> 这放宽了系统的一项安全限制（允许同用户进程间注入）。
> 请自行权衡：若这台机器不只是跑机器人，请了解其影响后再决定。

### 2. 三个进程必须都在，顺序有讲究

```
SnowLuma（协议端） → QQ 客户端（被注入） → QQ Agent（本体）
```

QQ Agent 启动时会自动拉起前两者，但如果你手动管理，务必按这个顺序。

### 3. 「停止 SnowLuma」按钮

- 由本程序拉起的：直接结束子进程
- **外部启起的**：按「命令行含 `<snowluma目录>/index.mjs`」匹配进程后结束
  （Windows 上走 PowerShell，Linux 上读 `/proc`）

程序**绝不会按进程名批量杀 node** —— 那样会杀掉你机器上其它 Node 程序。

### 4. 想开机自启？

目前没有内置自启。用 systemd 用户服务：

```ini
# ~/.config/systemd/user/qq-agent.service
[Unit]
Description=QQ Agent
After=graphical-session.target

[Service]
ExecStart=/opt/QQ Agent/qq-agent --no-sandbox
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
loginctl enable-linger $USER        # 允许未登录时也运行
systemctl --user daemon-reload
systemctl --user enable --now qq-agent
```

> `.deb` / `.rpm` 安装的实际路径请用 `dpkg -L qq-agent | grep -i bin` 确认。

---

## 七、故障排查

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| 启动后窗口空白 / 立刻退出 | 缺 Electron 运行库 | `ldd` 查看缺失的 `.so`，按第二节补装 |
| 提示无法写入数据目录 | 之前用 sudo 跑过，属主错了 | `sudo chown -R $USER ~/.local/share/qq-agent` |
| QQ 起来了但机器人收不到消息 | `ptrace_scope` 未放开 | 见第六节第 1 条 |
| 同上，且 `ptrace_scope` 已是 0 | QQ 版本与 SnowLuma 不匹配 | 换 QQ 构建版本 |
| 卡片图片中文是方块 | 缺中文字体 | `sudo apt install fonts-noto-cjk` |
| 「打开数据目录」没反应 | 缺 xdg-utils | `sudo apt install xdg-utils` |
| 扫码窗口看不到 | 无头环境 / 虚拟屏 | 见第五节 |
| 双开导致机器人重复回复 | 单实例锁被绕过 | 确认没有用不同 `QQ_AGENT_DATA_DIR` 启动两份 |
| **日志出现 `GPU process isn't usable. Goodbye.`** | 环境 GPU 转发不可用（**常见于 WSLg；实测显式传 `--disable-gpu` 也挡不住**） | **通常可忽略**：后端功能不受影响（实测数据目录与技能加载均正常）。若确需消除，参见下方说明 |
| **AppImage 报 `libfuse.so.2` 缺失** | Ubuntu 24.04+ 默认只有 libfuse3 | `sudo apt install libfuse2t64`，或加 `--appimage-extract-and-run` |
| **日志提示 `未找到 DATA_DIR/affinity/state.json`** | 好感度档案未迁移 | 技能本身正常（只读设计），只是注入为空。把 Windows 侧 `data/affinity/state.json` 拷过去即可 |

### 关于 `GPU process isn't usable` 这一点

这是排查表里唯一容易被误判为故障的项，单独说明。实测对照（四种参数组合各跑一次）：

| 启动参数 | GPU FATAL 次数 | 数据目录 |
| --- | --- | --- |
| 默认 | 1 | ✅ 正常创建 |
| `--disable-gpu --disable-software-rasterizer` | **1**（挡不住） | ✅ 正常创建 |
| `--use-gl=swiftshader` | 1 | ✅ 正常创建 |
| `--in-process-gpu` | 0 | ✅ 但引发 30 次渲染崩溃，**不推荐** |

**结论**：程序自身的 `main.js` 已经在默认情况下加了 `--disable-gpu`，
但该报错与这个开关无关 —— 是运行环境的 GPU 转发能力问题（WSLg 尤甚）。
**关键判据是数据目录有没有建出来、后端日志有没有正常输出**；只要这两项正常，
就可以继续用。若在真实桌面环境仍频繁出现，可设 `QQ_AGENT_ENABLE_GPU=1` 走另一条分支对比。

查看日志：

```bash
# 程序日志
ls ~/.local/share/qq-agent/logs
tail -f ~/.local/share/qq-agent/logs/*.log

# 若用 systemd 管理
journalctl --user -u qq-agent -f
```

---

## 八、卸载

```bash
# Debian / Ubuntu
sudo apt remove qq-agent

# RHEL / Fedora
sudo dnf remove qq-agent
```

**用户数据不会被删除**（这是有意的）。

要彻底清理：

```bash
rm -rf ~/.local/share/qq-agent
```

---

## 九、许可与声明

- 本项目（QQ Agent）由其原作者 **Kondius** 以 **MIT 许可证**发布，
  原仓库：<https://github.com/Kondius/qq-agent>
- 本 Linux 移植版是在原版基础上做的平台适配改造，**保留原作者署名与 MIT 许可**。
- 内置的 **SnowLuma** 协议端是独立第三方项目
  （<https://github.com/SnowLuma/SnowLuma>），采用**源码可见非商业许可**，
  **不是** OSI 开源许可。商业使用需另行取得其书面授权。
- 本程序与腾讯 / QQ 官方无隶属或授权关系。请遵守《QQ 用户协议》及当地法律。
