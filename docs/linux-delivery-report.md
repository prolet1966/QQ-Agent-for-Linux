# Linux 移植 · 交付与验证报告

> **完成时间**：2026-09-25
> **目标**：把 QQ-Agent V0.4.4（Node.js + Electron）改造成 Linux 版本并交付三种安装包
> **状态**：✅ **已完成并验证**

---

## 一、交付物

位置：`port/dist/`（同时保留在 WSL `~/qq-agent-linux/app/dist/`）

| 文件 | 大小 | SHA256（前 16 位） |
| --- | --- | --- |
| `qq-agent-v0.4.4-amd64.deb` | 117 MB | `37b47b4c30477538` |
| `qq-agent-v0.4.4-x86_64.rpm` | 103 MB | `9d845ea2a87c72e4` |
| `qq-agent-v0.4.4-x86_64.AppImage` | 150 MB | `8a5d55efef5b8b89` |

完整校验和见 `port/dist/SHA256SUMS.txt`。

**这三个 SHA256 与验证时记录的产物指纹逐位一致** —— 即「验过的包」就是「要发布的包」，
中间没有被重新构建替换过（这一点单独做了核对，见第四节）。

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
| `examples/config-linux-overrides.json` | **新增** Linux 配置覆盖片段（修 Windows 路径残留） |
| `test/platform-test.mjs` | **新增** 35 项平台层测试 |
| `test/verify-linux.mjs` | **新增** Linux 实测值打印 |
| `build-scripts/*.sh` | **新增 21 个脚本**，覆盖取源码 → 装协议端 → 构建 → 三套冒烟 → 收回产物 |

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

### 4.3 .rpm 冒烟：18/18

WSL 是 Ubuntu，无法真正 `rpm -i`（会把文件塞进 dpkg 系统且依赖解析混乱）。
采用等价验证，**并如实记录其局限**：

- `rpm2cpio` 解出完整文件树，核对路径布局与内容
- **与 .deb 逐条对照**：两包 `app.asar`/`snowluma` 关键条目均为 **44 条且完全一致**
- 用解出的文件树**真实启动一次**，验证运行行为与数据目录落点

> ⚠️ **局限（不假装等价）**：未经 rpm 数据库注册，因此
> ① 无法验证 pre/post 脚本在 rpm 体系下的执行；② 未经过 rpm 依赖解析
> （依赖名已用 `rpm -qpR` 单独核对，含 `xdg-utils` 等 9 项）。
> 若需要严格验证，应在 RHEL/Fedora 系真机上装一次。

### 4.4 AppImage 冒烟：7/7

`--appimage-extract-and-run` 启动，退出码 **124**（被 timeout 杀掉 = 进程一直活着），
数据目录正常建于 XDG 位置。

### 4.5 产物指纹核对

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

### 5.2 AppImage 需要 libfuse2

Ubuntu 24.04+ 默认只装 libfuse3，而 AppImage 仍依赖 libfuse2，直接双击会报：
```
dlopen(): error loading libfuse.so.2
```
解决：`sudo apt install libfuse2t64`，或加 `--appimage-extract-and-run` 运行。
**这是 AppImage 格式的通用特性，与本项目无关**（任何 AppImage 都如此）。
已在安装文档中写明。

### 5.3 配置里的 Windows 路径残留

从 Windows 迁移的 `config.json` 中仍有绝对路径，会导致对应技能静默失效：

| 配置项 | Windows 原值 | 处理 |
| --- | --- | --- |
| `skills.video-frames.settings.visionScript` | `F:/Agnes/vision-skill/vision.js` | 见 `examples/config-linux-overrides.json` |
| `skills.speech-to-text.settings.dashscopeEnv` | `F:/Agnes/vision-skill/.env` | 同上 |
| `kbGrowth.mongoClients.navicatPath` | `D:\Program Files\...\navicat.exe` | 同上（可留空，非核心功能） |
| `data/stickers.json` 内表情路径 | `file:///E:/...` | 需批量 sed 替换 |

**这些是用户数据，不是程序缺陷**，无法在打包阶段修掉（打包已排除 `data/`）。
已提供覆盖片段与操作说明。

### 5.4 affinity 档案需手动迁移

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
