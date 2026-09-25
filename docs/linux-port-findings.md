# V0.4.4 → Linux 移植：硬编码侦察报告

> 侦察对象：`E:\Program Files\QQ Agent\QQ Agent v0.4 setup\resources\app`
> 版本：`qq-agent@0.4.4`，`main=electron/main.js`，运行时依赖 `js-yaml / undici / ws` + Electron
> 规模：46 个 src 模块、16 skills、12 plugins（排除 node_modules 共 243 个文件）
> 本报告只记录**经源码核对确认**的事实，未经验证的推断一律标注。

---

## 一、阻断级问题（不改就跑不起来）

### B-1 · 数据目录默认落在安装目录内 · 违反 XDG

**位置**：`src/config.js:9,24`

```js
export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = process.env.QQ_AGENT_DATA_DIR || path.join(ROOT, `data${profileSuffix()}`);
```

`ROOT` 是 app 目录。打包后 `DATA_DIR` = `<安装目录>/resources/app/data`。

**为什么在 Linux 上是阻断级**：

- 安装到 `/opt/qq-agent` 后普通用户**无写权限** → 启动即失败或大量 EACCES
- 即使装上也违反目标里的「数据目录遵循 XDG 规范落到用户主目录」
- 覆盖路径 `QQ_AGENT_DATA_DIR` 存在，但那是给测试用的逃生口，不能当默认方案

**改造方向**：Linux 下默认改为 `$XDG_DATA_HOME/qq-agent`（缺省 `~/.local/share/qq-agent`），
多实例仍走 `-<PROFILE_ID>` 后缀。保留 `QQ_AGENT_DATA_DIR` 覆盖能力（优先级最高）。

**附带**：`electron/main.js:183` 附近有「dev 模式用项目内 data/」的分支，需一并核对，
避免 dev 与打包两种模式解析出不同的目录。

### B-2 · SnowLuma 启动依赖 `node.exe` 与 `launcher.bat`

**位置**：`src/app.js:512-514, 553-560`

```js
const indexMjs = path.join(dir, 'index.mjs');
const nodeExe  = path.join(dir, 'node.exe');        // ← Linux 不存在
if (fs.existsSync(indexMjs) && fs.existsSync(nodeExe)) { /* 内置模式 */ }
// 回退：
const launcher = path.join(dir, 'launcher.bat');    // ← Linux 不存在
const child = spawn('cmd.exe', ['/c', launcher], …) // ← 命令不存在
```

**事实**：SnowLuma 的 Linux 发行包结构是 `index.mjs` + `node`（无 `.exe`）+ `launcher.sh`。

**后果**：两条路径全断。`launchSnowluma()` 会直接返回
`目录里没有 index.mjs / node.exe，也没有 launcher.bat`，UI 的「运行 SnowLuma」永久失效。

**改造方向**：按 `process.platform` 选择运行时与脚本名；Linux 用 `dir/node`，
回退到 `launcher.sh`（`spawn('/bin/sh', [launcher])`）。

### B-3 · `stopSnowluma()` 外部实例用 WMIC 匹配进程

**位置**：`src/app.js:243-277`

```js
const queryCmd = 'wmic process where "name=\'node.exe\'" get ProcessId,CommandLine /format:list';
```

**后果**：Linux 无 `wmic`。UI 的「停止」对外部启动的 SnowLuma 完全无效，
用户只能手动 `pkill`，而残留实例会继续占用管道与端口。

**改造方向**：Linux 用 `/proc/<pid>/cmdline` 遍历匹配（零依赖、不依赖 ps）。

### B-4 · 打开目录/URL 依赖 `explorer.exe` 与 `cmd.exe`

**位置**：`src/routes.js:140, 311, 320`

```js
spawn('explorer.exe', [DATA_DIR], …)                        // /api/open-data-dir
spawn('explorer.exe', [dir], …)                             // /api/snowluma/open-folder
spawn('cmd.exe', ['/c', 'start', '', webuiUrl], …)          // /api/snowluma/open-webui
```

**后果**：三个 API 全部 500。UI 上「打开数据目录」「打开 SnowLuma 目录」「打开 WebUI」全废。

**改造方向**：Linux 统一用 `xdg-open`（`DATA_DIR` / 目录 / URL 都支持）。

---

## 二、功能残缺（能跑但功能不可用）

### F-1 · 便携 QQ 整条链路是 Windows-only

**位置**：`src/app.js:279-479`

| 函数 | 行 | Windows 依赖 |
| --- | --- | --- |
| `qqPortableExe()` | 295 | `QQ.exe` |
| `listQqProcesses()` | 333-357 | PowerShell + `QQ.exe` 进程名（已有 `platform !== 'win32'` 守卫，Linux 返回 `[]`） |
| `launchPortableQQ()` | 377-435 | spawn `QQ.exe` + `--user-data-dir` |

**事实**：`listQqProcesses()` **已经有平台守卫**，Linux 上安全返回空数组，
不会崩，但「便携 QQ」整个功能在 Linux 上无意义 ——
Linux QQ 应走官方 deb 安装（`/opt/QQ/qq`），而不是「便携端」。

**改造方向**：Linux 下把便携 QQ 相关入口隐藏或改为「检测系统 QQ 是否已安装 / 拉起 `/opt/QQ/qq`」。
两条路都可，需定夺（见第四节待决）。

### F-2 · 启动 SnowLuma 用了 Windows 专属进程标志

**位置**：`src/app.js:518-523`

```js
windowsHide: true,   // Linux 无意义，但传了也不报错
detached: false
```

`windowsHide` 在非 Windows 上传入是**无害的**（Node 忽略）。不计入阻断，但应清理。

---

## 三、已确认**不需要改**的部分（避免过度改造）

- **`src/app.js:334`** `if (process.platform !== 'win32') return [];` —— 平台守卫已存在，正确。
- **`electron/main.js:899`** `if (process.platform !== 'darwin') app.quit();` —— 是 macOS 判断，
  与 Linux 移植无关，不要误改。
- **`src/app.js:243-246` 注释里提到的 WMIC 编码坑（GBK / CSV 逗号）** —— 那是 Windows 侧的历史教训，
  Linux 走 `/proc` 后整个问题不存在。
- **`src/routes.js:188` 附近的 `rmSync` 闸门**（防 `QQ_AGENT_DATA_DIR` 被误设为 `C:\` 后删盘）——
  这个安全闸门**必须保留**，Linux 上同样需要（误设为 `/` 或 `$HOME` 时一样危险）。

---

## 四、移植后必然遇到、但不在源码里的坑

以下来自 Linux 部署实测经验（**外部情报，非本机验证**），移植时必须写进安装包文档：

1. **`kernel.yama.ptrace_scope` 必须为 0** —— Ubuntu 默认 1 会禁止注入非子进程，
   SnowLuma 注入 QQ 被内核拒绝，报 `COMPONENT_LOAD_FAILED`。
   装包时应检测并提示（或提供 postinst 提示，**不要静默改内核参数**）。
2. **Linux QQ 客户端版本必须与 SnowLuma 的钩子匹配** —— 版本错配注入失败。
   装包无法代管，必须写进安装后提示。
3. **需要 Linux 版 QQ 客户端** —— 官方 deb，装完在 `/opt/QQ/qq`。
   SnowLuma 负责注入它。这是便携 QQ（F-1）在 Linux 上的替代路径。
4. **无头环境需要 xvfb** —— 卡片离屏渲染；QQ 首次扫码建议真实显示或 VNC。
5. **中文字体** —— 不装 `fonts-noto-cjk`，卡片图片中文全是方块。
6. **glibc ≥ 2.28** —— Alpine（musl）不可用。

---

## 五、施工优先级建议

| 阶段 | 内容 | 理由 |
| --- | --- | --- |
| **P0** | B-1 数据目录 XDG 化 | 不改则装完无写权限，其余改动无法验证 |
| **P0** | B-2 SnowLuma 启动 Linux 化 | 协议端起不来 = 整个机器人无意义 |
| **P1** | B-4 xdg-open（3 处） | 改动小、收益直接 |
| **P1** | B-3 /proc 进程匹配 | 影响「停止」按钮可用性 |
| **P2** | F-1 便携 QQ 的 Linux 策略 | 需先定夺方案（见第六节） |
| **P2** | F-2 清理 windowsHide 等无用参数 | 洁癖项，不阻塞 |

---

## 六、待决问题

1. **F-1 便携 QQ 在 Linux 上怎么处理？**
   - a) 隐藏相关 UI 入口，改文档引导用户自行安装官方 Linux QQ
   - b) 保留入口但改为「检测 `/opt/QQ/qq` 是否存在 + 拉起它」
   - c) 保持现状（返回「未安装」），仅修文档
   倾向 **b**：对用户最省事，且与 SnowLuma 的注入模型一致。

2. **数据目录迁移**：已有 Windows 侧 `data/`（896MB）。
   Linux 首启时是否需要「检测到旧数据则提示迁移」？还是纯全新开始？
   （用户此前提到的那台机器是从 Windows 迁到 Linux 的，说明这个场景真实存在）

3. **源码从哪来**：本次侦察基于**安装版解包目录**（`resources/app`）。
   正式改造应在**开发仓库**进行（含 `package.json` 的 build 配置、`scripts/`）。
   安装版目录里没有 `electron-builder` 配置，**无法直接产出 .deb/.rpm**。
   → 需要确认开发仓库位置。

---

*报告生成：移植侦察阶段。所有行号基于 `qq-agent@0.4.4` 安装版解包源码。*
