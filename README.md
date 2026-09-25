# QQ-Agent for Linux

> 把 QQ-Agent V0.4.4（Windows 桌面版，Node.js + Electron）移植到 Linux，
> 并打包为 **`.deb` / `.rpm` / AppImage** 三种可直装的发行包。

[![Platform](https://img.shields.io/badge/platform-Linux-blue)](#)
[![Arch](https://img.shields.io/badge/arch-x86__64-lightgrey)](#)
[![Based on](https://img.shields.io/badge/based%20on-QQ--Agent%20v0.4.4-4b8bbe)](#-许可与署名)
[![Protocol](https://img.shields.io/badge/OneBot-v11-8aadf4)](#)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

---

## 📖 这是什么

[QQ Agent](https://github.com/Kondius/qq-agent) 是一个接 OpenAI 兼容 API 的 QQ 群 AI 机器人，
自带 16 个技能与 12 个插件，通过 **OneBot v11** 协议与 [SnowLuma](https://github.com/SnowLuma/SnowLuma)
协议端通信。

它原本是 Windows 桌面程序。**本仓库是它的 Linux 移植版**：修复了全部 Windows-only 硬编码，
把数据目录改到 XDG 规范位置，并内置了 Linux 版 SnowLuma 协议端与 Linux 版 Electron 运行时，
最终产出三种安装包。

## 📦 发行包

| 格式 | 文件 | 安装 |
| --- | --- | --- |
| Debian / Ubuntu | `qq-agent-v0.4.4-amd64.deb` | `sudo apt install ./qq-agent-v0.4.4-amd64.deb` |
| RHEL / Fedora / Rocky | `qq-agent-v0.4.4-x86_64.rpm` | `sudo dnf install ./qq-agent-v0.4.4-x86_64.rpm` |
| 通用 | `qq-agent-v0.4.4-x86_64.AppImage` | `chmod +x` 后直接运行 |

**架构**：x86_64 · 三种包合计约 370 MB

> 包体积大的原因是**自包含**：内含官方 SnowLuma Linux 协议端（44 MB，自带 Node 运行时）
> 与 Electron 33 运行时。好处是用户不必另装 Node，也不必单独部署协议端。

### 快速开始

```bash
# Debian / Ubuntu
sudo apt install ./qq-agent-v0.4.4-amd64.deb && qq-agent

# RHEL / Fedora
sudo dnf install ./qq-agent-v0.4.4-x86_64.rpm && qq-agent

# 任意发行版（AppImage）
chmod +x qq-agent-v0.4.4-x86_64.AppImage && ./qq-agent-v0.4.4-x86_64.AppImage
```

完整步骤（含必装的 Linux 版 QQ、扫码登录、协议端配置）见 **[安装与部署指南](docs/linux-install.md)**。

## ⚠️ 三件必须知道的事

### 1. 必须先自行安装 Linux 版 QQ

SnowLuma 的工作方式是**注入一个正在运行的 QQ 客户端**，所以本程序**不替代 QQ**：

```bash
# 从 https://im.qq.com/linuxqq/ 下载 deb
sudo apt install ./QQ_*.deb         # 装完在 /opt/QQ/qq
```

程序会自动探测 `/opt/QQ/qq`、`/usr/bin/qq` 等常见路径。
**QQ 版本需与 SnowLuma 兼容**，版本错配会导致注入失败（表现为 QQ 能登录但机器人收不到消息）。

### 2. 需要放开 `kernel.yama.ptrace_scope`

Ubuntu 默认 `ptrace_scope=1`，禁止注入非子进程，SnowLuma 会报 `COMPONENT_LOAD_FAILED`：

```bash
echo "kernel.yama.ptrace_scope = 0" | sudo tee /etc/sysctl.d/99-ptrace-inject.conf
sudo sysctl -p /etc/sysctl.d/99-ptrace-inject.conf
```

> 这放宽了系统的一项安全限制（允许同用户进程间注入）。请自行权衡影响后再决定。

### 3. 不要用 `sudo` 运行

数据目录已按 XDG 规范落在用户主目录。用 sudo 跑会让属主变成 root，之后以普通用户启动会读写失败。

## 🔧 移植改动

### 数据目录遵循 XDG 规范

| | 原实现（Windows） | 移植后（Linux） |
| --- | --- | --- |
| 数据目录 | `<安装目录>/data` | `$XDG_DATA_HOME/qq-agent`（缺省 `~/.local/share/qq-agent`） |
| 多实例 | `<安装目录>/data-2` | `~/.local/share/qq-agent-2` |

原实现把数据放在安装目录内。Windows 上没问题，但 Linux 装到 `/opt` 后该目录对普通用户只读，
启动即 `EACCES`；若改用 sudo 运行，数据属主会变成 root，后续升级更麻烦。

**Windows 行为未改变**，仍落在安装目录下。

### 修复的 Windows-only 硬编码

| 原实现 | 问题 | 现实现 |
| --- | --- | --- |
| `node.exe` + `launcher.bat` + `cmd.exe` | Linux 全不存在，**SnowLuma 两条启动路径全断** | 三级运行时兜底：发行包自带 node → 系统 node → **Electron 内置 Node**；回退 `launcher.sh` |
| `wmic process where ...` | Linux 无 wmic，UI 的「停止 SnowLuma」对外部实例完全失效 | 读 `/proc/<pid>/cmdline` 匹配（零依赖） |
| `explorer.exe` ×2、`cmd.exe` ×1 | 三个 API 必然返回 500 | `xdg-open` |
| `QQ.exe` 便携端 | Linux 无「便携端」概念 | 探测系统 QQ（`/opt/QQ/qq` 等），仍用独立 `--user-data-dir` 隔离 |

所有平台差异收敛到 **`src/platform.js`**（新增，约 12 KB），业务代码不再直接出现平台命令。

### 打包配置

`package.json` 的 `build` 字段重建，加入 Linux 三种 target、依赖声明与 `asarUnpack`。

**`asarUnpack` 是关键**：SnowLuma 必须解包到 `app.asar.unpacked/`，
因为 asar 内的文件**无法被 `spawn` 执行** —— 留在里面协议端就起不来。

## ✅ 验证情况

三种包都做了实测，不是"构建成功"就交付：

| 项目 | 结果 |
| --- | --- |
| 平台层单元测试 | **35/35**（真实 Linux 上跑；`/proc` 解析用 fixture 模拟，Windows 上也能测） |
| `.deb` 真机安装冒烟 | **25/25**（apt 安装 → 验文件/协议端/运行时/XDG → 卸载 → 确认用户数据保留） |
| `.rpm` 冒烟 | **18/18**（`rpm2cpio` 解包 + 与 `.deb` 逐条对照 44 条一致 + 真实启动） |
| AppImage 冒烟 | **7/7**（实测启动，退出码 124 = 进程持续存活） |
| 插件与技能加载 | **`loadPlugins()` 已加载 70 / 失败 0**，`skillManager` 加载错误 0 |
| 数据目录 XDG 落点 | 实测 `/home/<user>/.local/share/qq-agent`，**不在安装目录内** |

### 关于 `.rpm` 的验证方式（如实说明）

WSL 是 Ubuntu，无法 `rpm -i`（会把文件塞进 dpkg 系统且依赖解析混乱）。
采用的是等价验证：`rpm2cpio` 解出完整文件树 + 与 `.deb` 内容逐条对照 + 用解出的文件树真实启动。

**局限性**：未经 rpm 数据库注册，因此 **pre/post 脚本执行与 rpm 依赖解析这两项未经验证**
（依赖名已用 `rpm -qpR` 单独核对，含 `xdg-utils` 等 9 项）。
若需严格验证，请在 RHEL / Fedora 系真机上安装一次。

### 已知限制

- **WSLg 下会打印 GPU 报错**（`GPU process isn't usable. Goodbye.`）。
  四组对照实验确认：**显式传 `--disable-gpu` 也挡不住**，属环境 GPU 转发问题，不是移植缺陷；
  后端功能与数据目录均正常。真实桌面与纯服务器上表现不同，需真机复核。
- **AppImage 在 Ubuntu 24.04+ 需要 `libfuse2`**（`sudo apt install libfuse2t64`），
  或加 `--appimage-extract-and-run` 运行。这是 AppImage 格式的通用特性，与本项目无关。
- **插件/技能的可选依赖**：部分插件依赖 MongoDB 或语义向量服务，缺失时会自动降级并打日志。

详见 **[交付与验证报告](docs/linux-delivery-report.md)**。

## 📚 文档

| 文档 | 内容 |
| --- | --- |
| [安装与部署指南](docs/linux-install.md) | 系统要求、三种包安装、Linux QQ、XDG 数据目录、systemd 自启、11 项故障排查 |
| [交付与验证报告](docs/linux-delivery-report.md) | 目标逐条验收、验证方法与结果、已知限制 |
| [移植改动清单](docs/linux-port-findings.md) | 侦察出的硬编码点与施工优先级 |
| [构建脚本](build-scripts/) | 26 个脚本：同步源码 → 取协议端 → 构建 → 三套冒烟 → 收回产物 |

### 复现构建

需要 Linux 环境（实测 Ubuntu 26.04 / WSL2）与 Node.js 20+。脚本已处理路径、行尾与镜像问题：

```bash
wsl -d Ubuntu -- bash /mnt/<盘>/.../build-scripts/bootstrap-wsl-scripts.sh  # 放入构建脚本
wsl -d Ubuntu -- bash /mnt/<盘>/.../build-scripts/pipeline.sh               # 同步→装协议端→构建
wsl -d Ubuntu -- bash /mnt/<盘>/.../build-scripts/verify-all.sh             # 三套冒烟 + 产物指纹核对
wsl -d Ubuntu -- bash /mnt/<盘>/.../build-scripts/collect-artifacts.sh      # 收回产物与校验和
```

构建前会自动跑平台层单测，因此"能构建"本身就意味着核心逻辑自洽。

## ⚖️ 许可与署名

- **上游项目**：QQ Agent，作者 **Kondius**，**MIT** 许可 —— <https://github.com/Kondius/qq-agent>
  本移植版**保留原作者署名**（`package.json` 的 `author` 字段未改动），并随附上游 [LICENSE](LICENSE)。
- **本移植版的 `maintainer`** 为 `prolet1966` —— 这是「这个重打包的 Linux 包出问题找谁」的字段，
  与原作者署名是两件事。
- **SnowLuma**（内置的协议端）是独立第三方项目，采用**源码可见非商业许可**，
  **不是** OSI 开源许可；商业使用需另行取得其书面授权。
  其 `EULA.md` 与 `PRIVACY.md` 随包分发在 `snowluma/` 目录内。
- 本项目与腾讯 / QQ 官方**无隶属或授权关系**。请遵守《QQ 用户协议》及当地法律法规。

## 🤝 反馈

欢迎提交 Issue 反馈 Linux 平台上的兼容问题。

提交日志时请**先剔除 token、QQ 号、IP 等敏感信息**。
程序默认会对日志里的长数字 ID 打码（`core.log_show_raw_ids = false`），
但配置文件与数据目录中的内容仍需自行检查。

---

<p align="center">
  <sub>Linux port of QQ Agent v0.4.4 · OneBot v11 · Powered by SnowLuma · x86_64</sub>
</p>
