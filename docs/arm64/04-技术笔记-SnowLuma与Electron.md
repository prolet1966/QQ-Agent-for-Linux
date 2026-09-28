# 04 · 技术笔记：SnowLuma 与 Electron 的硬约束

> 这份笔记记录**不能违反的事实**和**踩过的坑**。动手前先读。

---

## 一、SnowLuma（QQ 协议端）

### 1.1 它是什么

- 仓库：https://github.com/SnowLuma/SnowLuma
- 文档：https://snowluma.github.io/zh/
- 包名：`@snowluma/runtime`（QQ-Agent 内置的是 **v1.14.13**）
- 作用：把 QQ 原生会话转换成 **OneBot v11** 动作与事件，经 WebSocket / HTTP / WebUI 对外提供

### 1.2 授权（**分发前必须确认合规**）

| 项 | 内容 |
|---|---|
| 许可 | **SnowLuma Source-Available Non-Commercial License**（源码可见，**非** OSI 开源） |
| 个人自用 | ✅ 免费，**无需授权码** |
| 商业使用 | ❌ 需事先书面授权（`motricseven@foxmail.com`） |
| 公开发布修改版/衍生版 | ❌ 需书面授权 |
| 原生模块 | ⚠️ `snowluma-*.node` / `.dll` / **`.so`** 是**专有组件**，不在源码许可范围；禁止逆向/反编译；禁止规避授权机制 |
| EULA | 生效 2026-07-21 v1.1，适用中国大陆法律；首次启动需同意 |

**无人值守部署**可设环境变量跳过交互式同意：
```bash
export SNOWLUMA_ACCEPT_EULA=1
export SNOWLUMA_ACCEPT_PRIVACY=1
```

### 1.3 ★ 最重要的硬约束：Linux 上需要真实 QQ 进程 + 注入

官方自述：SnowLuma 的核心机制是**把 hook 注入真实 QQ 进程**。这意味着：

| 平台 | 前置要求 |
|---|---|
| Windows | 需要 Windows QQ 客户端（QQ-Agent 为此内置了「便携 QQ」`QQ.exe`） |
| **Linux** | **需要 Linux 版 QQ 客户端在跑 + 注入 + 扫码登录**（只支持扫码，无 CLI 登录） |

**这直接决定了产品预期管理**：
- 我们能打包：应用本体、控制台、SnowLuma 运行时、启动器、桌面集成
- 我们**不能**提供的：用户的 QQ 登录态、QQ 客户端本体
- 所以 README 和安装后提示**必须如实说明前置步骤**，不能给人"装上就能用"的错觉

### 1.4 其他 Linux 已知坑（官方自述）

| 坑 | 说明 | 对策 |
|---|---|---|
| `ptrace_scope` | 内核 `ptrace_scope=3` 会让注入**直接被拒** | 安装后检测 `/proc/sys/kernel/yama/ptrace_scope`，>1 时提示用户调整 |
| QQ 静默热更新 | QQ 会热更新改字节，打坏 native hook | 官方建议把补丁域名 black-hole；属于运维建议，写进 README |
| 无 GUI 环境 | Linux 手动部署需自备 VNC/noVNC | 写进 README |

> 参考：https://snowluma.github.io/zh/docs/guide/deploy/linux-manual
> 　　　https://snowluma.github.io/zh/docs/guide/faq

### 1.5 原生模块命名：Linux 是 `.so` 不是 `.node`

⚠️ **这条我一开始判断错了**，记录下来避免重犯：

EULA 第 5.1 条把专有组件统称 `snowluma-*.node` / `snowluma-*.dll` / **`snowluma-*.so`**。
即：**不存在** `snowluma-linux-x64.node` 这种字面文件名，Linux 平台下是 `.so`。

**推论**：`src/app.js` 里任何"找 `.node` 文件"的探测逻辑在 Linux 上都不适用。
本方案的补丁只探测 `index.mjs` + `node` 可执行文件，不依赖原生模块文件名 —— 这是对的。

### 1.6 启动契约（Windows 版，供对照）

```
snowluma/
├── index.mjs              7.2 MB   ← 入口
├── node.exe              83.2 MB   ← 自带 Node（Windows）
├── launcher.bat                    ← node ./index.mjs
├── check-node-version.cjs          ← 要求 Node ^22.13.0 || >=23.4.0
├── config/                         ← runtime.json / onebot_*.json / 登录态
└── native/
    ├── snowluma-win32-x64.node   snowluma-win32-x64.dll   websocket-win32-x64.node
    └── ffmpeg/ffmpegAddon.win32.x64.node
```

Linux 版结构同理，但 `node.exe` → `node`，`launcher.bat` → `launcher.sh`（官方文档提到）。

**Node 版本要求**：`^22.13.0 || >=23.4.0`（`check-node-version.cjs` 原文）。
WSL 里的 node 是 **v22.22.1**，满足。完整版自带 node，不依赖系统版本。

### 1.7 ★ 未解决的开放问题：配置目录重定向

**问题**：`config/` 在 `/opt/qq-agent/snowluma/` 下，属 root 只读。
SnowLuma 首次运行要写 `runtime.json`、`onebot_*.json`、登录态 → **必然失败**。

**待查**：SnowLuma 是否支持环境变量或命令行参数指定配置目录。调查方向：
1. 官方 Linux 手动部署文档
2. 发行包内 `index.mjs` / `config-*.js` 里搜 `CONFIG_DIR`、`env.`、`process.argv`
3. 发行包内 README

**这是阻塞 stage 阶段的第一优先问题。**

### 1.8 关于 `community.key`

调研结论：**SnowLuma 官方文档/仓库/EULA 里没有任何 `community.key` 的记载**。

事实是：`community.key` 属于 **QQ-Agent 自己**（`src/community.js`）：
```js
const COMMUNITY_KEY_FILE = path.join(ROOT, 'community.key');
export const COMMUNITY_API_BASE = 'https://www.kondius.cn/api/community';
```
注释原文：
> *"云端名单写入密钥（只有'删除/整体覆盖'用得到）。……注意：这份密钥只给管理员本机用，
> **绝不能打进分发给别人的安装包**。"*

**结论：与 SnowLuma 授权无关，是 QQ-Agent 云端屏蔽名单的写权限密钥。**
已核实原版安装包**未**包含它，新包也必须排除。

### 1.9 Linux 上的替代协议端（备选方案）

如果 SnowLuma 的"需注入真实 QQ"在 Linux 上过于笨重，备选：

| 协议端 | Linux 支持 | 备注 |
|---|---|---|
| **NapCat**（NapNeko） | ✅ 原生，官方提供 Linux QQ deb/rpm 直链 | v4.18.28；比 SnowLuma 轻 |
| **Lagrange** | ✅ 跨平台（.NET） | 纯协议实现，**不需要 QQ 客户端** |
| **LLOneBot / LLBot** | ⚠️ 需 Nix/Docker | 本体是 LiteLoaderQQNT 插件 |
| go-cqhttp | ✅ 但**已停止维护** | 不建议新用 |

> **重要**：QQ-Agent 的 `src/onebot.js` 是**标准 OneBot v11 实现**（文件注释原文：
> *"原版经 @snowluma/sdk 收事件；这里直接实现标准 OneBot v11，去掉 SDK 补丁依赖。"*）。
> 也就是说应用**本来就能连任何 OneBot v11 端点** —— 只要改设置里的 `wsUrl`/`httpUrl`。
> 这是"协议端可替换"的代码级依据，也是万一 SnowLuma 路线受阻时的安全网。
>
> 但注意：某些工具依赖 SnowLuma 的**扩展动作**（`fetch_ptt_text`、`_get_group_notice`
> 等下划线开头的非标准动作）。换协议端时这些功能可能缺失。

---

## 二、Electron

### 2.1 版本

Windows 与 Linux 必须**同版本**：**33.4.11**（`QQ Agent v0.4 setup/version` 文件写的
就是 `33.4.11`）。版本不一致会导致 Chromium 行为差异、难以排查。

### 2.2 Linux 运行时文件布局

`electron-v33.4.11-linux-x64.zip` 解包后：
```
electron            ← 主程序（Linux 上就叫 electron，无扩展名）
chrome-sandbox      ← 需 setuid root 4755
chrome_100_percent.pak / chrome_200_percent.pak
icudtl.dat / resources.pak / snapshot_blob.bin / v8_context_snapshot.bin
libEGL.so / libGLESv2.so / libvk_swiftshader.so / libvulkan.so.1
vk_swiftshader_icd.json
locales/
resources/default_app.asar   ← **用我们的 app/ 替换它**
LICENSE / LICENSES.chromium.html
```

Windows 侧对应的是 `.exe`/`.dll`，Linux 侧是 `.so`，其余结构一致。

### 2.3 ★ AppImage 的 setuid 限制（真实问题，不是猜测）

Chromium 沙箱要求 `chrome-sandbox` 是 setuid root。
**SquashFS 挂载默认不保留 setuid 位**（`-nosuid`/权限模型），
所以 AppImage 形态下沙箱通常不可用。

对策：AppImage 启动器检测沙箱不可用 → 加 `--no-sandbox` 降级，
并在 README 里**如实说明这是 AppImage 形态的固有限制**（deb/rpm 版不受影响）。

### 2.4 数据目录策略（原版设计，必须理解才能改对）

`electron/main.js` 的 `resolveDataDir()` 优先级：
```
QQ_AGENT_DATA_DIR 环境变量
  > 开发模式（app.isPackaged=false）：项目内 data/
  > 安装版：exe 同级 data/       ← Linux 上会解析成 /opt/qq-agent/data（root 只读）★问题所在
  > 兜底：把旧版 %APPDATA%/qq-agent/data 搬回来
```

二次实例：`QQ_AGENT_PROFILE` 环境变量（纯数字）→ 数据目录 `data-<N>`、端口偏移 `N*100`。
**改数据目录时不能破坏这个后缀逻辑**，否则多开实例会撞端口。

### 2.5 进程管理：为什么不能用进程名判断

本项目交接文档的实测教训（原文）：
> *"沙箱里 `Get-Process`/`tasklist` 不可靠……判活跃一律用 **TcpClient 探端口**。"*

所以：
- 停止 SnowLuma → 扫 `/proc/*/cmdline` 匹配命令行（本方案补丁的做法）
- 判断运行中 → **探端口**（WebUI 5099 / OneBot 3001 / 控制台 3210）

> ⚠️ 判断 SnowLuma 存活**必须用 WebUI 端口（5099），不能用 OneBot 3001**。
> 原码注释解释了原因：3001 是 OneBot 实例开的，只有**账号登录后**才监听；
> "SnowLuma 起了但还没登录"是常态，用 3001 判会把正常状态误判成没运行，
> 于是又拉起第二个实例 → 两个进程抢端口。

### 2.6 端口清单

| 端口 | 用途 |
|---|---|
| **3210** | QQ-Agent 控制台 HTTP |
| **3001** | OneBot WebSocket（SnowLuma 开，需登录后） |
| **3000** | OneBot HTTP API |
| **5099** | SnowLuma WebUI（进程一启动就监听，**与登录无关**） |
| 3917 | 嵌入服务（语义向量，Windows 侧历史遗留） |

---

## 三、构建环境的坑

### 3.1 PowerShell ↔ WSL 引号地狱

`wsl -d Ubuntu -- bash -c "长命令"` 里的 `$(...)`、单引号、`for` 循环会被 PowerShell
先吃掉一层，导致 bash 语法报错，甚至把 `/dev/null` 解析成本地路径 `F:\dev\null`。

**铁律：任何超过一行的 bash，都写成 `.sh` 文件，然后 `bash 文件路径`。**
从 Windows 调用只写最外层一条：
```powershell
wsl -d Ubuntu -- bash -c "cd /mnt/f/.../qqa-linux && bash scripts/xxx.sh"
```

### 3.2 编辑 Windows 侧脚本文件与 WSL 的配合

工程放在 `F:\`（Windows），WSL 通过 `/mnt/f/` 访问。
- 用 DSH 的 `write`/`edit` 工具改 Windows 侧文件 → WSL 立刻可见（`/mnt` 是共享挂载）
- 但 **`/mnt` 上的文件权限位语义有限**：`chmod +x` 可能不生效
  → 脚本一律用 `bash 文件名` 显式调用，**不要依赖 shebang 直接执行**
- `/mnt` 上的 I/O 比 WSL 原生文件系统慢很多。大文件操作（解包 Electron）
  如果慢，可以考虑先拷进 WSL 家目录再操作

### 3.3 WSL 沙箱限制

从 DSH 调用 `wsl.exe` 在受限沙箱里会报 `E_ACCESSDENIED`。
本会话已放宽到 `danger-full-access`，可以正常调用。
**若换会话后 `wsl` 命令报拒绝访问，就是沙箱策略问题，不是 WSL 坏了。**

### 3.4 行尾（CRLF/LF）——本轮最大教训

Windows 侧的 app 树文件**全是 CRLF**。任何"逐行匹配"的补丁脚本都必须先做行尾归一化，
否则锚点 100% 失配。**修改 `patch-linux.mjs` 时务必保住这个归一化逻辑。**

---

## 四、待验证清单（下一轮实测）

- [ ] SnowLuma Linux 版解包后的真实目录结构（`node` / `launcher.sh` / `native/`）
- [ ] SnowLuma 配置目录重定向机制
- [ ] SnowLuma 能否在无 QQ 客户端的情况下**至少把 WebUI 5099 起起来**
      （如果连这个都不行，冒烟测试第 8 项要调整预期）
- [ ] Electron 在 xvfb 下正常启动所需的最小参数
- [ ] deb/rpm 依赖名在目标发行版上的真实可用性
