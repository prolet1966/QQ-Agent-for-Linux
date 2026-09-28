# QQ-Agent Linux 打包工程

把 **QQ-Agent V0.4.4**（Windows Electron 应用）交付为 Linux 三个安装包：
Debian 系 `.deb`、RPM 系 `.rpm`，两者测试无误后再做通用版 AppImage。

---

## 先读哪一份

| 你是 | 读这个 |
|---|---|
| **接手的 AI 会话 / 协作者** | 👉 **`03-交接文档.md`**（唯一入口，读完就能继续干） |
| 想知道做到哪了 | `01-当前进展.md` |
| 想知道怎么设计、为什么这么设计 | `02-构建方案.md` |
| 动手前想避坑 | `04-技术笔记-SnowLuma与Electron.md` |
| **要做 arm64 版（手头没有 ARM 机器）** | `05-arm64方案.md` |
| **想看真实构建结果与冒烟测试实录** | `06-构建与验证实录.md` |
| **想把 CI 跑起来（补上 arm64 真机验证）** | `07-跑CI的步骤.md` |

---

## 一句话现状

**最危险的技术风险已排除，剩下是工程量。**

- ✅ SnowLuma（QQ 协议端）官方**提供 Linux x64/arm64 原生版** ← 本来最可能让计划失败的一点
- ✅ Electron 33.4.11 Linux 运行时已就位
- ✅ Linux 适配补丁 9 处**全部命中、幂等、语法通过**（已实测）
- ✅ WSL 里 `.deb` + `.rpm` 的构建与**真实安装测试**工具链齐备
- ✅ 应用里 Windows 硬编码极少（3 个文件、9 个点），是**薄适配**不是重写
- ⬜ 组装应用树 → 打 deb/rpm → 真机冒烟测试 → AppImage

---

## 快速开始

```powershell
# 从 Windows 侧（WSL Ubuntu 26.04，工具链已装好）
cd F:\kmy\Documents\dpsk\harness\qqa-linux

# 1) 解包 Electron + SnowLuma
wsl -d Ubuntu -- bash -c "cd /mnt/f/kmy/Documents/dpsk/harness/qqa-linux && bash scripts/01-extract.sh"

# 2) 验证 Linux 适配补丁（在副本上试跑，不动原始安装）
wsl -d Ubuntu -- bash -c "cd /mnt/f/kmy/Documents/dpsk/harness/qqa-linux && bash scripts/02-test-patch.sh"

# 3) 校验补丁锚点唯一（改过补丁就跑一次）
wsl -d Ubuntu -- bash -c "cd /mnt/f/kmy/Documents/dpsk/harness/qqa-linux && node patches/verify-anchors.mjs '/mnt/e/Program Files/QQ Agent/QQ Agent v0.4 setup/resources/app'"

# 4) 全工程自检（语法 + 安全排除清单）
wsl -d Ubuntu -- bash -c "cd /mnt/f/kmy/Documents/dpsk/harness/qqa-linux && bash scripts/99-selfcheck.sh"
```

四条都应全绿。

> ⚠️ **不要**写长的内联 bash（`wsl bash -c "……for 循环……"`）——PowerShell 会吃掉引号导致语法报错。
> 一律写成 `.sh` 文件再 `bash 文件`。

---

## 目录结构

```
qqa-linux/
├── README.md                          ← 本文件（索引）
├── 01-当前进展.md                      ← 做到哪了、发现了什么、踩了什么坑
├── 02-构建方案.md                      ← 技术方案、打包设计、测试标准
├── 03-交接文档.md                      ← ★ 交接入口
├── 04-技术笔记-SnowLuma与Electron.md    ← 硬约束与踩坑
├── setup-wsl-toolchain.sh             ← 装 WSL 构建工具链（已跑过，一般不用重跑）
├── probe-env.sh                       ← 环境探测（留档）
├── probe-snowluma.sh                  ← 查 SnowLuma 官方产物（留档）
├── scripts/
│   ├── lib.sh                         ← 共享库：版本号、路径、依赖清单
│   ├── 01-extract.sh                  ← 解包 Electron + SnowLuma ✅
│   ├── 02-test-patch.sh               ← 验证补丁 ✅
│   ├── 03-stage.sh                    ← 组装应用树           ⬜ 待写
│   ├── 04-build-deb.sh                ← 打 .deb              ⬜ 待写
│   ├── 05-build-rpm.sh                ← 打 .rpm              ⬜ 待写
│   ├── 06-build-appimage.sh           ← 打 AppImage          ⬜ 待写（必须最后）
│   └── 99-selfcheck.sh                ← 全工程语法+排除清单自检 ✅
├── patches/
│   ├── patch-linux.mjs                ← ★ Linux 适配补丁（9 处，已验证）
│   ├── verify-anchors.mjs             ← 锚点唯一性校验（只读）
│   └── diag-anchors.mjs               ← 行尾诊断（排障）
├── cache/                             ← 下载的运行时（大，可重下）
├── stage/                             ← 组装产物（尚未生成）
└── out/                               ← 最终安装包（尚未生成）
```

---

## 关键路径

| 用途 | Windows | WSL |
|---|---|---|
| 本工程 | `F:\kmy\Documents\dpsk\harness\qqa-linux` | `/mnt/f/kmy/Documents/dpsk/harness/qqa-linux` |
| **待打包的 V0.4.4 应用树** | `E:\Program Files\QQ Agent\QQ Agent v0.4 setup\resources\app` | `/mnt/e/Program Files/QQ Agent/QQ Agent v0.4 setup/resources/app` |

**基线来源说明**：用**已安装的 V0.4.4**当基线（它是真正在跑、带全部线上补丁的成品）。
`E:\QQ-Agent V0.3.1 For developer\develop\` 那棵 git 树是上游 **v0.3.0**，与目标不符，**不要用**。

---

## 红线

| 项 | 说明 |
|---|---|
| **`community.key` 绝不入包** | 厂商云端名单的**写权限**密钥，源码注释明写"绝不能打进分发给别人的安装包"。原版已排除，新包也必须排除 |
| **不动 Windows 原始安装** | 补丁只作用于 `stage/` 副本。`E:\Program Files\QQ Agent\` 是线上机器人在跑 |
| **AppImage 最后做** | 用户明确要求"两版测试无误后再编写通用版 AppImage" |
| **SnowLuma 授权** | 源码可见**非商业**许可：个人自用免费，**商业使用需书面授权**。分发前确认用途合规 |
| **如实说明前置条件** | Linux 上 SnowLuma 需要**真实 Linux QQ 进程 + 注入 + 扫码登录**，不能假装开箱即用 |

---

## 目标平台

| | 架构 | 发行版 |
|---|---|---|
| `.deb` | x86_64 (amd64) | Debian / Ubuntu |
| `.rpm` | x86_64 | RHEL / Rocky / AlmaLinux / Fedora |
| AppImage | x86_64 | 通用 |

（SnowLuma 官方也提供 linux-**arm64**，将来要加 arm64 版时协议端无障碍。）

---

## arm64 版进度

见 **`05-arm64方案.md`**。结论：**没有 ARM 电脑不构成阻塞**——
组装、打包、静态校验全在 x86_64 上完成，唯一需要真 ARM 的冒烟测试
交给 GitHub Actions 的 `ubuntu-24.04-arm` runner。

进度（2026-09-27 更新）：

| 阶段 | 内容 | 状态 |
|---|---|---|
| 1 | `lib.sh` 架构参数化（`--arch x86_64\|arm64`，缺省值保持旧行为不变） | ✅ 完成 |
| 1 | `01-extract.sh` 按架构下载 + 双份 SHA256 + 架构自检 | ✅ 完成 |
| 2 | `03-stage.sh` 组装（含 `--app-tarball` 模式、snowluma 整棵替换） | ✅ 已写 |
| 2 | `test/05-arch-audit.sh` 架构审计（ELF/PE/原生件/补丁四项断言） | ✅ 已写 |
| 2 | ★ **第 10 个补丁 `snowluma-runtime-mirror`**（解决交接文档 §8 头号开放问题） | ✅ 已验证 |
| 3 | `04-build-deb.sh` / `05-build-rpm.sh` | ✅ 已写 |
| 4 | `.github/workflows/build-linux-arm64.yml`（`ubuntu-24.04-arm`） | ✅ 已写并 YAML 校验 |
| 4 | 冒烟测试 `test/10-deb-smoke.sh` + `test/20-rpm-smoke.sh` + `test/_smoke-common.sh` | ✅ 已写 |
| 5 | AppImage | ⬜ 等 deb/rpm 通过后再做 |

---

## 🎉 真实产物已齐：两个架构 × 三种包格式（2026-09-28）

| 文件 | 大小 | 验证程度 |
|---|---|---|
| **`qq-agent_0.4.4_arm64.deb`** | 114.9 MB | ✅ 静态全验（13 个 ELF 全 AArch64、权限位、无隐私数据）<br>❌ 未真机运行（无 ARM 设备，交给 CI） |
| **`qq-agent-0.4.4-1.aarch64.rpm`** | 115.0 MB | ✅ 静态全验（546 文件 / 13 个 AArch64 ELF / setuid 位 / 无隐私数据）<br>❌ 未真机运行 |
| **`QQ-Agent-0.4.4-aarch64.AppImage`** | 135.7 MB | ✅ 头部与载荷全为 AArch64（`unsquashfs -o` 跨架构验过）<br>❌ 未真机运行 |
| `qq-agent_0.4.4_amd64.deb` | 112.2 MB | ✅ **真实安装 + 冒烟 29/0/0** |
| `qq-agent-0.4.4-1.x86_64.rpm` | 112.3 MB | ✅ **真实安装 + 冒烟 29/0/0**（2 条警告：依赖未验证） |
| `QQ-Agent-0.4.4-x86_64.AppImage` | 136.9 MB | ✅ **真实 FUSE 挂载 + extract-and-run 两种模式各 31/0/0**<br>✅ AppRun 判据 6/6 单元测试 |
| `report-smoke-x86_64-{deb,rpm,appimage}.md` | — | 三份冒烟报告（CI artifact 同款格式） |

> **rpm 的依赖现在也有证据了**：`test/50-rpm-deps-resolve.sh` 用 dnf 对着
> **Fedora 44 / CentOS Stream 9（RHEL 9 上游）/ Rocky Linux 9** 的**真实元数据**
> 做纯解析 —— 两个架构都通过（依赖闭包分别 177/187/187 与 178/189/189 个包）。
> 这补上了冒烟里「依赖未被真实验证」那个缺口，也让文档声称的
> **RHEL / Rocky / AlmaLinux / Fedora** 支持范围**有了证据**。

> **跨架构是怎么打出来的（两种包格式的差别很有意思）**：
> - **`.deb`**：`dpkg-deb` 不校验宿主架构，x86_64 上直接产出 arm64 包。
> - **`.rpm`**：rpmbuild 有**硬性跨架构保护**，8 种宏覆盖 + 补 `buildarch_compat` 表**全部无效**；
>   最终用 **qemu-user + binfmt + arm64 rootfs**，在里面用原生 aarch64 rpmbuild 构建。
> - **AppImage**：`appimagetool` 只做「拼装 + mksquashfs」，**不需要执行目标架构的代码**，
>   用宿主架构的工具 + 目标架构的 runtime 即可 —— **完全不依赖 qemu**。
>
> 详见 `06-构建与验证实录.md` §5.1 / §5.3 / §5.5。

**完整实录见 `06-构建与验证实录.md`** —— 含三套冒烟测试逐项结果、
10 个"真跑才暴露"的问题（含 2 条测试自身的缺陷）、
平台限制、以及全部运行时/工具链官方摘要的来源与交叉验证过程。

**唯一剩下的人工项**：决定 `ci-input/app-code.tar.gz` 是否提交
（已产出并逐条核对干净；默认被 `.gitignore` 忽略），然后跑首次 CI —— 它会补上
**arm64 的 .rpm** 和 **arm64 包的真机运行验证**（这两件事本机做不到）。

<details>
<summary>更早一轮的验证记录（x86_64 本地组装、审计脚本自测、app-code tar 核对）</summary>

**本地实测已通过**：

- 14 个 shell 脚本 `bash -n` 全绿 · 3 个 `.mjs` `node --check` 全绿 · `99-selfcheck.sh` exit=0
- 补丁锚点唯一性 **10/10** · 真打 **10/10** · 幂等复打 **10/10 跳过**
- ★ **`03-stage.sh` 完整组装跑通**：13 个 ELF 架构正确、**Windows 残留 0 个**、
  安装树内**无任何运行期数据**
- ★ **架构审计脚本 7 个正反用例全符合预期**（含 arm64 正向用例、架构错配、真 PE、
  缺 addon、缺补丁、世界可写权限）
- ★ **`--app-tarball` 产出 2.1MB 且逐条核对干净**：411 条目、无 `.db`/`.log`/`config`/
  `community.key`、无密钥字面量

**已完成的原"待人工项"**：两个 arm64 运行时的官方 SHA256 已取得并 pin 进 `lib.sh`
（来源与交叉验证过程见 `06-构建与验证实录.md` §6）。

</details>

> 本地无法验证的边界：Cygwin 以 `noacl` 挂载，**`chmod` 设置不了执行位**；
> WSL 的 `/mnt/f` 同理（drvfs）。所以**构建必须在 ext4 上做**（`~/qqa-build`）。
> 详见 `06-构建与验证实录.md` §4.6 / §5.3。

