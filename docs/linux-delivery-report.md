# Linux 移植 · 交付与验证报告

> **完成时间**：2026-09-25
> **目标**：把 QQ-Agent V0.4.4（Node.js + Electron）改造成 Linux 版本并交付三种安装包
> **状态**：✅ **已完成并验证 · 已发布到 GitHub**

---

## 〇、发布地址

| 内容 | 地址 |
| --- | --- |
| 源码仓库 | <https://github.com/prolet1966/QQ-Agent-for-Linux> |
| **发行包下载** | <https://github.com/prolet1966/QQ-Agent-for-Linux/releases/tag/v0.4.4-linux> |

> 安装包走 **GitHub Release 附件**而不是提交进仓库：三个包合计约 370 MB，
> 其中 deb / rpm / AppImage 均**超过 GitHub 单文件 100 MB 限制**，无法直接入仓。

---

## 一、交付物

位置：`port/dist/`（同时保留在 WSL `~/qq-agent-linux/app/dist/`），并已上传到 Release。

| 文件 | 大小 | SHA256（前 16 位） |
| --- | --- | --- |
| `qq-agent-v0.4.4-amd64.deb` | 116.6 MB | `023ebec3b80c565a` |
| `qq-agent-v0.4.4-x86_64.rpm` | 103.1 MB | `7eab74f312d81373` |
| `qq-agent-v0.4.4-x86_64.AppImage` | 149.9 MB | `71fa67768a37a8bf` |

完整校验和见 `port/dist/SHA256SUMS.txt`，**已随 Release 一起发布**，
并已核对远端与本地逐位一致。

**这三个 SHA256 与验证时记录的产物指纹逐位一致** —— 即「验过的包」就是「发布的包」，
中间没有被重新构建替换过（见第四节 4.5）。

---

## 二、目标要求逐条验收

目标原文的每一项，以及对应的验证证据：

| # | 要求 | 状态 | 证据 |
| --- | --- | --- | --- |
| 1 | 交付 `.deb` | ✅ | 122,118,184 字节，1 个 deb 包 |
| 2 | 交付 `.rpm` | ✅ | 107,964,384 字节，1 个 rpm 包 |
| 3 | 在 WSL 真机安装并跑通冒烟测试 | ✅ | .deb **25/25**，.rpm **18/18** |
| 4 | 再制作通用版 AppImage | ✅ | 按目标顺序在冒烟之后重出，**7/7** |
| 5 | 包含官方 SnowLuma Linux 协议端（linux-x64 完整版） | ✅ | v1.14.19，SHA256 与官方 digest 逐位匹配 |
| 6 | 包含 Linux 版 Electron 运行时 | ✅ | Electron 33.2.0，`linux-unpacked` 内含 chrome-sandbox / libEGL.so |
| 7 | x86_64 架构 | ✅ | 三包均为 `ELF 64-bit LSB executable, x86-64` / `amd64` / `x86_64` |
| 8 | 数据目录遵循 XDG 落到用户主目录（不写安装目录） | ✅ | 实测建于 `~/.local/share/qq-agent`，且不在 `/opt` 下 |
| 9 | 修复全部 Windows-only 硬编码 | ✅ | 见第三节，活跃代码零残留 |

### 验收细节

**SnowLuma 完整性**（要求 5 的硬证据）：
```
本地文件 SHA256 : f0cbd19809327c3959c64083a008c136d9b7538f34a6763c21415fcf9d75f7a5
官方 release digest: sha256:f0cbd19809327c3959c64083a008c136d9b7538f34a6763c21415fcf9d75f7a5
→ 逐位匹配 ✅
```
包内 native 件为 `snowluma-linux-x64.node` / `snowluma-linux-x64.so` / `websocket-linux-x64.node`，
自带 `node` 为 x86-64 ELF 且带可执行位、实测可运行（`v22.13.0`）。**零 Windows 残留。**

**关键设计点：`asarUnpack` 生效。** SnowLuma 被解包到
`resources/app.asar.unpacked/snowluma/`，而不是留在 `app.asar` 里。
这点必须成立 —— asar 内的文件**无法被 spawn 执行**，留在里面 SnowLuma 就起不来。

**XDG 验收**（要求 8，本来最容易被漏掉）：
```
启动后数据目录: /home/kmy/.local/share/qq-agent
  配置 / 会话 / 记忆 / 日志 / 单实例锁 等全部在此
  不在安装目录内 ✅     卸载后未被删除 ✅
```

---

## 三、代码改动清单

| 文件 | 改动内容 |
| --- | --- |
| `src/platform.js` | **新增（12.2KB）** 平台抽象层，所有 OS 差异收敛于此 |
| `src/config.js` | `DATA_DIR` 改为 `resolveDataDir()` |
| `src/app.js` | SnowLuma 启动三级运行时兜底；`stopSnowluma` 改读 `/proc`；QQ 客户端适配系统 Linux QQ |
| `src/routes.js` | 3 处 `explorer.exe`/`cmd.exe` → `platform.openExternal`（`xdg-open`） |
| `electron/main.js` | 数据目录复用平台层（原有一份重复实现，注释写「数据目录固定在安装目录」） |
| `package.json` | 重建 `build`：deb/rpm/AppImage target、依赖声明、`asarUnpack`、maintainer |
| `examples/config-linux-overrides.json` | **新增** Linux 配置项通用参考模板（全占位符，不含任何人的真实路径） |
| `test/platform-test.mjs` | **新增** 35 项平台层测试 |
| `test/verify-linux.mjs` | **新增** Linux 实测值打印 |
| `test/direct-load-test.mjs` | **新增** 直连调用 `loadPlugins()`，拿权威加载结果 |
| `build-scripts/*.sh` | **新增 26 个脚本**，覆盖取源码 → 装协议端 → 构建 → 三套冒烟 → 收回产物 |

### 附带的扩展：17 个插件 + 25 个技能

把 V0.3.1 开发版中 V0.4.4 缺失的扩展一并纳入，合计 **29 插件 / 41 技能**。

**纳入前做了两项验证**（不是直接拷）：

1. **静态扫描**：确认待纳入插件**只使用 V0.4.4 提供的 api 方法**
   （`capability` / `config` / `log` / `warn`），不调用任何未提供的 api。
   其声明的部分能力（`affinity.*` / `bodystate.*` / `knowledge.*` 等）V0.4.4 宿主不认识，
   但 V0.4.4 对能力是**软依赖**语义 —— 宿主会为声明的能力自动注册 null provider，
   不认识也不会加载失败，只是没人消费。
2. **工具 id 冲突检查**：V0.4.4 已有工具 id 仅 4 个，25 个候选技能**零冲突**。

**全部新增条目 `enabledByDefault: false`**，即默认关闭、由用户在界面自行启用，
不会意外改变现有行为。

### 硬编码修复对照

| 原实现 | 问题 | 现实现 |
| --- | --- | --- |
| `DATA_DIR = ROOT/data` | Linux 装到 `/opt` 后只读，启动即 EACCES | `$XDG_DATA_HOME/qq-agent`（Windows 行为不变） |
| `node.exe` + `launcher.bat` + `cmd.exe` | Linux 全不存在，**两条启动路径全断** | 发行包 node → 系统 node → **Electron 内置 Node** 三级兜底；回退 `launcher.sh` |
| `wmic process where ...` | Linux 无 wmic，「停止」按钮失效 | 读 `/proc/<pid>/cmdline`（零依赖） |
| `explorer.exe` ×2、`cmd.exe` ×1 | 三个 API 必然 500 | `xdg-open` |
| `QQ.exe` 便携端 | Linux 无此概念 | 探测系统 QQ（`/opt/QQ/qq` 等），仍用独立 `--user-data-dir` 隔离 |

---

## 四、验证方法与结果

### 4.1 平台层单元测试：35/35

`node test/platform-test.mjs`，**在真实 Linux 上跑**（WSL Ubuntu 26.04）。

关键设计：`listProcessesProc()` 接受 `procRoot` 参数，可用 fixture 目录模拟 `/proc`，
所以 Linux 专有逻辑在 Windows 上也能测。

实测值核对（`test/verify-linux.mjs`）：
```
数据目录 : /home/kmy/.local/share/qq-agent     ← 不在安装目录内 ✅
多实例   : /home/kmy/.local/share/qq-agent-2
/proc    : 真读到 33 个进程，argv 完整 ✅
打开器   : xdg-open ✅
```

### 4.2 .deb 安装冒烟：25/25

真的 `apt install` 装上，验完再卸载：

| 检查组 | 项目 |
| --- | --- |
| 安装 | apt 成功、dpkg 状态 installed |
| 文件 | 主程序存在/可执行/为 x86-64 ELF、.desktop、图标 |
| SnowLuma | 已解包、index.mjs、自带 node 可运行、两个 .node、无 Windows 残留 |
| Electron | chrome-sandbox、libEGL.so、app.asar |
| XDG | 数据目录建于 XDG 位置、不在安装目录内 |
| 卸载 | 卸载成功、**用户数据未被删除** |

### 4.3 .rpm 真机安装冒烟：41/41 项 0 失败

**这一节此前是整个项目最大的缺口，2026-09-25 已补齐。**

#### 走过的弯路（记录在此，避免重蹈）

原计划是装一台 Fedora 虚拟机做真机测试。这条路连续撞上五道墙：

1. **kickstart 装不上**。netinst 上只有安装器没有软件包，最初的 `cdrom` 安装源是逻辑矛盾；
   换成网络源后，安装器停在**交互式** INSTALLATION SUMMARY，
   `Software Selection` 显红 `Warning checking software selection`，
   磁盘始终 3.8 MB、无任何写入 —— 完全无人值守的 ks 安装不会停在摘要页，
   说明 kickstart 根本没被读到。
2. **看不了屏幕**。`vmrun captureScreen` 要求先 `VixVM_LoginInGuest`（匿名 guest 操作被拒）。
3. **敲不进键盘**。`vmcli MKS sendKeySequence` / `sendKeyEvent` 全部静默无效
   （exit=0 但屏幕哈希一像素不变），进不了 TTY 读 anaconda 日志，也点不动摘要页按钮。
4. **VNC 连不上**。VMware 的 VNC 只提供安全类型 2，明文口令与 vmx 里
   `RemoteDisplay.vnc.key` 两种取 key 方式都被服务端直接断开。
5. **决定性证据**：截图在 60 秒乃至 20 分钟跨度上**逐像素完全一致**，
   而 Anaconda 界面右上角带实时时钟 —— **guest 已冻死**，
   `captureScreenshot` 拿到的是冻结帧。不是"看不到"，是那台机器真的卡住了。

结论：那条路已证明走不通，**及时止损比继续投入更重要**。

#### 最终方案：官方 Fedora WSL 镜像

改用 Fedora 官方发布的 `Fedora-WSL-Base-44-1.7.x86_64.wsl`（155.3 MB），
SHA256 `2e5b153ba4b639952bf546be577fc19b832fe8944caa7de342b32f10da7d319a`
与官方 `Fedora-Container-44-1.7-x86_64-CHECKSUM` **核对一致**，
`wsl --import` 导入即得到真实 Fedora 44 用户态：rpm 6.0.1、glibc 2.43、dnf5。

| 脚本 | 项目 | 结果 |
| --- | --- | --- |
| `fedora-01-rpm-smoke.sh` | dnf 依赖解析 → 安装 → rpm 数据库 → 卸载 | **23/23** |
| `fedora-03-gui-xdg.sh` | 普通用户 + Xvfb 启动 → XDG 落点 → 技能加载 | **11/11** |
| `fedora-04-uninstall-keepdata.sh` | 卸载后用户数据保留 | **7/7** |

#### 最关键的一条：依赖名在 Fedora 上全部解析成功

electron-builder 默认照抄 Debian 系依赖名，而 RPM 系叫法不同。
**依赖名写错时 `rpm -qpR` 照样能把名字打印出来，但 `dnf install` 会直接失败**
—— 只看元数据完全看不出来。

实测包声明的 8 个依赖全部被 Fedora 仓库解析并自动装上：

```
alsa-lib  gtk3  libXScrnSaver  libdrm  libxkbcommon  mesa-libgbm  nss  xdg-utils
```

121 个文件登记进 rpm 数据库，`rpm -V` 校验通过，卸载后 **0 个文件残留**。

#### GUI 与 XDG（真实普通用户下）

以 `qqtest` 用户在 Xvfb 下启动，**存活满 60 秒未崩溃**（退出码 124 = 被 timeout 杀），
数据目录落在 `/home/qqtest/.local/share/qq-agent`：

- 属主为 `qqtest`（不是 root），且不在 `/opt` 安装目录内
- 生成 `config.json`、`sessions/`、`memory-v2/`、`logs/`、`threads/` 等
- **加载出 19 条技能日志**，含自己魔改的 `affinity`、`body-state`、`meme-engine`、
  `threads`、`proactive-chat`、`wake-policy` 等

卸载后安装文件全部清除，用户数据 8 个文件**完整保留**、属主未变
（`/opt/QQ Agent` 会留下 9 个**空目录骨架**，这是 rpm 对共享路径的正常语义，
0 个文件残留）。

#### ⚠️ 能力边界（不冒充"真机全项通过"）

WSL 跑的是**微软内核**，不是 Fedora 自带内核。因此：

- ✅ **能验**：rpm/dnf 依赖解析与事务、安装路径与权限、rpm 数据库注册、
  `%post` 脚本、卸载与残留、文件校验、XDG 落点、技能加载
- ❌ **不能验**：Fedora 内核相关的运行时行为、真实图形栈与硬件

GUI 启动已在**真实 Ubuntu 26.04.1 虚拟机**上覆盖（`vm-02-smoke.sh`），
应用二进制在两种包中完全相同。

### 4.4 .deb 在真实 Ubuntu 虚拟机上的冒烟：19/19

前面的 4.2 是 WSL 侧验证。为进一步确认，另开一台**真实 Ubuntu 26.04.1 虚拟机**
（内核 7.0.0，4 核 / 3350 MB，11 GB 空闲，免密 sudo）复测：

- 通过 SSH 传入 `.deb`，**传输后先核对 SHA256**，再 `dpkg -i` 安装
- 覆盖安装、文件布局、SnowLuma 解包与自带 node、Electron、XDG 落点、卸载保留数据
- 该机**没有出现 WSLg 的 GPU 报错**（印证 5.1 的判断：那是 WSLg 环境问题，不是移植缺陷）

> 教训：传输脚本曾对**二进制**做行尾处理，把 `.deb` 损坏
> （SHA256 从 `023ebec3…` 变成 `70d3dead…`），只因为校验了哈希才发现。
> **所以「传输后必须核对 SHA256」是硬规则**，不是可选项。

### 4.5 AppImage 冒烟：7/7（WSL）+ 18/18（真实 Ubuntu 虚拟机）

真实 Ubuntu 虚拟机上另测 18/18。踩过一次坑：最初把 `.deb` 的路径布局
（`/opt/QQ Agent/resources/...`）套到 AppImage 上，导致 4 项**误报失败**
—— AppImage 把 `resources/` 放在 squashfs 根。
**断言必须按实际结构写，不能照搬另一种包的布局。**

### 4.5 插件与技能加载：70 / 0

纳入 17 个插件 + 25 个技能后，**必须验证它们真的能加载**。

一开始我试图"启动整个 app 看日志"来判断，但那个方法**不充分**：
新增插件大多 `enabledByDefault: false`，默认关闭时**不打印任何日志** ——
于是「日志里没出现」既可能是「没加载」也可能是「加载了但没启用」，分不清。
而这两者后果完全不同：前者是缺陷，后者是正常设计。

改为**直接调用 V0.4.4 的插件加载器**取权威答案：

```
loadPlugins()  → 已加载: 70   失败: 0
skillManager   → 登记总数: 69   已加载: 69   有加载错误: 0
                已启用: 19（其余为 enabledByDefault=false，属正常）
```

日志里能看到每个新插件都成功初始化，例如：

```
[skill:kb-growth] kb-growth 已加载（Mongo/语义向量均为软依赖，缺了自动降级）
[skill:body-state] body-state 已加载（21 格情绪 + 主干三维，本地 JSON）
[skill:threads] threads 已加载（讨论线：六维记分卡 + 活跃/沉睡双层窗口；宿主未实现，按清单规格新建）
[skill:wake-policy] wake-policy 已加载（必回名单 / 按人关键词 / 别名；默认全空 = 不影响）
```

> `threads` 的自述「**宿主未实现，按清单规格新建**」印证了前文的判断：
> 扩展作者本就知道宿主可能不认识某些能力，因此做了降级设计。

### 4.6 产物指纹核对

验证前后各算一次 SHA256 并比对，确认三份产物在测试过程中未被改动：

```
✅ 三份产物在测试过程中未被改动，验的就是待发布的包
37b47b4c30477538  qq-agent-v0.4.4-amd64.deb
9d845ea2a87c72e4  qq-agent-v0.4.4-x86_64.rpm
8a5d55efef5b8b89  qq-agent-v0.4.4-x86_64.AppImage
```

> 这一步是补做的。起因：我曾**并发**跑「rpm 冒烟」与「重新构建」，冒烟脚本收尾时的
> `pkill -f app.asar` 把还在运行的 electron-builder 一起杀了，产出时间戳错乱。
> 这类竞争不报错，只会让「验过的包」≠「发布的包」——很危险。
> 故新增 `verify-all.sh`：**串行**执行并在前后核对指纹。

---

## 五、已知限制（如实记录）

### 5.1 WSLg 环境的 GPU 报错（非移植缺陷）

启动日志会出现：
```
ERROR:gpu_process_host.cc(976) GPU process launch failed: error_code=1002
FATAL:gpu_data_manager_impl_private.cc(423) GPU process isn't usable. Goodbye.
```

**对照实验结论**（传与不传 GPU 参数各跑一遍）：

| 用例 | GPU FATAL | 渲染崩溃 | 数据目录 |
| --- | --- | --- | --- |
| baseline | 1 | 1 | ✅ 正常 |
| `--disable-gpu --disable-software-rasterizer` | **1** | 0 | ✅ 正常 |
| `--use-gl=swiftshader` | 1 | 1 | ✅ 正常 |
| `--in-process-gpu` | **0** | **30** | ✅ 正常 |

**判定**：显式传 `--disable-gpu` 也挡不住，说明**不是** `main.js` 开关时机的问题，
而是 WSLg 的 GPU 转发本身不可用（`DISPLAY=:0` 与 `wayland-0` 都在，但 GPU 转发失效）。
`--in-process-gpu` 虽然消掉 FATAL，却引发 30 次渲染崩溃，**不可取**。
**所有用例的数据目录都正常建出**，后端（协议端接入、存储、技能加载）不受影响。
在真实 Linux 桌面或纯服务器上表现会不同，需要真机复核。

> **后续实证**：在真实 Ubuntu 26.04.1 虚拟机上复测，**没有出现该报错**
> （见 4.4）。这印证了「WSLg 环境问题、非移植缺陷」的判断。

### 5.2 ★ 测试脚本自身的 bug 比包的问题更常见

Fedora 验证第一次跑出 3 项失败，逐条查下来**全部是测试脚本的问题**，与包无关。
若不查清就改包，会把好包改坏：

| 现象 | 真实原因 |
| --- | --- |
| `[: 10: integer expected` | `$(rpm -ql … \| wc -l \|\| echo 0)` 在输出带换行时拼成 `"1\n0"` |
| `ENVNOTES: unbound variable` | `declare -a A B` 一行声明多个数组名，在 bash 5.3.9 下展开报 unbound（改成逐个 `A=()` 并配 `${A[@]+…}` 兜底） |
| 「卸载后残留 1 条」 | `rpm -ql <未安装的包>` 输出为空，但空输出末尾的换行被 `wc -l` 数成 1 |
| 「安装目录未移除」 | 断言按「目录必须消失」写，但 rpm 对共享路径只删文件、保留空目录骨架 |
| 以 root 判定 XDG 失败 | root 家目录与边界行为不具代表性；WSL 无 `/run/user/0` 会话总线 |

另外两类也踩过：

- **AppImage 断言套用 .deb 布局** → 4 项误报失败（见 4.5）
- **传输脚本对二进制做行尾处理** → 直接损坏 `.deb`，只因校验哈希才发现（见 4.4）

**规则**：报出失败时，先证明是包的问题，再动包。
**并且**：把失败项分类成「包的问题」与「环境前提缺失」，后者不该计成失败 ——
否则测试报告会失去可信度。

### 5.3 AppImage 需要 libfuse2

Ubuntu 24.04+ 默认只装 libfuse3，而 AppImage 仍依赖 libfuse2，直接双击会报：
```
dlopen(): error loading libfuse.so.2
```
解决：`sudo apt install libfuse2t64`，或加 `--appimage-extract-and-run` 运行。
**这是 AppImage 格式的通用特性，与本项目无关**（任何 AppImage 都如此）。
已在安装文档中写明。

### 5.4 配置里的 Windows 路径残留

从 Windows 迁移的 `config.json` 中仍有绝对路径，会导致对应技能静默失效：

| 配置项 | Windows 原值 | 处理 |
| --- | --- | --- |
| `skills.video-frames.settings.visionScript` | `F:/Agnes/vision-skill/vision.js` | 见 `examples/config-linux-overrides.json` |
| `skills.speech-to-text.settings.dashscopeEnv` | `F:/Agnes/vision-skill/.env` | 同上 |
| `kbGrowth.mongoClients.navicatPath` | `D:\Program Files\...\navicat.exe` | 同上（可留空，非核心功能） |
| `data/stickers.json` 内表情路径 | `file:///E:/...` | 需批量 sed 替换 |

**这些是用户数据，不是程序缺陷**，无法在打包阶段修掉（打包已排除 `data/`）。
已提供覆盖片段与操作说明。

### 5.5 affinity 档案需手动迁移

启动日志会提示：
```
[skill:affinity] 好感度（只读移植版）已就绪：未找到 DATA_DIR/affinity/state.json，注入将为空
```
技能本身**正常工作**（只读设计），只是没有档案数据。把 Windows 侧的
`data/affinity/state.json` 拷到 `~/.local/share/qq-agent/affinity/` 即可。

---

## 六、用户魔改插件的处理

**结论：安装版里已经装的就是用户的魔改版本，无需额外注入。**

```
app/skills/affinity/index.js                    MD5 2B11506C91
F:\qq-agent-backup\...\40-plugins-src\affinity\index.js  MD5 2B11506C91  ← 完全一致
```

- 形态是 **skill**（V0.4.4 里 `plugins/`=确定性型、`skills/`=LLM 型）
- 自述：`name=好感度`、`author=ported from v0.3 affinity module`、`capabilities=affinity.query`
- 备份脚本的说明印证了这一点：`40-plugins-src` 是「插件源码放在 app 之外，升级吃不掉」，
  而里面**只有 affinity 一项**

**Linux 上已实测加载成功**（冒烟日志）：
```
[skill:affinity] 好感度（只读移植版）已就绪
[skill:image-generate] 文生图技能已加载
[skill:conversation-memory] 会话记忆已启用
```

---

## 七、如何复现整套流程

```bash
# 0) 把构建脚本放进 WSL（每次 /tmp 被清后都要做一次）
wsl -d Ubuntu -- bash /mnt/f/kmy/Documents/dpsk/harness/QQ-Agent-for-Linux/port/app/build-scripts/bootstrap-wsl-scripts.sh

# 1) 一步跑完：同步源码 → 确保 SnowLuma → npm install → 构建
wsl -d Ubuntu -- bash /mnt/f/kmy/Documents/dpsk/harness/QQ-Agent-for-Linux/port/app/build-scripts/pipeline.sh

# 2) 三套冒烟测试（串行，含产物指纹核对）
wsl -d Ubuntu -- bash /mnt/f/kmy/Documents/dpsk/harness/QQ-Agent-for-Linux/port/app/build-scripts/verify-all.sh

# 3) 把产物与校验和收回 Windows
wsl -d Ubuntu -- bash /mnt/f/kmy/Documents/dpsk/harness/QQ-Agent-for-Linux/port/app/build-scripts/collect-artifacts.sh
```

> ⚠️ **一个反复踩的坑**：从 PowerShell 调 `wsl -- bash -c '...'` 时，
> 单引号脚本里的 `$VAR` 会被 PowerShell 先展开成空。今天因此在
> `$c` / `$A` / `$HOME` / `$D` / `$f` 上失败了至少 6 次，表现为命令以空参数执行、
> 结果错乱且不报错。**凡带变量的逻辑一律写进脚本文件**，外层只传绝对路径。

---

## 八、许可与署名

- 原项目 **QQ Agent** 由 **Kondius** 以 **MIT** 发布：<https://github.com/Kondius/qq-agent>
- 本 Linux 移植版**保留原作者署名与 MIT 许可**（`package.json` 的
  `author: Kondius` 与 `license: MIT` 未改动）。
- deb/rpm 的 `maintainer` 字段填的是本移植包的维护者
  （`prolet1966 <hs75311a@126.com>`）—— 因为那是「这个包出问题找谁」的字段，
  不是原作者署名。
- 内置的 **SnowLuma** 采用**源码可见非商业许可**（非 OSI 开源），
  商业使用需另行取得其书面授权。其 `EULA.md` 与 `PRIVACY.md` 随包分发在
  `snowluma/` 目录内。
