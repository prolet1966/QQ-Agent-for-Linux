# QQ-Agent for Linux

> 把 QQ-Agent V0.4.4（Windows 桌面版，Node.js + Electron）移植到 Linux，
> 并打包为 **`.deb` / `.rpm` / AppImage** 三种可直装的发行包。
> **x86_64 与 arm64 双架构**，各自独立构建与验证。

[![Platform](https://img.shields.io/badge/platform-Linux-blue)](#)
[![Arch](https://img.shields.io/badge/arch-x86__64%20%2B%20arm64-lightgrey)](#-发行包)
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

**两种架构，三种格式，共六个包。先确认自己的架构：**

```bash
uname -m
# x86_64 / amd64  → 用 x86_64 那三个
# aarch64 / arm64  → 用 arm64 那三个
```

> ⚠️ **`.deb` 与 `.rpm` 的架构名不一样**：deb 系写 `amd64`/`arm64`，rpm 系写 `x86_64`/`aarch64`。
> 这是两个生态各自的命名习惯，不是笔误。
> **树莓派必须是 64 位系统**（`uname -m` 得是 `aarch64`）；32 位 ARM（`armv7l`）Electron 不支持。

### x86_64（Intel / AMD）

| 格式 | 文件 | 安装 |
| --- | --- | --- |
| Debian / Ubuntu | `qq-agent-v0.4.4-amd64.deb` | `sudo apt install ./qq-agent-v0.4.4-amd64.deb` |
| RHEL / Fedora / Rocky | `qq-agent-v0.4.4-x86_64.rpm` | `sudo dnf install ./qq-agent-v0.4.4-x86_64.rpm` |
| 通用 | `qq-agent-v0.4.4-x86_64.AppImage` | `chmod +x` 后直接运行 |

### arm64（Apple Silicon / 树莓派 4+ / ARM 服务器）

| 格式 | 文件 | 安装 |
| --- | --- | --- |
| Debian / Ubuntu | `qq-agent_0.4.4_arm64.deb` | `sudo apt install ./qq-agent_0.4.4_arm64.deb` |
| RHEL / Fedora / Rocky | `qq-agent-0.4.4-1.aarch64.rpm` | `sudo dnf install ./qq-agent-0.4.4-1.aarch64.rpm` |
| 通用 | `QQ-Agent-0.4.4-aarch64.AppImage` | `chmod +x` 后直接运行 |

> arm64 三个包合计约 370 MB（单架构）。
> 校验和见各 Release 的 `SHA256SUMS.txt`。

> 包体积大的原因是**自包含**：内含官方 SnowLuma Linux 协议端（44 MB，自带 Node 运行时）
> 与 Electron 33 运行时。好处是用户不必另装 Node，也不必单独部署协议端。

### 快速开始

```bash
# ── x86_64 ──
# Debian / Ubuntu
sudo apt install ./qq-agent-v0.4.4-amd64.deb && qq-agent
# RHEL / Fedora
sudo dnf install ./qq-agent-v0.4.4-x86_64.rpm && qq-agent
# 任意发行版（AppImage）
chmod +x qq-agent-v0.4.4-x86_64.AppImage && ./qq-agent-v0.4.4-x86_64.AppImage

# ── arm64（文件名不同，注意区分）──
# Debian / Ubuntu
sudo apt install ./qq-agent_0.4.4_arm64.deb && qq-agent
# RHEL / Fedora
sudo dnf install ./qq-agent-0.4.4-1.aarch64.rpm && qq-agent
# 任意发行版（AppImage）
chmod +x QQ-Agent-0.4.4-aarch64.AppImage && ./QQ-Agent-0.4.4-aarch64.AppImage
```

> **务必用 `apt install ./文件`（带 `./`）**，apt 才会自动补依赖；
> 直接 `dpkg -i` 不会装依赖，会留下装了一半的状态。

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

三种包都做了实测，不是"构建成功"就交付。

### x86_64

| 项目 | 结果 |
| --- | --- |
| 平台层单元测试 | **35/35**（真实 Linux 上跑；`/proc` 解析用 fixture 模拟，Windows 上也能测） |
| `.deb` 真机安装冒烟 | **25/25**（apt 安装 → 验文件/协议端/运行时/XDG → 卸载 → 确认用户数据保留） |
| `.rpm` 冒烟 | **18/18**（`rpm2cpio` 解包 + 与 `.deb` 逐条对照 44 条一致 + 真实启动） |
| AppImage 冒烟 | **7/7**（实测启动，退出码 124 = 进程持续存活） |
| 插件与技能加载 | **`loadPlugins()` 已加载 70 / 失败 0**，`skillManager` 加载错误 0 |
| 数据目录 XDG 落点 | 实测 `/home/<user>/.local/share/qq-agent`，**不在安装目录内** |

### arm64

arm64 走独立的 CI：在 **GitHub 原生 `ubuntu-24.04-arm` runner**（真 aarch64，非模拟）上
构建并跑完整冒烟。之所以不用 `qemu-user` 模拟：Chromium 在模拟下会因 JIT/seccomp 闪退，
**结论不可信，所以没有拿它充数**。

| 项目 | 结果 |
| --- | --- |
| 载荷架构审计 | **13 个 ELF 全部 AArch64**，0 个 x86_64、0 个 Windows 组件（PE） |
| 原生件齐全 | `snowluma-linux-arm64` / `websocket-linux-arm64` / `ffmpegAddon.linux.arm64` **四个全在且均为 AArch64** |
| `.deb` 真实安装 + 冒烟 | **29 通过 / 0 失败 / 1 警告**（唯一警告：`dpkg -i` 缺依赖，`apt-get -f install` 补上，属预期） |
| `.rpm` 真实安装 + 冒烟 | **29 通过 / 0 失败 / 2 警告** |
| AppImage 真实运行冒烟 | **31 通过 / 0 失败 / 0 警告**（含 FUSE 与免 FUSE 两模式） |
| rpm 依赖解析 | 对照 **Fedora 44 / CentOS Stream 9 / Rocky Linux 9 真实元数据**做完整闭包解析，**通过** |
| 启动后可用性 | 控制台 **3210 端口已监听**，`GET /api/config` 返回 **200** 且为合法 JSON（19899 字节，UTF-8 不乱码） |
| 数据目录落点 | 实测 `/home/runner/.local/share/qq-agent/data`，`/opt` 下无 `data`（程序与数据分离成立） |
| 隐私红线 | 无 `snowluma/data`、`config`、`logs`、`.db`、`.log`、`community.key` |
| 沙箱降级回归 | **启动器侧 5/5 · AppRun 侧 5/5**（含 `nosuid` 挂载实测；两侧均为**硬门**，缺一即构建失败） |
| CI 全流程 | **19 步执行全通过**（共 20 步，第 20 步为「仅失败时收集诊断」） |

**arm64 冒烟的测试盲区（如实说明）**：未覆盖真实 QQ 客户端登录、扫码、
SnowLuma 实际注入与 OneBot 消息收发（需要真实 QQ 账号与 Linux QQ 客户端，CI 环境不具备）；
未覆盖多显示器、中文输入法、声音输出。

### arm64 真机测试（志愿者实测）→ 已修复

> 上表的 CI 环境是**干净的原生 runner**。而在真实机器上（Apple Silicon 的 Parallels 虚拟机，
> Kali Linux 2026.2 arm64），arm64 的 **AppImage 可正常启动，`.deb` 启动失败**。
> 二者唯一实质差异是沙箱策略：AppImage 的启动器会检测 `chrome-sandbox` 是否**真正生效**
> （setuid 位 + 属主 root + 所在挂载点非 `nosuid`）并降级 `--no-sandbox`，
> 而当时的 `.deb` / `.rpm` 启动器**只判 setuid 位**，在虚拟机的 `nosuid` 挂载下会误判为
> 「沙箱可用」而触发 Chromium 的 FATAL。

**已修复**：`.deb` / `.rpm` 启动器改用与 AppImage 一致的三重判据
（`sandbox_reason()`：位 / 属主 / 挂载点全查），确认不可用时**显式降级 `--no-sandbox`
并提示一次**（附可操作的修法；`nosuid` 挂载会明说「chmod 无效」并指向虚拟机这一限制）。

> 这是**判定确实用不了才降级**，不是无条件关沙箱 —— 沙箱可用时行为与之前完全一致。

修复已在原生 aarch64 runner 上验证（run `36432644402`，20 步全通过）。
新增的 `test/41-launcher-sandbox-test.sh` 是**硬门**：它同时验判据本身
（5 个用例）与「降级有没有真的接到 `exec` 上」—— 只写函数不接到 exec，降级就是个摆设，
行为与修复前完全一样，而**这正是当初漏掉这个 bug 的那层空白**。
测试里还留了一条对照断言，把「老逻辑在 `nosuid` 下确实会误判」钉死，免得后人当成玄学。

### 关于 `.rpm` 的验证方式（如实说明）

WSL 是 Ubuntu，无法 `rpm -i`（会把文件塞进 dpkg 系统且依赖解析混乱）。
采用的是等价验证：`rpm2cpio` 解出完整文件树 + 与 `.deb` 内容逐条对照 + 用解出的文件树真实启动。

**x86_64 的局限性**：未经 rpm 数据库注册，因此 **pre/post 脚本执行与 rpm 依赖解析这两项未经验证**
（依赖名已用 `rpm -qpR` 单独核对，含 `xdg-utils` 等 9 项）。
若需严格验证，请在 RHEL / Fedora 系真机上安装一次。

> **arm64 已补上这一项**：arm64 的 rpm 是在原生 `ubuntu-24.04-arm` 上用 `rpm -i` **真实安装**的，
> pre/post 脚本与安装流程均已执行；另外用 `dnf` 对照 Fedora / CentOS Stream 9 / Rocky 9
> 的真实元数据做了完整依赖闭包解析。
> 但**仍未在真实 RHEL 系发行版上 `dnf install` 过** —— 文件冲突、脚本执行差异这类问题查不出来。

### 已知限制（两种架构通用）

- **WSLg 下会打印 GPU 报错**（`GPU process isn't usable. Goodbye.`）。
  四组对照实验确认：**显式传 `--disable-gpu` 也挡不住**，属环境 GPU 转发问题，不是移植缺陷；
  后端功能与数据目录均正常。真实桌面与纯服务器上表现不同，需真机复核。
- **AppImage 在 Ubuntu 24.04+ 需要 `libfuse2`**（`sudo apt install libfuse2t64`），
  或加 `--appimage-extract-and-run` 运行。这是 AppImage 格式的通用特性，与本项目无关。
- **AppImage 形态下 Chromium 沙箱会关闭**：AppImage 经 FUSE 挂载，而 FUSE 挂载默认带 `nosuid`，
  setuid 沙箱无法生效。启动器会**检测到并显式降级 `--no-sandbox` 并提示一次**（非静默）。
  需要沙箱请用 `.deb` / `.rpm`。
- **插件/技能的可选依赖**：部分插件依赖 MongoDB 或语义向量服务，缺失时会自动降级并打日志。
- **纯 SSH 无桌面环境跑不起来**：Electron 需要图形会话。调试可用 `xvfb-run`。
- **SnowLuma 注入需要放开 `ptrace_scope`**：若为 `3` 会拒绝注入，见上文「三件必须知道的事」。

详见 **[交付与验证报告](docs/linux-delivery-report.md)**。

## 📚 文档

| 文档 | 读者 | 内容 |
| --- | --- | --- |
| [安装与部署指南](docs/linux-install.md) | 使用者 | 系统要求、三种包安装、Linux QQ、XDG 数据目录、systemd 自启、11 项故障排查 |
| [说明](docs/洛版-for-Linux-说明.md) | 使用者 | 更口语化的入门说明：三个包怎么选、两步必做前置、首次流程、常见问题 |
| [交付与验证报告](docs/linux-delivery-report.md) | 使用者 / 维护者 | 目标逐条验收、验证方法与结果、已知限制 |
| [移植改动清单](docs/linux-port-findings.md) | 维护者 | 侦察出的硬编码点与施工优先级 |
| [交接文档](docs/洛版-for-Linux-交接文档.md) | **维护者** | 架构、改动技术要点、构建与发布流程、凭据处理、已知技术债、待办清单 |
| [上游 README（原版功能说明）](docs/上游README-原版功能说明.md) | 使用者 | 上游作者写的完整功能说明，讲清了各技能/插件能做什么 |
| [构建脚本](build-scripts/) | 维护者 | 26 个脚本：同步源码 → 取协议端 → 构建 → 三套冒烟 → 收回产物 |

> **接手维护请先读交接文档。** 里面记了几个「改错就会出故障」的点：
> `asarUnpack` 不能删（协议端起不来）、进程匹配不能按名杀（会误杀用户程序）、
> 推送前必须跑凭据清理（源码树里混着真实数据）。

### 复现构建
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

#### arm64 的构建方式（与 x86_64 不同）

arm64 **不走上面的 WSL 路径**。原因有两个，都很硬：

1. **不能只用模拟器验收**：`qemu-user` 跑 Chromium 会因 JIT / seccomp 直接闪退，
   冒烟结论不可信。所以 arm64 的验证在 **GitHub 原生 `ubuntu-24.04-arm` runner** 上做。
2. **arm64 的 rpm 不能在 x86_64 上打**：`rpmbuild` 有硬性跨架构保护
   （试过 8 种宏覆盖 + 补 `buildarch_compat` 表，全部无效）。CI 上是原生 aarch64，
   所以不存在这个问题。

触发方式（工作流 `.github/workflows/build-linux-arm64.yml`）：

```bash
# 打 tag 直接触发，不必先合并
git tag v0.4.4-arm64 && git push origin v0.4.4-arm64
```

工作流会跑完 19 步：工具链 → 隐私自检 → 解包 arm64 运行时 → 组装 → 架构审计 →
打三种包 → 静态校验 → deb/rpm/AppImage 三套冒烟 → rpm 依赖解析 → 上传产物与报告。

## ⚖️ 许可与署名

- **上游项目**：QQ Agent，作者 **Kondius**，**MIT** 许可 —— <https://github.com/Kondius/qq-agent>
  本移植版**保留原作者署名**（`package.json` 的 `author` 字段未改动），并随附上游 [LICENSE](LICENSE)。
- **本移植版的 `maintainer`** 为 `prolet1966` —— 这是「这个重打包的 Linux 包出问题找谁」的字段，
  与原作者署名是两件事。
- **SnowLuma**（内置的协议端）是独立第三方项目，采用**源码可见非商业许可**，
  **不是** OSI 开源许可；商业使用需另行取得其书面授权。
  其 `EULA.md` 与 `PRIVACY.md` 随包分发在 `snowluma/` 目录内。
- 本项目与腾讯 / QQ 官方**无隶属或授权关系**。请遵守《QQ 用户协议》及当地法律法规。

## 💐 鸣谢

- **[`@楚嘉墨是猫娘又怎样`](https://github.com/楚嘉墨是猫娘又怎样)** — arm64 **真机测试者**
  提供了本移植版最关键的一次反馈。在 Apple Silicon 的 **Parallels 虚拟机（Kali Linux 2026.2 arm64）**
  上实测三个安装包时发现：**AppImage 能正常启动，`.deb` 启动失败**，并如实回报了
  「要不要装 Chromium」的疑问。
  正是这条「同一台机器、同一份程序、只有沙箱策略不同」的对比，
  把排查范围从十几个可能性收敛到一处：AppImage 的启动器会检测
  `chrome-sandbox` 是否真正生效（setuid 位 + 属主 root + 所在挂载点非 `nosuid`）
  并在失效时优雅降级 `--no-sandbox`，而 `.deb` / `.rpm` 的启动器只看 setuid 位，
  在虚拟机的 `nosuid` 挂载下会误判为「沙箱可用」而硬撞 Chromium 的 FATAL。
  静态审计（ELF 架构、权限位、依赖解析）无论如何都发现不了这类问题 ——
  **只有真的在机器上跑一次才会暴露。** 衷心感谢！

## 🤝 反馈

欢迎提交 Issue 反馈 Linux 平台上的兼容问题。

提交日志时请**先剔除 token、QQ 号、IP 等敏感信息**。
程序默认会对日志里的长数字 ID 打码（`core.log_show_raw_ids = false`），
但配置文件与数据目录中的内容仍需自行检查。

---

<p align="center">
  <sub>Linux port of QQ Agent v0.4.4 · OneBot v11 · Powered by SnowLuma · x86_64</sub>
</p>
