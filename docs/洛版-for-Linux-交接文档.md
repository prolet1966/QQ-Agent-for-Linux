# 洛版 for Linux · 交接文档

> **交接日期**：2026-09-25
> **当前版本**：QQ Agent v0.4.4（Linux 移植版）
> **状态**：✅ 已构建、已验证、已发布
> 面向接手维护的人。按顺序读完即可独立继续工作。

---

## 一、接手前先看这五条

1. **上游是别人的项目。** QQ Agent 由 **Kondius** 开发，MIT 许可。
   本移植版保留其署名与许可。改动时别把 `package.json` 里的 `author` 字段改掉。
2. **内置的 SnowLuma 不是开源软件。** 它是**源码可见非商业许可**，
   商业使用需另行取得其作者授权。若将来要商用，这是硬约束，与本项目的许可无关。
3. **本机 git 直连 GitHub 极不稳定。** 实测连续 8 次 `git push` 全失败，
   而 `gh api` 稳定。备用通道见第六节。
4. **WSL 的 `/tmp` 会被清空。** 构建脚本因此放在 `build-scripts/`（随源码走），
   不要依赖 `/tmp` 里预先存在的文件。
5. **不要凭印象改代码。** 源码里有大量「踩过坑」的注释（编码、进程匹配、asar 解包等），
   每条都对应一次真实故障。改之前先读那些注释。

---

## 二、成果在哪

### 交付物（本机）

| 位置 | 内容 |
| --- | --- |
| `C:\Users\kmy\Desktop\` | 三个安装包 + `SHA256SUMS.txt` + 说明文件（本交接文档也在桌面） |
| `F:\kmy\Documents\dpsk\harness\QQ-Agent-for-Linux\port\dist\` | 原始产物与校验和 |
| `F:\kmy\Documents\dpsk\harness\QQ-Agent-for-Linux\port\app\` | **移植后的完整源码**（权威存储） |
| `F:\kmy\Documents\dpsk\harness\QQ-Agent-for-Linux\port\build-scripts\` | 26 个构建与验证脚本 |
| `F:\kmy\Documents\dpsk\harness\QQ-Agent-for-Linux\docs\` | 三份文档（安装指南 / 交付报告 / 改动清单） |
| WSL `~/qq-agent-linux/app` | 构建工作区（含 node_modules 与 Linux 版 SnowLuma） |
| WSL `~/qq-agent-linux/app/dist` | 在 WSL 内构建的产物 |

### 已发布

| 内容 | 地址 |
| --- | --- |
| 源码仓库 | <https://github.com/prolet1966/QQ-Agent-for-Linux> |
| 发行包 | <https://github.com/prolet1966/QQ-Agent-for-Linux/releases/tag/v0.4.4-linux> |

**安装包走 Release 附件而不是入库**：三个包各超 100 MB，超过 GitHub 单文件限制。

### 上游原始文件（未改动，供对照）

| 位置 | 说明 |
| --- | --- |
| `E:\Program Files\QQ Agent\QQ Agent v0.4 setup\resources\app\` | 上游 V0.4.4 安装版解包目录（移植的起点） |
| `E:\QQ-Agent V0.3.1 For developer\develop\` | V0.3.1 开发版，附加插件/技能的来源 |
| `F:\qq-agent-backup\20260924-200434\` | 2026-09-24 的备份（含 `40-plugins-src`） |
| `F:\qq-agent-data\` | 功能验证时的运行时数据（**含真实凭据，切勿外传**） |

---

## 三、架构与目录

### 三层结构

```
QQ 客户端（系统安装，/opt/QQ/qq）
      ↓  被 SnowLuma 注入
SnowLuma（协议端，内置在包内）
      ↓  OneBot v11 over WebSocket
QQ Agent（Electron 桌面程序，本移植的主体）
      ↓
大模型 API（OpenAI 兼容）
```

### 源码目录

```
port/app/
├── src/
│   ├── platform.js      ★ 移植新增，平台抽象层（所有 OS 差异都在这里）
│   ├── config.js        ★ 改：数据目录改用 XDG
│   ├── app.js           ★ 改：SnowLuma 启动、/proc 进程匹配、QQ 客户端
│   ├── routes.js        ★ 改：explorer/cmd → xdg-open
│   ├── skills/            技能框架与内置技能
│   └── ...                其余为上游原样
├── electron/main.js     ★ 改：数据目录复用平台层
├── package.json         ★ 改：重建 build 配置
├── plugins/               29 个插件（12 上游 + 17 纳入）
├── skills/                41 个技能（16 上游 + 25 纳入）
├── ui/                    界面
├── examples/              配置参考模板
├── build-scripts/         26 个构建与验证脚本
└── test/                  测试
```

★ 标记的五个文件是本移植的**全部改动**，其余为上游原样或纳入的扩展。

---

## 四、移植做了什么（技术要点）

### 4.1 数据目录：XDG 规范

| | 上游（Windows） | 本移植（Linux） |
| --- | --- | --- |
| 默认位置 | `<安装目录>/data` | `~/.local/share/qq-agent` |
| 多实例 | `<安装目录>/data-2` | `~/.local/share/qq-agent-2` |
| 覆盖方式 | `QQ_AGENT_DATA_DIR` | 同左（优先级最高） |

**为什么必须改**：Linux 装到 `/opt` 后该目录对普通用户只读，启动即 `EACCES`；
若改用 sudo 运行，数据属主变 root，后续升级更麻烦。
**Windows 行为未改动**，仍落在安装目录下（`resolveDataDir()` 里按平台分支）。

实现位置：`src/platform.js` 的 `resolveDataDir()`，被 `src/config.js` 与
`electron/main.js` 共用。**注意**：`electron/main.js` 里原本有一份重复实现，
注释写着「数据目录固定在安装目录」——已收敛到平台层，别再写第二份。

### 4.2 SnowLuma 启动：三级运行时兜底

上游写死 `node.exe` + `launcher.bat` + `cmd.exe`，在 Linux 上**两条启动路径全断**
（Linux 发行包是 `node` + `launcher.sh`，没有 `.exe`）。

现在按可靠性降级选择运行时：

1. SnowLuma 发行包自带的 `node`（首选，ABI 最匹配）
2. 系统 PATH 里的 `node`
3. **Electron 自带的 Node** —— 靠 `ELECTRON_RUN_AS_NODE=1` 让 Electron 进程
   退化成纯 Node 运行时。**这一级意味着用户不必单独安装 Node**

全都找不到才回退到 `launcher.sh`（`/bin/sh` 执行）。

实现：`src/app.js` 的 `resolveSnowlumaNode()` 与 `whichSync()`。

### 4.3 进程匹配：`/proc` 取代 wmic

上游用 `wmic process where "name='node.exe'"` 查命令行，用于「停止外部启动的 SnowLuma」。
Linux 无 wmic，导致该按钮对外部实例完全失效。

现在读 `/proc/<pid>/cmdline`（NUL 分隔），零依赖、不依赖 `ps`、无编码问题。

实现：`src/platform.js` 的 `listProcessesProc()` 与 `findPidsByCommandline()`。
**设计要点**：`listProcessesProc()` 接受 `procRoot` 参数，因此可以用 fixture 目录
模拟 `/proc`，**在 Windows 上也能测这段 Linux 逻辑**。

> ⚠️ 匹配必须基于「命令行含 `<snowluma目录>/index.mjs`」，
> **绝不能按进程名批量杀 node** —— 那会杀掉用户机器上其它 Node 程序。
> 匹配函数对空字符串返回空数组，正是防这个。

### 4.4 打开目录/URL：`xdg-open`

上游三处 `explorer.exe` / `cmd.exe`（`/api/open-data-dir`、`/api/snowluma/open-folder`、
`/api/snowluma/open-webui`），在 Linux 上必然 500。现统一走 `platform.openExternal()`。

### 4.5 打包：`asarUnpack` 是关键

`package.json` 里必须保留：

```json
"asarUnpack": ["snowluma/**"]
```

**原因**：asar 归档内的文件**无法被 `spawn` 执行**。SnowLuma 的 `node` 与
`native/*.node` 若留在 asar 里，协议端根本起不来。解包后落在
`resources/app.asar.unpacked/snowluma/`，上游的 `snowlumaDir()` 已经会去那里找。

已验证：包内 `node` 是 x86-64 ELF 且**带可执行位**。

---

## 五、构建与验证

### 5.1 环境

已在本机 WSL 验证可用：

| 项目 | 值 |
| --- | --- |
| 发行版 | Ubuntu 26.04 LTS（WSL2） |
| glibc | 2.43 |
| Node / npm | v22.23.2 / 10.9.8 |
| npm registry | `registry.npmmirror.com`（已设默认） |

装过的额外依赖：`libarchive-tools`、`zstd`、`libfuse2t64`（AppImage 用）。

### 5.2 构建流程

```powershell
# 在 Windows PowerShell 里执行（wsl 命令）
wsl -d Ubuntu -- bash /mnt/f/kmy/Documents/dpsk/harness/QQ-Agent-for-Linux/port/app/build-scripts/bootstrap-wsl-scripts.sh
wsl -d Ubuntu -- bash /tmp/qs/pipeline.sh          # 同步源码→装协议端→构建
wsl -d Ubuntu -- bash /tmp/qs/verify-all.sh        # 三套冒烟 + 产物指纹核对
wsl -d Ubuntu -- bash /tmp/qs/collect-artifacts.sh # 收回产物与校验和
```

`pipeline.sh` 是幂等的，中断后重跑不会重做已完成步骤。
它在构建前会自动跑平台层单测——**"能构建"本身就意味着核心逻辑自洽**。

### 5.3 ⚠️ 从 PowerShell 调 WSL 的头号陷阱

**单引号脚本里的 `$VAR` 会被 PowerShell 先展开成空。** 实测因此在
`$c` / `$A` / `$HOME` / `$D` / `$f` 上失败过至少 6 次，表现为命令以空参数执行、
结果错乱且**不报错**。

```powershell
# ❌ 错误：$c 会被 PowerShell 吃掉
wsl -d Ubuntu -- bash -c 'for c in a b; do echo $c; done'

# ✅ 正确：写成脚本文件，外层只传绝对路径
wsl -d Ubuntu -- bash /mnt/f/.../myscript.sh
```

**凡带变量的逻辑一律写进脚本文件。**

### 5.4 验证结果（当前版本）

| 项目 | 结果 | 方式 |
| --- | --- | --- |
| 平台层单测 | **35/35** | `test/platform-test.mjs`，真实 Linux 上跑 |
| `.deb` 冒烟 | **25/25** | `smoke-test.sh`：apt 安装 → 验文件/协议端/运行时/XDG → 卸载 → 确认数据保留 |
| `.rpm` 冒烟 | **18/18** | `rpm-smoke-test.sh`：rpm2cpio 解包 + 与 deb 逐条对照 + 真实启动 |
| AppImage 冒烟 | **7/7** | `appimage-smoke-test.sh`：实测启动 |
| 插件/技能加载 | **70 加载 / 0 失败** | `test/direct-load-test.mjs`：直连调 `loadPlugins()` |
| 产物指纹 | 前后一致 | `verify-all.sh` 在测试前后各算一次 SHA256 |

**`verify-all.sh` 的指纹核对是必需的**：曾因并发跑「rpm 冒烟」与「重新构建」，
冒烟脚本收尾的 `pkill -f app.asar` 把还在运行的 electron-builder 一起杀了，
导致产出时间戳错乱。**这类竞争不报错，只会让「验过的包」≠「发布的包」。**
所以务必串行执行。

---

## 六、发布流程与网络应对

### 6.1 git 直连不可靠

实测 `git ls-remote` 成功率约 40%，`git push` 曾连续 8 次失败。

**推送策略**：

1. 先试 `git push`，**带重试循环**（最多 8 次，每次间隔 3 秒），成功过一次就够
2. 若多次失败，改用 **`gh api` + Git Data API**：
   ```bash
   python build-scripts/push-via-api.py "提交信息" <文件1> <文件2> ...
   ```
   它走 blob → tree → commit → 更新 ref，**一次提交多个文件**，
   且用 `base_tree` 只重建受影响文件，不必重传整个仓库。
   `gh api` 通道稳定（1 秒级），这是可靠的后备。

> 注意：用 API 推送后，本地 git 仓库与远端会不一致。
> 下次用 git 操作前先 `git fetch && git reset --hard origin/main`。

### 6.2 安装包走 Release

```bash
gh release create "v0.4.4-linux" 三个包 SHA256SUMS.txt \
  --repo prolet1966/QQ-Agent-for-Linux \
  --title "..." --notes-file RELEASE-NOTES.md --latest
```

实测上传 370 MB 用时约 41 秒。

### 6.3 本机网络状况（供参考）

- `git` 直连 github.com：**极不稳定**（断流/重置）
- `gh api`（走 api.github.com）：**稳定**
- WSL 内直连 GitHub release 资源：**断流**（90 秒零字节）
  → 所以 SnowLuma 安装包是**在 Windows 侧用 `gh release download` 下好**，
    再拷进 WSL。见 `install-snowluma.sh` 的说明。
- Clash 之类代理：本机当前**未运行**；即使运行，WSL 也连不进去
  （未开 Allow LAN），别指望这条路。

---

## 七、凭据与隐私（重要）

### 7.1 已经处理过的

推送前做过凭据扫描，发现并**清除**了硬编码在插件默认值里的真实信息：

| 文件 | 字段 | 处理 |
| --- | --- | --- |
| `plugins/kb-growth/plugin.json` | `settings.adminWriteQq` | 真实管理员 QQ 号 → `10001` |
| `plugins/kb-growth/lib/kb-config.js` | `admin.writeQq` | 同上 |
| `plugins/wake-policy/plugin.json` | `keywordsByUser` 示例 | 真实私人关键词 → 中性示例词 |
| `plugins/wake-policy/lib/wake-rules.js` | 同上（注释里的写法示例） | 同上 |
| `src/personas.js` | 角色卡文案 | 含私人词，已中性化 |
| `src/stickers.js` | 表情策略文案 | 同上 |

这些是**插件发布件里的默认值**，不清理就等于公开用户的 QQ 号与私人用语。
共替换 7 处标识、13 处私人词，涉及 8 个文件。

> ⚠️ **本交接文档不记录这些真实值本身。**
> 我原先在这里写了原值作为对照，那是错的 ——
> 文档会随仓库分发，把「被清理掉的敏感值」写进文档，等于换了个地方泄露。
> 只需知道它们已被清理；具体替换记录在本机源码树里（未发布）。

### 7.2 敏感值存在哪（重要设计）

**敏感值不在任何脚本里。** 它们在仓库外的一个私有文件：

```
~/.qq-agent-privacy-needles.txt        ← 每行一个值，# 开头为注释
可用环境变量 QQ_AGENT_PRIVACY_NEEDLES 指向别处
```

**为什么这样设计**（这是踩过坑之后改的）：

最初 `sanitize-staging.py` / `audit-doc-leaks.py` / `stage-for-github.py`
把真实 QQ 号与私人词**硬编码在脚本里**当搜索模式。三个问题：

1. **清理工具自己成了泄露源** —— 这些脚本要提交到公开仓库
2. **每次运行都要先替换自己** —— 实测替换数因此从 6 处涨到 14 处、再涨到 17 处，
   多出来的正是这几个脚本自身
3. **换个人接手没法用** —— 想清理自己的标识就得改脚本源码

现在脚本只保留**与身份无关的通用模式**（`sk-` / `SESSDATA` / JWT 等），
具体标识一律从私有清单读取。相关模块：`build-scripts/privacy_needles.py`。

清单文件不存在时脚本**不会报错**，但会明确提示"本轮不做替换/检查" ——
避免用户以为清理生效了其实没有（静默失效是最坏的结果）。

### 7.3 推送前的固定三步

```bash
python build-scripts/stage-for-github.py    # 挑选文件 + 凭据扫描
python build-scripts/sanitize-staging.py    # 按私有清单替换标识
python build-scripts/audit-doc-leaks.py     # 复查（含 staging 与两份 docs）
```

**三步都要跑**：`sanitize` 只处理源码，`audit` 覆盖文档 ——
文档同样会随仓库分发。`audit` 的退出码非零即表示仍有残留。

### 7.4 绝不能进仓库的

| 内容 | 位置 | 原因 |
| --- | --- | --- |
| `config.json` | `F:\qq-agent-data\` | **含明文 API Key 与 B 站 Cookie** |
| `messages.db` 等 | 同上 | 真实聊天记录（约 70 MB） |
| SnowLuma 日志 | 安装版 `snowluma/logs/` | 143 MB，含真实 QQ 号 |
| `snowluma/data/` | 安装版 | 含真实账号目录 |

`package.json` 的 `files` 里已有 `!data/**` 等排除规则，但**推送源码时仍要单独确认**——
上游源码树里就混着 `snowluma/`（含用户数据），`stage-for-github.py` 已把它整个排除。

### 7.5 运行时的凭据

发布出去的包**不含任何凭据**，用户自己填 API Key。
若要向他人交付**已配置好**的实例，那属于另一个性质（涉及你的 Key），需自行承担风险。

---

## 八、已知问题与技术债

### 8.1 WSLg 的 GPU 报错（非缺陷）

日志会出现：

```
ERROR:gpu_process_host.cc(976) GPU process launch failed: error_code=1002
FATAL:gpu_data_manager_impl_private.cc(423) GPU process isn't usable. Goodbye.
```

**四组对照实验的结论**：

| 启动参数 | GPU FATAL | 渲染崩溃 | 数据目录 |
| --- | --- | --- | --- |
| 默认 | 1 | 1 | ✅ 正常 |
| `--disable-gpu --disable-software-rasterizer` | **1（挡不住）** | 0 | ✅ 正常 |
| `--use-gl=swiftshader` | 1 | 1 | ✅ 正常 |
| `--in-process-gpu` | 0 | **30（更糟）** | ✅ 正常 |

显式传 `--disable-gpu` 也挡不住 → **不是 `main.js` 开关时机的问题**，
而是 WSLg 的 GPU 转发不可用。**所有用例数据目录都正常创建**，后端不受影响。

**待办**：在真实 Linux 桌面与纯服务器上各复核一次，确认该报错是否出现。

### 8.2 `.rpm` 未做严格验证

WSL 是 Ubuntu，无法 `rpm -i`（会污染 dpkg 系统）。当前用等价验证：
`rpm2cpio` 解包 + 与 `.deb` 逐条对照（44 条一致）+ 用解出的文件树真实启动。

**未验证的两项**：pre/post 脚本执行、rpm 依赖解析（依赖名已用 `rpm -qpR` 核对）。
**待办**：在 Fedora 系真机上 `dnf install` 一次。

### 8.3 部分插件依赖外部服务

`kb-growth`、`memory-growth` 依赖 MongoDB 或语义向量服务；
`voice-tts-skill` 依赖 GPT-SoVITS 服务。缺了会**自动降级并打日志**，不影响启动。
若使用者反馈"某功能不工作"，先看日志里的降级提示。

### 8.4 仓库两条历史线并存

仓库早期（2026-09-24）曾用于一个**已废弃的 Python 框架项目**，
留下 4 个提交与对应的文档。文档已全部移除，但提交历史仍在。

**待办（可选）**：若在意历史整洁，可考虑重建仓库或做一次 squash。
不做也没有功能影响。

### 8.5 插件/技能纳入未做逐个功能验证

17 插件 + 25 技能已确认**能加载**（70/0），静态扫描确认无未知 API 调用。
但**未逐个验证功能**——它们大多 `enabledByDefault: false`，
且部分依赖外部服务。用户启用后若遇问题，属首次真实使用。

---

## 九、怎么改与怎么测

### 9.1 改代码的流程

```powershell
# 1. 改 Windows 工作区的源码（权威存储）
#    F:\kmy\Documents\dpsk\harness\QQ-Agent-for-Linux\port\app\
# 2. 同步到 WSL 并构建
wsl -d Ubuntu -- bash /tmp/qs/pipeline.sh
# 3. 验证
wsl -d Ubuntu -- bash /tmp/qs/verify-all.sh
# 4. 收回产物
wsl -d Ubuntu -- bash /tmp/qs/collect-artifacts.sh
```

**不要直接改 WSL 里的源码** —— 它会被 `pipeline.sh` 从工作区覆盖。

### 9.2 改完必须过的检查

| 检查 | 命令 | 通过标准 |
| --- | --- | --- |
| 平台层单测 | `node test/platform-test.mjs` | 35/35 |
| 插件技能加载 | `node test/direct-load-test.mjs` | 失败 0 |
| 三套冒烟 | `verify-all.sh` | 25/18/7 全过 |
| 语法 | `node --check <文件>` | 无输出 |

### 9.3 加新插件/技能

参考 `build-scripts/apply-addons.sh`。**加之前先跑**
`check-plugin-api.mjs`（查是否调用了宿主未提供的 api）与
`check-skill-compat.mjs`（查工具 id 冲突）。

### 9.4 文档在哪

都在源码仓库 `docs/` 下，改代码时**同步更新**：

| 文件 | 何时更新 |
| --- | --- |
| `docs/linux-install.md` | 安装步骤、依赖、故障排查有变化时 |
| `docs/linux-delivery-report.md` | 重新构建发布后（含新的校验和） |
| `docs/linux-port-findings.md` | 发现新的硬编码点或平台问题时 |

---

## 十、待办清单

按优先级：

1. **在 Fedora 系真机验证 `.rpm`** —— 补齐唯一未严格验证的交付物
2. **在真实 Linux 桌面复核 GPU 报错** —— 确认 8.1 的结论在非 WSL 环境是否成立
3. **验证用户实际安装体验** —— 找个干净的 Linux 环境，从零走一遍完整流程
   （装包 → 装 QQ → ptrace → 扫码 → 配 API → 收到消息），
   这一步能暴露文档与你实际环境之间的差距
4. **考虑给仓库加 CI** —— 至少在 push 时跑平台层单测，防止改动破坏核心逻辑
5. **可选：整理仓库历史**（见 8.4）

---

## 十一、一句话总结

移植的**全部实质改动集中在 5 个文件**（`src/platform.js` 新增，`src/config.js`、
`src/app.js`、`src/routes.js`、`electron/main.js` 修改）+ `package.json` 的打包配置。
其余是上游原样代码与纳入的扩展。

**最需要小心的三处**：`asarUnpack` 不能删（协议端起不来）、
进程匹配不能改成按名杀（会误杀用户程序）、
推送前必须跑凭据清理（源码树里混着真实数据）。

有任何疑问，先读源码里那些「踩过坑」的注释——它们比本文档更具体。
